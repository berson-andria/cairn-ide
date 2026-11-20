use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, RwLock,
    },
    thread,
    time::Duration,
};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::codemap::service::watcher_ignore;

const BATCH_WINDOW: Duration = Duration::from_millis(100);
const MAX_PATHS: usize = 2000;
const CAIRN_HIDDEN_CHILDREN: [&str; 2] = ["cache", "runs"];

struct BatchAccumulator<T> {
    started: std::time::Instant,
    events: Vec<T>,
}

impl<T> BatchAccumulator<T> {
    fn new(started: std::time::Instant, first: T) -> Self {
        Self {
            started,
            events: vec![first],
        }
    }

    fn push(&mut self, at: std::time::Instant, event: T) -> Option<Vec<T>> {
        if at.duration_since(self.started) >= BATCH_WINDOW {
            let completed = std::mem::take(&mut self.events);
            self.started = at;
            self.events.push(event);
            Some(completed)
        } else {
            self.events.push(event);
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Create,
    Modify,
    Remove,
    Rename,
    Other,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBatch {
    pub events: Vec<BatchEvent>,
    pub overflow: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEvent {
    pub kind: ChangeKind,
    pub paths: Vec<String>,
}

struct ActiveWatch {
    stop: Arc<AtomicBool>,
}
type WatchListener = Arc<dyn Fn(PathBuf, Vec<PathBuf>) + Send + Sync>;

#[derive(Default)]
pub struct WorkspaceWatcher {
    active: Mutex<Option<ActiveWatch>>,
    listeners: RwLock<Vec<WatchListener>>,
}

impl WorkspaceWatcher {
    pub fn subscribe(&self, listener: impl Fn(PathBuf, Vec<PathBuf>) + Send + Sync + 'static) {
        if let Ok(mut listeners) = self.listeners.write() {
            listeners.push(Arc::new(listener));
        }
    }
    pub fn stop(&self) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(watch) = active.take() {
                watch.stop.store(true, Ordering::Release);
            }
        }
    }

    pub fn start(&self, root: PathBuf, app: AppHandle) {
        let stop = Arc::new(AtomicBool::new(false));
        self.replace_active(stop.clone());
        let listeners = self.listeners.read().map(|l| l.clone()).unwrap_or_default();
        thread::spawn(move || run_watch(root, app, stop, listeners));
    }

    fn replace_active(&self, stop: Arc<AtomicBool>) {
        self.stop();
        if let Ok(mut active) = self.active.lock() {
            *active = Some(ActiveWatch { stop });
        }
    }
}

fn run_watch(root: PathBuf, app: AppHandle, stop: Arc<AtomicBool>, listeners: Vec<WatchListener>) {
    let root = match root.canonicalize() {
        Ok(root) if root.is_dir() => PathBuf::from(super::project::strip_windows_verbatim_prefix(
            &root.to_string_lossy(),
        )),
        Ok(_) => {
            emit_error(&app, "workspace watcher path is not a directory".into());
            return;
        }
        Err(error) => {
            emit_error(&app, format!("invalid workspace watcher path: {error}"));
            return;
        }
    };
    let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();
    let callback_root = root.clone();
    let callback_ignore = Arc::new(watcher_ignore(&root));
    let mut watcher =
        match notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
            let filtered = event.map(|mut event| {
                event.paths.retain(|path| {
                    path_allowed(&callback_root, path, &callback_ignore)
                        || is_cairn_data_path(&callback_root, path)
                });
                event
            });
            let _ = tx.send(filtered);
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                emit_error(&app, error.to_string());
                return;
            }
        };
    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        emit_error(&app, error.to_string());
        return;
    }
    while !stop.load(Ordering::Acquire) {
        let first = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(event)) => event,
            Ok(Err(error)) => {
                emit_error(&app, error.to_string());
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut batch = BatchAccumulator::new(std::time::Instant::now(), first);
        while let Some(remaining) =
            (batch.started + BATCH_WINDOW).checked_duration_since(std::time::Instant::now())
        {
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(Ok(event)) => {
                    if let Some(events) = batch.push(std::time::Instant::now(), event) {
                        emit_batch(&app, &root, &events, &listeners);
                    }
                }
                Ok(Err(error)) => emit_error(&app, error.to_string()),
                Err(_) => break,
            }
        }
        emit_batch(&app, &root, &batch.events, &listeners);
    }
}

fn emit_batch(app: &AppHandle, root: &Path, events: &[Event], listeners: &[WatchListener]) {
    let internal = events
        .iter()
        .flat_map(|event| event.paths.iter())
        .filter(|path| is_cairn_data_path(root, path))
        .cloned()
        .collect::<Vec<_>>();
    if !internal.is_empty() {
        for listener in listeners {
            listener(root.to_path_buf(), internal.clone());
        }
    }
    let batch = build_batch(root, events);
    if !batch.events.is_empty() || batch.overflow {
        let _ = app.emit("fs:changed", batch);
    }
}

fn is_cairn_data_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let parts = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != ".cairn" || !matches!(parts[1].as_ref(), "tasks" | "notes") {
        return false;
    }
    let name = parts[2].as_ref();
    !name.starts_with('.')
        && !name.ends_with(".tmp")
        && Path::new(name).extension().is_some_and(|e| e == "json")
}

fn emit_error(app: &AppHandle, message: String) {
    tauri_plugin_log::log::error!("Workspace watcher error: {message}");
    let _ = app.emit("fs:watch-error", serde_json::json!({"message": message}));
}

fn event_kind(kind: &EventKind) -> ChangeKind {
    use notify::event::{ModifyKind, RenameMode};
    match kind {
        EventKind::Create(_) => ChangeKind::Create,
        EventKind::Remove(_) => ChangeKind::Remove,
        EventKind::Modify(ModifyKind::Name(
            RenameMode::Both | RenameMode::Any | RenameMode::From | RenameMode::To,
        )) => ChangeKind::Rename,
        EventKind::Modify(_) => ChangeKind::Modify,
        _ => ChangeKind::Other,
    }
}

fn git_path_needed(relative: &Path) -> bool {
    let mut parts = relative.components();
    if parts.next().is_none_or(|part| part.as_os_str() != ".git") {
        return false;
    }
    let tail = parts
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    matches!(tail.as_slice(), [name] if name == "HEAD" || name == "index" || name == "packed-refs")
        || matches!(tail.as_slice(), [dir, ..] if dir == "refs")
}

fn path_allowed(root: &Path, path: &Path, ignore: &ignore::gitignore::Gitignore) -> bool {
    explorer_passes(root, path, ignore)
}

pub fn tree_hidden(path: &Path) -> bool {
    let parts = path
        .components()
        .map(|component| component.as_os_str())
        .collect::<Vec<_>>();
    parts.iter().enumerate().any(|(index, part)| {
        *part == ".git"
            || (*part == ".cairn"
                && parts.get(index + 1).is_some_and(|child| {
                    CAIRN_HIDDEN_CHILDREN
                        .iter()
                        .any(|hidden| child.to_string_lossy().eq_ignore_ascii_case(hidden))
                }))
    })
}

/// Explorer events include the ignored or hidden entry itself so the tree can represent it,
/// while suppressing its contents. The codemap keeps using the strict `is_ignored` rule.
pub fn explorer_passes(root: &Path, path: &Path, ignore: &ignore::gitignore::Gitignore) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if git_path_needed(relative) {
        return true;
    }
    if tree_hidden(relative) {
        return false;
    }
    let parts = relative
        .components()
        .map(|c| c.as_os_str())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return false;
    }
    let mut prefix = PathBuf::new();
    for (index, part) in parts.iter().enumerate() {
        if *part == ".cairn" {
            return true;
        }
        prefix.push(part);
        let first_ignored = part.to_string_lossy().starts_with('.')
            || ignore
                .matched_path_or_any_parents(&prefix, true)
                .is_ignore();
        if first_ignored {
            return index + 1 == parts.len();
        }
    }
    true
}

fn build_batch(root: &Path, events: &[Event]) -> WatchBatch {
    let ignore = watcher_ignore(root);
    let mut grouped: BTreeMap<ChangeKind, Vec<String>> = BTreeMap::new();
    let mut seen: HashSet<(ChangeKind, String)> = HashSet::new();
    for event in events {
        let kind = event_kind(&event.kind);
        for path in &event.paths {
            if !path_allowed(root, path, &ignore) {
                continue;
            }
            let normalized = super::project::strip_windows_verbatim_prefix(&path.to_string_lossy())
                .replace('/', "\\");
            if seen.insert((kind, normalized.clone())) {
                grouped.entry(kind).or_default().push(normalized);
            }
        }
    }
    let count: usize = grouped.values().map(Vec::len).sum();
    if count > MAX_PATHS {
        return WatchBatch {
            events: Vec::new(),
            overflow: true,
        };
    }
    WatchBatch {
        events: grouped
            .into_iter()
            .map(|(kind, paths)| BatchEvent { kind, paths })
            .collect(),
        overflow: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    use tempfile::tempdir;

    fn event(kind: EventKind, paths: &[PathBuf]) -> Event {
        Event {
            kind,
            paths: paths.to_vec(),
            attrs: Default::default(),
        }
    }

    #[test]
    fn tree_hidden_hides_git_and_private_cairn_children_only() {
        for path in [
            ".git",
            "x/.git/y",
            ".cairn/cache",
            ".cairn/Cache/a",
            ".cairn/runs/id/trace.jsonl",
        ] {
            assert!(tree_hidden(Path::new(path)), "{path}");
        }
        for path in [
            ".cairn",
            ".cairn/settings.json",
            ".cairn/tasks/a.json",
            ".cairn/workflows",
            ".cairn/workflows/default.py",
            ".cairnx/cache",
            "src/cache",
            "src/runs",
        ] {
            assert!(!tree_hidden(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn filters_ignored_paths_and_keeps_git_status_inputs() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join(".gitignore"),
            "node_modules/\ntarget/\ndist/\n",
        )
        .unwrap();
        let ignore = watcher_ignore(root.path());
        for p in [
            "node_modules/x",
            "target/x",
            "dist/x",
            ".git/objects/x",
            ".venv/lib/python",
            "venv/lib/python",
            "__pycache__/x.pyc",
            ".mypy_cache/a",
            ".pytest_cache/a",
            ".ruff_cache/a",
        ] {
            assert!(
                !path_allowed(root.path(), &root.path().join(p), &ignore),
                "{p}"
            );
        }
        for p in [
            ".cairn/tasks/a.json",
            ".cairn/tasks/.a.json",
            ".cairn/tasks/a.tmp",
            ".cairn/tasks/a.txt",
        ] {
            assert!(
                is_cairn_data_path(root.path(), &root.path().join(p))
                    == (p == ".cairn/tasks/a.json"),
                "{p}"
            );
        }
        for p in [
            "src/main.rs",
            ".git/HEAD",
            ".git/index",
            ".git/refs/heads/main",
            ".git/packed-refs",
        ] {
            assert!(
                path_allowed(root.path(), &root.path().join(p), &ignore),
                "{p}"
            );
        }
    }

    #[test]
    fn explorer_filter_shows_ignored_entry_and_hides_its_contents() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join(".gitignore"),
            "venv/\nnode_modules/\ntarget/\n",
        )
        .unwrap();
        let ignore = watcher_ignore(root.path());
        let cases = [
            (".venv", true),
            (".venv/lib/x.py", false),
            ("venv", true),
            ("venv/Lib/x", false),
            ("node_modules", true),
            ("node_modules/a/b", false),
            (".env", true),
            (".git", false),
            (".git/objects/x", false),
            (".git/HEAD", true),
            (".cairn", true),
            (".cairn/workflows", true),
            (".cairn/workflows/x.py", true),
            (".cairn/tasks/a.json", true),
            (".cairn/cache/codemap.json", false),
            (".cairn/runs/id/trace.jsonl", false),
            (".cairn/runs/id/run.log", false),
            ("src/main.rs", true),
            ("target/debug/x", false),
        ];
        for (relative, expected) in cases {
            assert_eq!(
                explorer_passes(root.path(), &root.path().join(relative), &ignore),
                expected,
                "{relative}"
            );
        }
        for relative in [
            ".git/HEAD",
            ".git/index",
            ".git/packed-refs",
            ".git/refs/heads/main",
        ] {
            assert!(
                explorer_passes(root.path(), &root.path().join(relative), &ignore),
                "{relative}"
            );
        }

        let nested_root = root.path().join(".git/.cairn/project");
        fs::create_dir_all(&nested_root).unwrap();
        let nested_ignore = watcher_ignore(&nested_root);
        assert!(explorer_passes(
            &nested_root,
            &nested_root.join("src/main.rs"),
            &nested_ignore
        ));
    }

    #[test]
    fn batches_deduplicate_and_overflow_at_path_limit() {
        let root = tempdir().unwrap();
        let one = root.path().join("a.rs");
        let batch = build_batch(
            root.path(),
            &[event(
                EventKind::Create(notify::event::CreateKind::File),
                &[one.clone(), one.clone()],
            )],
        );
        assert_eq!(
            serde_json::to_string(&batch).unwrap(),
            format!(
                r#"{{"events":[{{"kind":"create","paths":[{}]}}],"overflow":false}}"#,
                serde_json::to_string(&one.to_string_lossy()).unwrap()
            )
        );
        let paths = (0..=MAX_PATHS)
            .map(|i| root.path().join(format!("f{i}")))
            .collect::<Vec<_>>();
        let overflow = build_batch(
            root.path(),
            &[event(
                EventKind::Create(notify::event::CreateKind::File),
                &paths,
            )],
        );
        assert_eq!(
            serde_json::to_string(&overflow).unwrap(),
            r#"{"events":[],"overflow":true}"#
        );
    }

    #[test]
    fn distinct_event_kinds_stay_separate_and_paths_dedupe_per_kind() {
        let root = tempdir().unwrap();
        let file = root.path().join("src.rs");
        let batch = build_batch(
            root.path(),
            &[
                event(
                    EventKind::Create(notify::event::CreateKind::File),
                    &[file.clone()],
                ),
                event(
                    EventKind::Modify(notify::event::ModifyKind::Data(
                        notify::event::DataChange::Any,
                    )),
                    &[file.clone()],
                ),
            ],
        );
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].kind, ChangeKind::Create);
        assert_eq!(batch.events[1].kind, ChangeKind::Modify);
    }

    #[test]
    fn replacing_and_stopping_drops_the_previous_watch_flag() {
        let watcher = WorkspaceWatcher::default();
        let old = Arc::new(AtomicBool::new(false));
        let new = Arc::new(AtomicBool::new(false));
        watcher.replace_active(old.clone());
        watcher.replace_active(new.clone());
        assert!(old.load(Ordering::Acquire));
        assert!(!new.load(Ordering::Acquire));
        watcher.stop();
        assert!(new.load(Ordering::Acquire));
        assert!(watcher.active.lock().unwrap().is_none());
    }

    #[test]
    fn long_event_stream_is_split_at_the_batch_window() {
        let start = std::time::Instant::now();
        let mut batch = BatchAccumulator::new(start, 1);
        assert_eq!(batch.push(start + Duration::from_millis(80), 2), None);
        assert_eq!(
            batch.push(start + Duration::from_millis(120), 3),
            Some(vec![1, 2])
        );
        assert_eq!(batch.events, vec![3]);
    }
}
