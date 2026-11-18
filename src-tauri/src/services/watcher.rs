use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::codemap::service::{is_ignored, watcher_ignore};

const BATCH_WINDOW: Duration = Duration::from_millis(100);
const MAX_PATHS: usize = 2000;

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

#[derive(Default)]
pub struct WorkspaceWatcher {
    active: Mutex<Option<ActiveWatch>>,
}

impl WorkspaceWatcher {
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
        thread::spawn(move || run_watch(root, app, stop));
    }

    fn replace_active(&self, stop: Arc<AtomicBool>) {
        self.stop();
        if let Ok(mut active) = self.active.lock() {
            *active = Some(ActiveWatch { stop });
        }
    }
}

fn run_watch(root: PathBuf, app: AppHandle, stop: Arc<AtomicBool>) {
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
                event
                    .paths
                    .retain(|path| path_allowed(&callback_root, path, &callback_ignore));
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
        while let Some(remaining) = (batch.started + BATCH_WINDOW)
            .checked_duration_since(std::time::Instant::now())
        {
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(Ok(event)) => {
                    if let Some(events) = batch.push(std::time::Instant::now(), event) {
                        emit_batch(&app, &root, &events);
                    }
                }
                Ok(Err(error)) => emit_error(&app, error.to_string()),
                Err(_) => break,
            }
        }
        emit_batch(&app, &root, &batch.events);
    }
}

fn emit_batch(app: &AppHandle, root: &Path, events: &[Event]) {
    let batch = build_batch(root, events);
    if !batch.events.is_empty() || batch.overflow {
        let _ = app.emit("fs:changed", batch);
    }
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
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if git_path_needed(relative) {
        return true;
    }
    !is_ignored(ignore, relative, path.is_dir())
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
    fn filters_ignored_paths_and_keeps_git_status_inputs() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join(".gitignore"),
            "node_modules/\ntarget/\ndist/\n",
        )
        .unwrap();
        let ignore = watcher_ignore(root.path());
        for p in ["node_modules/x", "target/x", "dist/x", ".git/objects/x"] {
            assert!(
                !path_allowed(root.path(), &root.path().join(p), &ignore),
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
