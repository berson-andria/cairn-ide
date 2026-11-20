use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const FILE_NAME: &str = "last-session.json";
const LOCK_NAME: &str = "last-session.lock";
const MAX_PROJECTS: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub path: String,
    pub name: String,
    pub last_opened_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: u64,
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub schema_version: u32,
    pub last_project: Option<String>,
    pub projects: Vec<ProjectEntry>,
}

impl Default for SessionHistory {
    fn default() -> Self {
        Self {
            schema_version: 1,
            last_project: None,
            projects: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    pub last_project: Option<String>,
    pub projects: Vec<HistoryProject>,
}

pub fn insert_project(history: &mut SessionHistory, entry: ProjectEntry) {
    history
        .projects
        .retain(|item| !same_path(&item.path, &entry.path));
    history.projects.insert(0, entry.clone());
    history.projects.truncate(MAX_PROJECTS);
    history.last_project = Some(entry.path);
}

pub fn merge_histories(left: &SessionHistory, right: &SessionHistory) -> SessionHistory {
    let mut newest_by_path: HashMap<String, ProjectEntry> = HashMap::new();
    for entry in left.projects.iter().chain(&right.projects) {
        let key = path_key(&entry.path);
        match newest_by_path.get(&key) {
            Some(existing) if existing.last_opened_at > entry.last_opened_at => {}
            _ => {
                newest_by_path.insert(key, entry.clone());
            }
        }
    }

    let mut merged = SessionHistory {
        schema_version: 1,
        last_project: None,
        projects: newest_by_path.into_values().collect(),
    };
    merged
        .projects
        .sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    merged.projects.truncate(MAX_PROJECTS);

    let left_time = last_project_time(left);
    let right_time = last_project_time(right);
    merged.last_project = if right_time >= left_time {
        right.last_project.clone()
    } else {
        left.last_project.clone()
    };
    merged
}

pub fn read(data_dir: &Path) -> SessionHistory {
    let path = data_dir.join(FILE_NAME);
    let Ok(mut file) = File::open(path) else {
        return SessionHistory::default();
    };
    let mut contents = String::new();
    if file.read_to_string(&mut contents).is_err() {
        return SessionHistory::default();
    }
    let Ok(history) = serde_json::from_str::<SessionHistory>(&contents) else {
        return SessionHistory::default();
    };
    if history.schema_version != 1 {
        return SessionHistory::default();
    }
    history
}

pub fn snapshot(data_dir: &Path) -> HistorySnapshot {
    let history = read(data_dir);
    HistorySnapshot {
        last_project: history.last_project,
        projects: history
            .projects
            .into_iter()
            .map(|entry| {
                let missing = !Path::new(&entry.path).is_dir();
                HistoryProject {
                    path: entry.path,
                    name: entry.name,
                    last_opened_at: entry.last_opened_at,
                    missing,
                }
            })
            .collect(),
    }
}

pub fn record_open(data_dir: &Path, canonical_path: &Path) -> io::Result<()> {
    let path = canonical_path.to_string_lossy().into_owned();
    let name = canonical_path
        .file_name()
        .unwrap_or_else(|| canonical_path.as_os_str())
        .to_string_lossy()
        .into_owned();
    update(data_dir, |history| {
        let entry = ProjectEntry {
            path,
            name,
            last_opened_at: now_millis(),
        };
        let requested = SessionHistory {
            schema_version: 1,
            last_project: Some(entry.path.clone()),
            projects: vec![entry.clone()],
        };
        let mut merged = merge_histories(history, &requested);
        insert_project(&mut merged, entry);
        *history = merged;
    })
}

pub fn clear_last_project(data_dir: &Path, canonical_path: &Path) -> io::Result<()> {
    update(data_dir, |history| {
        if history
            .last_project
            .as_deref()
            .is_some_and(|path| same_path(path, &canonical_path.to_string_lossy()))
        {
            history.last_project = None;
        }
    })
}

pub fn remove_project(data_dir: &Path, path: &str) -> io::Result<()> {
    update(data_dir, |history| {
        history
            .projects
            .retain(|entry| !same_path(&entry.path, path));
    })
}

pub fn clear_projects(data_dir: &Path) -> io::Result<()> {
    update(data_dir, |history| history.projects.clear())
}

fn update(data_dir: &Path, mutate: impl FnOnce(&mut SessionHistory)) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let _guard = HistoryLock::acquire(data_dir)?;
    let mut history = read(data_dir);
    mutate(&mut history);
    write_atomic(data_dir, &history)
}

fn write_atomic(data_dir: &Path, history: &SessionHistory) -> io::Result<()> {
    let destination = data_dir.join(FILE_NAME);
    let temporary = data_dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let contents = serde_json::to_vec_pretty(history).map_err(io::Error::other)?;
    if let Err(error) = fs::write(&temporary, contents) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    match replace_file(&temporary, &destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(error)
        }
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct HistoryLock {
    path: PathBuf,
}

impl HistoryLock {
    fn acquire(data_dir: &Path) -> io::Result<Self> {
        let path = data_dir.join(LOCK_NAME);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    if let Err(error) = writeln!(file, "{}", std::process::id()) {
                        drop(file);
                        let _ = fs::remove_file(&path);
                        return Err(error);
                    }
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let owner = fs::read_to_string(&path)
                        .ok()
                        .and_then(|contents| contents.trim().parse::<u32>().ok());
                    if owner.is_some_and(|pid| !process_is_alive(pid)) {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "Timed out waiting for the project history lock",
                        ));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for HistoryLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let alive =
            GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        alive
    }
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    true
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn last_project_time(history: &SessionHistory) -> u64 {
    history
        .last_project
        .as_deref()
        .and_then(|path| {
            history
                .projects
                .iter()
                .find(|entry| same_path(&entry.path, path))
        })
        .map_or(0, |entry| entry.last_opened_at)
}

fn same_path(left: &str, right: &str) -> bool {
    path_key(left) == path_key(right)
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn entry(path: &str, at: u64) -> ProjectEntry {
        ProjectEntry {
            path: path.into(),
            name: path.rsplit(['/', '\\']).next().unwrap_or(path).into(),
            last_opened_at: at,
        }
    }

    #[test]
    fn inserting_deduplicates_reorders_and_caps_history() {
        let mut history = SessionHistory::default();
        for index in 0..MAX_PROJECTS {
            insert_project(&mut history, entry(&format!("p{index}"), index as u64));
        }
        insert_project(&mut history, entry("p4", 100));
        insert_project(&mut history, entry("new", 101));
        assert_eq!(history.projects.len(), MAX_PROJECTS);
        assert_eq!(history.projects[0].path, "new");
        assert_eq!(history.projects[1].path, "p4");
        assert_eq!(
            history
                .projects
                .iter()
                .filter(|item| item.path == "p4")
                .count(),
            1
        );
    }

    #[test]
    fn merging_stale_histories_keeps_newest_versions_and_projects() {
        let left = SessionHistory {
            schema_version: 1,
            last_project: Some("a".into()),
            projects: vec![entry("a", 1), entry("shared", 2)],
        };
        let right = SessionHistory {
            schema_version: 1,
            last_project: Some("b".into()),
            projects: vec![entry("b", 4), entry("shared", 3)],
        };
        let merged = merge_histories(&left, &right);
        assert_eq!(merged.projects.len(), 3);
        assert_eq!(merged.projects[0].path, "b");
        assert_eq!(merged.projects[1].path, "shared");
        assert_eq!(merged.projects[1].last_opened_at, 3);
        assert_eq!(merged.last_project.as_deref(), Some("b"));
    }

    #[test]
    fn corrupt_or_unknown_history_is_empty() {
        let directory = tempdir().unwrap();
        let file = directory.path().join(FILE_NAME);
        fs::write(&file, "{").unwrap();
        assert_eq!(read(directory.path()), SessionHistory::default());
        fs::write(
            &file,
            r#"{"schemaVersion":2,"lastProject":"old","projects":[]}"#,
        )
        .unwrap();
        assert_eq!(read(directory.path()), SessionHistory::default());
    }

    #[test]
    fn snapshot_marks_missing_projects_without_persisting_the_flag() {
        let directory = tempdir().unwrap();
        let existing = directory.path().join("exists");
        fs::create_dir(&existing).unwrap();
        let mut history = SessionHistory::default();
        history.projects = vec![
            entry(&existing.to_string_lossy(), 2),
            entry(&directory.path().join("gone").to_string_lossy(), 1),
        ];
        write_atomic(directory.path(), &history).unwrap();
        let result = snapshot(directory.path());
        assert!(!result.projects[0].missing);
        assert!(result.projects[1].missing);
        assert_eq!(
            serde_json::to_value(&result).unwrap()["projects"][1]["missing"],
            true
        );
        assert!(!fs::read_to_string(directory.path().join(FILE_NAME))
            .unwrap()
            .contains("\"missing\""));
    }

    #[test]
    fn concurrent_opens_merge_both_projects_into_history() {
        let directory = tempdir().unwrap();
        let project_a = tempdir().unwrap();
        let project_b = tempdir().unwrap();
        let data_dir = directory.path().to_path_buf();
        let path_a = project_a.path().to_path_buf();
        let path_b = project_b.path().to_path_buf();

        let first = std::thread::spawn(move || record_open(&data_dir, &path_a).unwrap());
        let data_dir = directory.path().to_path_buf();
        let second = std::thread::spawn(move || record_open(&data_dir, &path_b).unwrap());
        first.join().unwrap();
        second.join().unwrap();

        let history = read(directory.path());
        assert_eq!(history.projects.len(), 2);
        assert!(history
            .projects
            .iter()
            .any(|entry| entry.path == project_a.path().to_string_lossy().to_string()));
        assert!(history
            .projects
            .iter()
            .any(|entry| entry.path == project_b.path().to_string_lossy().to_string()));
    }

    #[test]
    fn clearing_last_project_is_conditional_and_keeps_history() {
        let directory = tempdir().unwrap();
        let project = tempdir().unwrap();
        let other = tempdir().unwrap();
        record_open(directory.path(), project.path()).unwrap();

        clear_last_project(directory.path(), other.path()).unwrap();
        assert_eq!(
            read(directory.path()).last_project.as_deref(),
            Some(project.path().to_string_lossy().as_ref())
        );
        clear_last_project(directory.path(), project.path()).unwrap();
        let history = read(directory.path());
        assert_eq!(history.last_project, None);
        assert_eq!(history.projects.len(), 1);
    }
}
