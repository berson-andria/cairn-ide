use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fmt, fs,
    fs::OpenOptions,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub fn ensure_cairn_dir(root: impl AsRef<Path>) -> io::Result<()> {
    let directory = root.as_ref().join(".cairn");
    fs::create_dir_all(&directory)?;
    let ignore = directory.join(".gitignore");
    match OpenOptions::new().write(true).create_new(true).open(ignore) {
        Ok(mut file) => file.write_all(b"cache/\nruns/\ntasks/\nnotes/\n"),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum StorageErrorCode {
    NotFound,
    StaleRev,
    Validation,
    Io,
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageError {
    pub code: StorageErrorCode,
    pub message: String,
}

impl StorageError {
    fn new(code: StorageErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {}",
            serde_json::to_string(&self.code).unwrap_or_default(),
            self.message
        )
    }
}
impl std::error::Error for StorageError {}

pub trait RepositoryRecord: Serialize + DeserializeOwned + Clone {
    fn id(&self) -> &str;
    fn set_id(&mut self, id: String);
    fn rev(&self) -> u64;
    fn set_rev(&mut self, rev: u64);
}

impl RepositoryRecord for crate::types::task::TaskItem {
    fn id(&self) -> &str {
        &self.id
    }
    fn set_id(&mut self, id: String) {
        self.id = id;
    }
    fn rev(&self) -> u64 {
        self.rev
    }
    fn set_rev(&mut self, rev: u64) {
        self.rev = rev;
    }
}
impl RepositoryRecord for crate::types::note::NoteItem {
    fn id(&self) -> &str {
        &self.id
    }
    fn set_id(&mut self, id: String) {
        self.id = id;
    }
    fn rev(&self) -> u64 {
        self.rev
    }
    fn set_rev(&mut self, rev: u64) {
        self.rev = rev;
    }
}
impl RepositoryRecord for crate::types::proposal::Proposal {
    fn id(&self) -> &str {
        &self.id
    }
    fn set_id(&mut self, id: String) {
        self.id = id;
    }
    fn rev(&self) -> u64 {
        self.rev
    }
    fn set_rev(&mut self, rev: u64) {
        self.rev = rev;
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListReport<T> {
    pub records: Vec<T>,
    pub errors: Vec<StorageError>,
}

pub trait Repository<T: RepositoryRecord> {
    fn list(&self) -> Result<ListReport<T>, StorageError>;
    fn get(&self, id: &str) -> Result<T, StorageError>;
    fn create(&self, record: T) -> Result<T, StorageError>;
    fn update(&self, record: T, expected_rev: u64) -> Result<T, StorageError>;
    fn delete(&self, id: &str) -> Result<(), StorageError>;
}

pub struct FileRepository<T> {
    directory: PathBuf,
    // The service layer must keep ONE FileRepository instance per directory; separate instances
    // have separate locks and therefore cannot serialize each other's mutations.
    lock: Mutex<()>,
    _record: std::marker::PhantomData<T>,
}

impl<T> FileRepository<T> {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            lock: Mutex::new(()),
            _record: std::marker::PhantomData,
        }
    }
    pub fn for_tasks(root: impl AsRef<Path>) -> Self {
        Self::new(root.as_ref().join(".cairn/tasks"))
    }
    pub fn for_notes(root: impl AsRef<Path>) -> Self {
        Self::new(root.as_ref().join(".cairn/notes"))
    }
    pub fn for_proposals(root: impl AsRef<Path>) -> Self {
        Self::new(root.as_ref().join(".cairn/runs/proposals"))
    }
    fn path(&self, id: &str) -> Result<PathBuf, StorageError> {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(StorageError::new(
                StorageErrorCode::Validation,
                "ID must contain 1 to 64 ASCII letters, digits, hyphens, or underscores",
            ));
        }
        Ok(self.directory.join(format!("{id}.json")))
    }
    pub(crate) fn path_for_reload(&self, id: &str) -> Result<PathBuf, StorageError> {
        self.path(id)
    }
}

impl<T: RepositoryRecord> FileRepository<T> {
    fn own_key(&self, id: &str) -> String {
        self.directory
            .join(format!("{id}.json"))
            .to_string_lossy()
            .to_string()
    }
    pub fn is_own_write(&self, id: &str, bytes: Option<&[u8]>) -> bool {
        OWN_WRITES
            .get_or_init(Default::default)
            .lock()
            .ok()
            .and_then(|writes| writes.get(&self.own_key(id)).copied())
            == Some(bytes.map(blake3::hash).map(|hash| *hash.as_bytes()))
    }
    pub fn clear_own_write(&self, id: &str) {
        if let Ok(mut writes) = OWN_WRITES.get_or_init(Default::default).lock() {
            writes.remove(&self.own_key(id));
        }
    }

    fn write(&self, record: &T) -> Result<(), StorageError> {
        let cairn_directory = if self
            .directory
            .file_name()
            .is_some_and(|name| name == "tasks" || name == "notes")
            && self
                .directory
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == ".cairn")
        {
            self.directory.parent()
        } else if self
            .directory
            .file_name()
            .is_some_and(|name| name == "proposals")
            && self
                .directory
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "runs")
            && self
                .directory
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .is_some_and(|name| name == ".cairn")
        {
            self.directory.parent().and_then(Path::parent)
        } else {
            None
        };
        if let Some(cairn_directory) = cairn_directory {
            let root = cairn_directory
                .parent()
                .expect(".cairn directory has a project root");
            ensure_cairn_dir(root)
                .map_err(|e| StorageError::new(StorageErrorCode::Io, e.to_string()))?;
        }
        fs::create_dir_all(&self.directory)
            .map_err(|e| StorageError::new(StorageErrorCode::Io, e.to_string()))?;
        let path = self.path(record.id())?;
        let temp = self
            .directory
            .join(format!(".{}.{}.tmp", record.id(), uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|e| StorageError::new(StorageErrorCode::Validation, e.to_string()))?;
        OWN_WRITES
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| StorageError::new(StorageErrorCode::Io, e.to_string()))?
            .insert(
                self.own_key(record.id()),
                Some(*blake3::hash(&bytes).as_bytes()),
            );
        let result = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temp, &path)
        })();
        if let Err(error) = result {
            if let Ok(mut writes) = OWN_WRITES.get_or_init(Default::default).lock() {
                writes.remove(&self.own_key(record.id()));
            }
            let _ = fs::remove_file(&temp);
            return Err(StorageError::new(StorageErrorCode::Io, error.to_string()));
        }
        Ok(())
    }
}

impl<T: RepositoryRecord> Repository<T> for FileRepository<T> {
    fn list(&self) -> Result<ListReport<T>, StorageError> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ListReport {
                    records: vec![],
                    errors: vec![],
                })
            }
            Err(e) => return Err(StorageError::new(StorageErrorCode::Io, e.to_string())),
        };
        let mut report = ListReport {
            records: vec![],
            errors: vec![],
        };
        for entry in entries {
            let entry = match entry {
                Ok(v) => v,
                Err(e) => {
                    report
                        .errors
                        .push(StorageError::new(StorageErrorCode::Io, e.to_string()));
                    continue;
                }
            };
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("<unknown>")
                .to_string();
            let parsed = fs::read(&path)
                .map_err(|e| StorageError::new(StorageErrorCode::Io, e.to_string()))
                .and_then(|b| {
                    serde_json::from_slice::<T>(&b)
                        .map_err(|e| StorageError::new(StorageErrorCode::Corrupt, e.to_string()))
                })
                .and_then(|record| {
                    let stem = path.file_stem().and_then(|stem| stem.to_str());
                    if stem == Some(record.id()) {
                        Ok(record)
                    } else {
                        Err(StorageError::new(
                            StorageErrorCode::Corrupt,
                            format!("record id does not match file name (id: {})", record.id()),
                        ))
                    }
                })
                .map_err(|mut error| {
                    error.message = format!("{filename}: {}", error.message);
                    error
                });
            match parsed {
                Ok(record) => report.records.push(record),
                Err(error) => report.errors.push(error),
            }
        }
        Ok(report)
    }
    fn get(&self, id: &str) -> Result<T, StorageError> {
        let path = self.path(id)?;
        let bytes = fs::read(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                StorageError::new(StorageErrorCode::NotFound, format!("Record {id} not found"))
            } else {
                StorageError::new(StorageErrorCode::Io, e.to_string())
            }
        })?;
        serde_json::from_slice(&bytes)
            .map_err(|e| StorageError::new(StorageErrorCode::Corrupt, e.to_string()))
    }
    fn create(&self, mut record: T) -> Result<T, StorageError> {
        let _guard = self.lock.lock().map_err(|e| {
            StorageError::new(
                StorageErrorCode::Io,
                format!("Repository lock poisoned: {e}"),
            )
        })?;
        if record.id().is_empty() {
            record.set_id(uuid::Uuid::new_v4().to_string());
        }
        if self.path(record.id())?.exists() {
            return Err(StorageError::new(
                StorageErrorCode::Validation,
                "Record already exists",
            ));
        }
        record.set_rev(1);
        self.write(&record)?;
        Ok(record)
    }
    fn update(&self, mut record: T, expected_rev: u64) -> Result<T, StorageError> {
        let _guard = self.lock.lock().map_err(|e| {
            StorageError::new(
                StorageErrorCode::Io,
                format!("Repository lock poisoned: {e}"),
            )
        })?;
        let current = self.get(record.id())?;
        if current.rev() != expected_rev {
            return Err(StorageError::new(
                StorageErrorCode::StaleRev,
                format!("Expected rev {expected_rev}, found {}", current.rev()),
            ));
        }
        record.set_rev(expected_rev + 1);
        self.write(&record)?;
        Ok(record)
    }
    fn delete(&self, id: &str) -> Result<(), StorageError> {
        let _guard = self.lock.lock().map_err(|e| {
            StorageError::new(
                StorageErrorCode::Io,
                format!("Repository lock poisoned: {e}"),
            )
        })?;
        let path = self.path(id)?;
        OWN_WRITES
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| StorageError::new(StorageErrorCode::Io, e.to_string()))?
            .insert(self.own_key(id), None);
        fs::remove_file(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                if let Ok(mut writes) = OWN_WRITES.get_or_init(Default::default).lock() {
                    writes.remove(&self.own_key(id));
                }
                StorageError::new(StorageErrorCode::NotFound, format!("Record {id} not found"))
            } else {
                if let Ok(mut writes) = OWN_WRITES.get_or_init(Default::default).lock() {
                    writes.remove(&self.own_key(id));
                }
                StorageError::new(StorageErrorCode::Io, e.to_string())
            }
        })?;
        Ok(())
    }
}

static OWN_WRITES: std::sync::OnceLock<Mutex<std::collections::HashMap<String, Option<[u8; 32]>>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        note::{NoteAnchor, NoteAnchorKind, NoteItem, NoteStatus},
        task::{TaskItem, TaskStatus},
    };
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn ensure_cairn_dir_creates_default_ignore_only_once() {
        let d = tempdir().unwrap();
        let ignore = d.path().join(".cairn/.gitignore");
        ensure_cairn_dir(d.path()).unwrap();
        let expected = b"cache/\nruns/\ntasks/\nnotes/\n";
        assert_eq!(fs::read(&ignore).unwrap(), expected);
        ensure_cairn_dir(d.path()).unwrap();
        assert_eq!(fs::read(&ignore).unwrap(), expected);
    }

    #[test]
    fn ensure_cairn_dir_preserves_custom_ignore() {
        let d = tempdir().unwrap();
        let dir = d.path().join(".cairn");
        fs::create_dir_all(&dir).unwrap();
        let ignore = dir.join(".gitignore");
        fs::write(&ignore, "custom\n").unwrap();
        ensure_cairn_dir(d.path()).unwrap();
        assert_eq!(fs::read_to_string(ignore).unwrap(), "custom\n");
    }

    #[test]
    fn create_get_starts_at_one() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        let t = r.create(TaskItem::new("ship")).unwrap();
        assert_eq!(r.get(&t.id).unwrap(), t);
        assert_eq!(t.rev, 1);
    }
    #[test]
    fn update_checks_revision_and_increments() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        let mut t = r.create(TaskItem::new("ship")).unwrap();
        t.title = "updated".into();
        assert_eq!(r.update(t.clone(), 1).unwrap().rev, 2);
        let before = fs::read(r.path(&t.id).unwrap()).unwrap();
        assert_eq!(r.update(t, 1).unwrap_err().code, StorageErrorCode::StaleRev);
        assert_eq!(
            before,
            fs::read(r.path(&r.list().unwrap().records[0].id()).unwrap()).unwrap()
        );
    }
    #[test]
    fn delete_then_get_is_not_found() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        let t = r.create(TaskItem::new("ship")).unwrap();
        r.delete(&t.id).unwrap();
        assert_eq!(r.get(&t.id).unwrap_err().code, StorageErrorCode::NotFound);
    }
    #[test]
    fn list_skips_corrupt_record() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        r.create(TaskItem::new("ship")).unwrap();
        fs::write(d.path().join("broken.json"), "{").unwrap();
        let report = r.list().unwrap();
        assert_eq!(report.records.len(), 1);
        assert_eq!(report.errors.len(), 1);
    }
    #[test]
    fn write_leaves_no_temp_files() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        r.create(TaskItem::new("ship")).unwrap();
        assert!(!fs::read_dir(d.path()).unwrap().any(|e| e
            .unwrap()
            .path()
            .extension()
            .and_then(|x| x.to_str())
            == Some("tmp")));
    }
    #[test]
    fn task_json_matches_wire_shape() {
        let mut t = TaskItem::new("Ship");
        t.id = "abc".into();
        t.created_at = 10;
        t.status = TaskStatus::NeedsReview;
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"id":"abc","title":"Ship","status":"needs_review","createdAt":10,"schemaVersion":2,"rev":0}"#
        );
    }

    #[test]
    fn invalid_ids_are_rejected_without_escaping_directory() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        let invalid_ids = vec![
            "../x".to_string(),
            "a/b".to_string(),
            r"a\b".to_string(),
            "x".repeat(65),
        ];
        for id in &invalid_ids {
            assert_eq!(r.get(id).unwrap_err().code, StorageErrorCode::Validation);
            let mut record = TaskItem::new("invalid");
            record.id = id.to_string();
            assert_eq!(
                r.create(record.clone()).unwrap_err().code,
                StorageErrorCode::Validation
            );
            assert_eq!(
                r.update(record, 1).unwrap_err().code,
                StorageErrorCode::Validation
            );
            assert_eq!(r.delete(id).unwrap_err().code, StorageErrorCode::Validation);
        }
        assert_eq!(r.get("").unwrap_err().code, StorageErrorCode::Validation);
        assert_eq!(r.delete("").unwrap_err().code, StorageErrorCode::Validation);
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 0);

        // Create retains the UUID fallback for an empty incoming ID.
        let mut empty_id = TaskItem::new("fallback");
        empty_id.id.clear();
        let created = r.create(empty_id).unwrap();
        assert!(!created.id.is_empty());
        assert!(r.path("../x").is_err());
    }

    #[test]
    fn concurrent_updates_with_same_revision_have_one_winner() {
        let d = tempdir().unwrap();
        let repository = Arc::new(FileRepository::new(d.path()));
        let original = repository.create(TaskItem::new("initial")).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|title| {
                let repository = Arc::clone(&repository);
                let barrier = Arc::clone(&barrier);
                let mut record = original.clone();
                record.title = title.to_string();
                std::thread::spawn(move || {
                    barrier.wait();
                    repository.update(record, 1).map(|_| ())
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    matches!(result, Err(error) if error.code == StorageErrorCode::StaleRev)
                })
                .count(),
            1
        );
    }

    #[test]
    fn corrupt_file_error_names_file() {
        let d = tempdir().unwrap();
        let r = FileRepository::<TaskItem>::new(d.path());
        fs::write(d.path().join("broken.json"), "{").unwrap();
        let report = r.list().unwrap();
        assert!(report.errors[0].message.contains("broken.json"));
    }

    #[test]
    fn mismatched_record_id_is_reported_as_corrupt() {
        let d = tempdir().unwrap();
        let r = FileRepository::<TaskItem>::new(d.path());
        let mut record = TaskItem::new("mismatch");
        record.id = "inside".into();
        fs::create_dir_all(d.path()).unwrap();
        fs::write(
            d.path().join("outside.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let report = r.list().unwrap();
        assert!(report.records.is_empty());
        assert_eq!(report.errors[0].code, StorageErrorCode::Corrupt);
        assert!(report.errors[0].message.contains("outside.json"));
    }

    #[test]
    fn note_round_trip_and_wire_shape() {
        let d = tempdir().unwrap();
        let r = FileRepository::new(d.path());
        let mut note = NoteItem::new("Check auth");
        note.id = "note-1".into();
        note.created_at = 20;
        note.status = NoteStatus::Open;
        note.anchors.push(NoteAnchor {
            kind: NoteAnchorKind::Ast,
            id: Some("src/auth.rs::refresh::function".into()),
            label: "Auth.refresh".into(),
            path: "src/auth.rs".into(),
            lost: Some(false),
        });
        let created = r.create(note).unwrap();
        assert_eq!(r.get(&created.id).unwrap(), created);
        assert_eq!(
            serde_json::to_string(&created).unwrap(),
            r#"{"id":"note-1","content":"Check auth","status":"open","anchors":[{"kind":"ast","id":"src/auth.rs::refresh::function","label":"Auth.refresh","path":"src/auth.rs","lost":false}],"createdAt":20,"schemaVersion":1,"rev":1}"#
        );
    }
}
