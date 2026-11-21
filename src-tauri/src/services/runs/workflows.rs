use crate::services::service_error::{now_ms, ServiceError, ServiceErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

const TRUST_FILE: &str = "workflow-trust.json";
static TRUST_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowSource {
    Project,
    Global,
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInfo {
    pub name: String,
    pub source: WorkflowSource,
    pub overrides: Vec<WorkflowSource>,
    pub trusted: bool,
    pub entry: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowChange {
    pub path: String,
    #[serde(rename = "change")]
    pub kind: WorkflowChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTrustStatus {
    pub has_workflows: bool,
    pub trusted: bool,
    pub folder_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_hash: Option<String>,
    pub files: Vec<WorkflowFile>,
    pub changes: Vec<WorkflowChange>,
}

#[derive(Debug, Clone)]
pub struct Workflow {
    pub path: PathBuf,
    pub source: WorkflowSource,
    pub script_hash: String,
    pub trusted: bool,
    pub entry: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum TrustEntry {
    Legacy(String),
    Current(ProjectTrust),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTrust {
    folder_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<BTreeMap<String, String>>,
    #[serde(default)]
    approved_at: u64,
}

impl TrustEntry {
    fn project_trust(&self) -> ProjectTrust {
        match self {
            Self::Legacy(folder_hash) => ProjectTrust {
                folder_hash: folder_hash.clone(),
                files: None,
                approved_at: 0,
            },
            Self::Current(trust) => trust.clone(),
        }
    }
}

type TrustStore = BTreeMap<String, TrustEntry>;

pub fn resolve(root: &Path, name: &str) -> Result<Workflow, ServiceError> {
    resolve_in(root, name, None)
}

pub fn resolve_in(
    root: &Path,
    name: &str,
    data_dir: Option<&Path>,
) -> Result<Workflow, ServiceError> {
    resolve_with_sources(
        root,
        name,
        data_dir,
        bundled_workflows_dir(
            cfg!(debug_assertions),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            None,
        )
        .as_deref(),
    )
}

pub fn resolve_with_sources(
    root: &Path,
    name: &str,
    data_dir: Option<&Path>,
    bundled_dir: Option<&Path>,
) -> Result<Workflow, ServiceError> {
    validate_name(name)?;
    let candidates = workflow_candidates(root, name, bundled_dir);
    let selected = candidates
        .iter()
        .find(|(_, path)| path.as_ref().is_some_and(|path| is_regular_file(path)))
        .ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::WorkflowNotFound,
                format!("Workflow '{name}' was not found"),
            )
        })?;
    let source = selected.0;
    let path = selected
        .1
        .as_ref()
        .unwrap()
        .canonicalize()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let script_hash = match source {
        WorkflowSource::Project => hash_workflows_dir(&root.join(".cairn").join("workflows"))?.hash,
        WorkflowSource::Global | WorkflowSource::Bundled => hash_file(&path)?,
    };
    let trusted = match source {
        WorkflowSource::Project => is_trusted(root, &script_hash, data_dir)?,
        WorkflowSource::Global | WorkflowSource::Bundled => true,
    };
    Ok(Workflow {
        path,
        source,
        script_hash,
        trusted,
        entry: display_entry(source, name),
    })
}

fn workflow_candidates(
    root: &Path,
    name: &str,
    bundled_dir: Option<&Path>,
) -> Vec<(WorkflowSource, Option<PathBuf>)> {
    let project = root
        .join(".cairn")
        .join("workflows")
        .join(format!("{name}.py"));
    let global = dirs::config_dir().map(|directory| {
        directory
            .join("cairn")
            .join("workflows")
            .join(format!("{name}.py"))
    });
    let bundled = bundled_dir.map(|directory| directory.join(format!("{name}.py")));
    vec![
        (WorkflowSource::Project, Some(project)),
        (WorkflowSource::Global, global),
        (WorkflowSource::Bundled, bundled),
    ]
}

fn display_entry(source: WorkflowSource, name: &str) -> String {
    match source {
        WorkflowSource::Project => format!(".cairn/workflows/{name}.py"),
        WorkflowSource::Global => format!("cairn/workflows/{name}.py"),
        WorkflowSource::Bundled => format!("workflows/{name}.py"),
    }
}

pub fn require_trust(_root: &Path, workflow: &Workflow) -> Result<(), ServiceError> {
    if workflow.trusted || workflow.source != WorkflowSource::Project {
        return Ok(());
    }
    Err(ServiceError::new(
        ServiceErrorCode::TrustRequired,
        "Workflows in this project are not trusted. Review them in Settings.",
    ))
}

pub fn trust(root: &Path, hash: &str, data_dir: Option<&Path>) -> Result<(), ServiceError> {
    let directory = root.join(".cairn").join("workflows");
    let current = hash_workflows_dir(&directory)?;
    if current.hash != hash {
        return Err(ServiceError::validation(
            "Workflow folder hash does not match the current project workflows folder",
        ));
    }
    let _guard = TRUST_STORE_LOCK
        .lock()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let mut store = read_trust_store(data_dir)?;
    let key = trust_key(root)?;
    store.remove(&legacy_trust_key(root)?);
    store.insert(
        key,
        TrustEntry::Current(ProjectTrust {
            folder_hash: current.hash,
            files: Some(
                current
                    .files
                    .iter()
                    .map(|file| (file.path.clone(), file.sha256.clone()))
                    .collect(),
            ),
            approved_at: now_ms(),
        }),
    );
    write_trust_store(&store, data_dir)
}

pub fn revoke(root: &Path, data_dir: Option<&Path>) -> Result<(), ServiceError> {
    let _guard = TRUST_STORE_LOCK
        .lock()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let mut store = read_trust_store(data_dir)?;
    store.remove(&trust_key(root)?);
    store.remove(&legacy_trust_key(root)?);
    write_trust_store(&store, data_dir)
}

pub fn trust_status(
    root: &Path,
    data_dir: Option<&Path>,
) -> Result<WorkflowTrustStatus, ServiceError> {
    trust_status_with_data(root, data_dir)
}

fn trust_status_with_data(
    root: &Path,
    data_dir: Option<&Path>,
) -> Result<WorkflowTrustStatus, ServiceError> {
    let directory = root.join(".cairn").join("workflows");
    let current = hash_workflows_dir(&directory)?;
    let py_files = current.files.iter().any(|file| {
        Path::new(&file.path)
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("py")
            && is_regular_file(&directory.join(&file.path))
    });
    let store = read_trust_store(data_dir)?;
    let approved = store
        .get(&trust_key(root)?)
        .or_else(|| legacy_trust_key(root).ok().and_then(|key| store.get(&key)))
        .map(TrustEntry::project_trust);
    let trusted = py_files
        && approved
            .as_ref()
            .is_some_and(|approval| approval.folder_hash == current.hash);
    let changes = match approved
        .as_ref()
        .and_then(|approval| approval.files.as_ref())
    {
        Some(approved_files) => diff_files(approved_files, &current.files),
        None => Vec::new(),
    };
    Ok(WorkflowTrustStatus {
        has_workflows: py_files,
        trusted,
        folder_hash: current.hash,
        approved_hash: approved.map(|approval| approval.folder_hash),
        files: current.files,
        changes,
    })
}

fn diff_files(
    approved: &BTreeMap<String, String>,
    current: &[WorkflowFile],
) -> Vec<WorkflowChange> {
    let current: BTreeMap<_, _> = current
        .iter()
        .map(|file| (file.path.as_str(), file.sha256.as_str()))
        .collect();
    let mut changes = BTreeMap::new();
    for (path, hash) in approved {
        match current.get(path.as_str()) {
            None => {
                changes.insert(path.clone(), WorkflowChangeKind::Removed);
            }
            Some(current_hash) if *current_hash != hash => {
                changes.insert(path.clone(), WorkflowChangeKind::Modified);
            }
            _ => {}
        }
    }
    for path in current.keys() {
        if !approved.contains_key(*path) {
            changes.insert((*path).to_owned(), WorkflowChangeKind::Added);
        }
    }
    changes
        .into_iter()
        .map(|(path, kind)| WorkflowChange { path, kind })
        .collect()
}

pub fn list(root: &Path) -> Result<Vec<WorkflowInfo>, ServiceError> {
    list_in(root, None)
}

pub fn list_in(root: &Path, data_dir: Option<&Path>) -> Result<Vec<WorkflowInfo>, ServiceError> {
    list_with_sources(
        root,
        data_dir,
        bundled_workflows_dir(
            cfg!(debug_assertions),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            None,
        )
        .as_deref(),
    )
}

pub fn list_with_sources(
    root: &Path,
    data_dir: Option<&Path>,
    bundled_dir: Option<&Path>,
) -> Result<Vec<WorkflowInfo>, ServiceError> {
    let mut names = BTreeSet::new();
    for (_, directory) in [
        (
            WorkflowSource::Project,
            Some(root.join(".cairn").join("workflows")),
        ),
        (
            WorkflowSource::Global,
            dirs::config_dir().map(|directory| directory.join("cairn").join("workflows")),
        ),
        (WorkflowSource::Bundled, bundled_dir.map(Path::to_path_buf)),
    ] {
        if let Some(directory) = directory {
            collect_names(&directory, &mut names)?;
        }
    }
    names
        .into_iter()
        .map(|name| {
            let workflow = resolve_with_sources(root, &name, data_dir, bundled_dir)?;
            let overrides = workflow_candidates(root, &name, bundled_dir)
                .into_iter()
                .filter_map(|(source, path)| {
                    (source != workflow.source
                        && path.as_ref().is_some_and(|path| is_regular_file(path)))
                    .then_some(source)
                })
                .collect();
            Ok(WorkflowInfo {
                name,
                source: workflow.source,
                overrides,
                trusted: workflow.trusted,
                entry: workflow.entry,
            })
        })
        .collect()
}

fn collect_names(directory: &Path, names: &mut BTreeSet<String>) -> Result<(), ServiceError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let path = entry.path();
        if !is_regular_file(&path) || path.extension().and_then(|ext| ext.to_str()) != Some("py") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if validate_name(name).is_ok() {
            names.insert(name.into());
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), ServiceError> {
    if (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(ServiceError::validation(
            "Workflow name must match [A-Za-z0-9_-]{1,64}",
        ))
    }
}

fn hash_file(path: &Path) -> Result<String, ServiceError> {
    let bytes = fs::read(path)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

struct WorkflowDirectoryHash {
    hash: String,
    files: Vec<WorkflowFile>,
}

fn hash_workflows_dir(directory: &Path) -> Result<WorkflowDirectoryHash, ServiceError> {
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkflowDirectoryHash {
                hash: format!("{:x}", Sha256::digest([])),
                files: Vec::new(),
            });
        }
        Err(error) => return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Err(ServiceError::new(
                ServiceErrorCode::Io,
                "Project workflows path is not a directory",
            ));
        }
    }
    let mut files = walkdir::WalkDir::new(directory)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !entry
                .path()
                .strip_prefix(directory)
                .unwrap_or(entry.path())
                .components()
                .any(|component| component.as_os_str() == "__pycache__")
        })
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_file() || entry.file_type().is_symlink() => {
                let relative = entry.path().strip_prefix(directory).ok()?.to_path_buf();
                if relative
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("pyc")
                {
                    None
                } else {
                    Some(Ok(relative))
                }
            }
            Ok(_) => None,
            Err(error) => Some(Err(ServiceError::new(
                ServiceErrorCode::Io,
                error.to_string(),
            ))),
        })
        .collect::<Result<Vec<_>, _>>()?;
    files.sort_by(|left, right| {
        left.as_os_str()
            .as_encoded_bytes()
            .cmp(right.as_os_str().as_encoded_bytes())
    });

    let mut digest = Sha256::new();
    let mut inventory = Vec::with_capacity(files.len());
    for relative in files {
        let path = directory.join(&relative);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let contents = if metadata.file_type().is_symlink() {
            fs::read_link(&path)
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
                .as_os_str()
                .as_encoded_bytes()
                .to_vec()
        } else {
            fs::read(&path)
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
        };
        let relative_string = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let sha256 = format!("{:x}", Sha256::digest(&contents));
        digest.update(relative.as_os_str().as_encoded_bytes());
        digest.update(&contents);
        inventory.push(WorkflowFile {
            path: relative_string,
            size: contents.len() as u64,
            sha256,
        });
    }
    Ok(WorkflowDirectoryHash {
        hash: format!("{:x}", digest.finalize()),
        files: inventory,
    })
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn app_data_dir(data_dir: Option<&Path>) -> Result<PathBuf, ServiceError> {
    match data_dir {
        Some(path) => Ok(path.to_path_buf()),
        None => dirs::data_dir()
            .map(|path| path.join("cairn"))
            .ok_or_else(|| {
                ServiceError::new(
                    ServiceErrorCode::RuntimeUnavailable,
                    "Could not determine the application data directory",
                )
            }),
    }
}

fn read_trust_store(data_dir: Option<&Path>) -> Result<TrustStore, ServiceError> {
    let path = app_data_dir(data_dir)?.join(TRUST_FILE);
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Corrupt, error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    }
}

fn write_trust_store(store: &TrustStore, data_dir: Option<&Path>) -> Result<(), ServiceError> {
    let directory = app_data_dir(data_dir)?;
    fs::create_dir_all(&directory)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let path = directory.join(TRUST_FILE);
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    fs::write(path, bytes)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))
}

fn trust_key(root: &Path) -> Result<String, ServiceError> {
    Ok(root
        .canonicalize()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
        .to_string_lossy()
        .into_owned())
}

fn legacy_trust_key(root: &Path) -> Result<String, ServiceError> {
    Ok(format!("{}|.cairn/workflows", trust_key(root)?))
}

fn is_trusted(
    root: &Path,
    current_hash: &str,
    data_dir: Option<&Path>,
) -> Result<bool, ServiceError> {
    let store = read_trust_store(data_dir)?;
    Ok(store
        .get(&trust_key(root)?)
        .or_else(|| legacy_trust_key(root).ok().and_then(|key| store.get(&key)))
        .is_some_and(|approval| approval.project_trust().folder_hash == current_hash))
}

pub fn bundled_workflows_dir(
    debug_build: bool,
    manifest_dir: &Path,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    super::sdk_dir(debug_build, manifest_dir, resource_dir).map(|path| path.join("workflows"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn workflow_dir(root: &Path) -> PathBuf {
        root.join(".cairn").join("workflows")
    }

    fn create_workflow(directory: &Path, name: &str, body: &str) {
        fs::create_dir_all(directory).unwrap();
        fs::write(directory.join(format!("{name}.py")), body).unwrap();
    }

    #[test]
    fn trust_status_handles_missing_empty_untrusted_and_trusted_folders() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let missing = trust_status(root.path(), Some(data.path())).unwrap();
        assert!(!missing.has_workflows);
        assert!(!missing.trusted);
        assert!(missing.files.is_empty());
        assert!(missing.changes.is_empty());
        assert_eq!(
            serde_json::to_value(missing).unwrap(),
            serde_json::json!({
                "hasWorkflows": false,
                "trusted": false,
                "folderHash": format!("{:x}", Sha256::digest([])),
                "files": [],
                "changes": []
            })
        );

        fs::create_dir_all(workflow_dir(root.path())).unwrap();
        let empty = trust_status(root.path(), Some(data.path())).unwrap();
        assert!(!empty.has_workflows);
        assert!(empty.files.is_empty());

        create_workflow(&workflow_dir(root.path()), "default", "pass\n");
        let untrusted = trust_status(root.path(), Some(data.path())).unwrap();
        assert!(untrusted.has_workflows);
        assert!(!untrusted.trusted);
        assert_eq!(
            serde_json::to_value(&untrusted).unwrap(),
            serde_json::json!({
                "hasWorkflows": true,
                "trusted": false,
                "folderHash": untrusted.folder_hash,
                "files": [{
                    "path": "default.py",
                    "size": 5,
                    "sha256": format!("{:x}", Sha256::digest(b"pass\n"))
                }],
                "changes": []
            })
        );

        trust(root.path(), &untrusted.folder_hash, Some(data.path())).unwrap();
        let trusted = trust_status(root.path(), Some(data.path())).unwrap();
        assert!(trusted.trusted);
        assert_eq!(
            trusted.approved_hash.as_deref(),
            Some(trusted.folder_hash.as_str())
        );
    }

    #[test]
    fn changes_report_added_modified_and_removed_files() {
        for (change, expected) in [
            ("added", WorkflowChangeKind::Added),
            ("modified", WorkflowChangeKind::Modified),
            ("removed", WorkflowChangeKind::Removed),
        ] {
            let root = tempdir().unwrap();
            let data = tempdir().unwrap();
            let directory = workflow_dir(root.path());
            create_workflow(&directory, "main", "pass\n");
            fs::write(directory.join("helper.py"), "VALUE = 1\n").unwrap();
            let before = trust_status(root.path(), Some(data.path())).unwrap();
            trust(root.path(), &before.folder_hash, Some(data.path())).unwrap();

            match change {
                "added" => fs::write(directory.join("added.txt"), "added").unwrap(),
                "modified" => fs::write(directory.join("helper.py"), "VALUE = 2\n").unwrap(),
                "removed" => fs::remove_file(directory.join("helper.py")).unwrap(),
                _ => unreachable!(),
            }
            let after = trust_status(root.path(), Some(data.path())).unwrap();
            assert!(!after.trusted);
            assert_eq!(after.changes.len(), 1);
            assert_eq!(after.changes[0].kind, expected);
            assert_eq!(
                serde_json::to_value(&after.changes[0]).unwrap()["change"],
                change
            );
        }
    }

    #[test]
    fn helper_changes_affect_hash_and_python_cache_files_do_not() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        create_workflow(&directory, "main", "pass\n");
        let helper_dir = directory.join("helpers");
        fs::create_dir_all(&helper_dir).unwrap();
        fs::write(helper_dir.join("common.py"), "VALUE = 1\n").unwrap();
        let first = trust_status(root.path(), Some(data.path())).unwrap();
        trust(root.path(), &first.folder_hash, Some(data.path())).unwrap();

        fs::write(helper_dir.join("common.py"), "VALUE = 2\n").unwrap();
        let helper_changed = trust_status(root.path(), Some(data.path())).unwrap();
        assert_ne!(helper_changed.folder_hash, first.folder_hash);
        assert_eq!(helper_changed.changes[0].kind, WorkflowChangeKind::Modified);
        trust(root.path(), &helper_changed.folder_hash, Some(data.path())).unwrap();

        let cache_dir = directory.join("__pycache__");
        fs::create_dir_all(&cache_dir).unwrap();
        fs::write(cache_dir.join("main.pyc"), "cache").unwrap();
        fs::write(directory.join("ignored.pyc"), "cache").unwrap();
        assert_eq!(
            trust_status(root.path(), Some(data.path()))
                .unwrap()
                .folder_hash,
            helper_changed.folder_hash
        );
    }

    #[test]
    fn old_format_approval_loads_without_file_changes() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        create_workflow(&workflow_dir(root.path()), "main", "pass");
        let current = trust_status(root.path(), Some(data.path())).unwrap();
        fs::write(
            data.path().join(TRUST_FILE),
            serde_json::to_vec(&serde_json::json!({
                legacy_trust_key(root.path()).unwrap(): current.folder_hash
            }))
            .unwrap(),
        )
        .unwrap();
        let status = trust_status(root.path(), Some(data.path())).unwrap();
        assert!(status.trusted);
        assert!(status.changes.is_empty());
        assert_eq!(
            status.approved_hash.as_deref(),
            Some(current.folder_hash.as_str())
        );
    }

    #[test]
    fn wrong_hash_is_rejected_revoke_works_and_projects_are_independent() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let data = tempdir().unwrap();
        create_workflow(&workflow_dir(first.path()), "main", "pass");
        create_workflow(&workflow_dir(second.path()), "main", "pass");
        let hash = trust_status(first.path(), Some(data.path()))
            .unwrap()
            .folder_hash;
        assert_eq!(
            trust(first.path(), "wrong", Some(data.path()))
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
        trust(first.path(), &hash, Some(data.path())).unwrap();
        assert!(
            trust_status(first.path(), Some(data.path()))
                .unwrap()
                .trusted
        );
        assert!(
            !trust_status(second.path(), Some(data.path()))
                .unwrap()
                .trusted
        );
        revoke(first.path(), Some(data.path())).unwrap();
        assert!(
            !trust_status(first.path(), Some(data.path()))
                .unwrap()
                .trusted
        );
    }

    #[test]
    fn project_settings_cannot_claim_workflow_trust() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        create_workflow(&directory, "main", "pass");
        fs::write(
            root.path().join(".cairn").join("settings.json"),
            r#"{"workflowTrusted":true,"folderHash":"anything"}"#,
        )
        .unwrap();
        let workflow = resolve_with_sources(root.path(), "main", Some(data.path()), None).unwrap();
        assert!(!workflow.trusted);
        assert!(
            !trust_status(root.path(), Some(data.path()))
                .unwrap()
                .trusted
        );
    }

    #[test]
    fn source_precedence_and_overrides_cover_all_available_sources() {
        let root = tempdir().unwrap();
        let bundled = tempdir().unwrap();
        let name = format!("slice7b-{}", uuid::Uuid::new_v4().simple());
        let global_dir = dirs::config_dir().unwrap().join("cairn").join("workflows");
        let global_path = global_dir.join(format!("{name}.py"));
        let project_path = workflow_dir(root.path()).join(format!("{name}.py"));
        create_workflow(bundled.path(), &name, "bundled");
        create_workflow(&global_dir, &name, "global");
        create_workflow(&workflow_dir(root.path()), &name, "project");
        let data = tempdir().unwrap();

        let project = list_with_sources(root.path(), Some(data.path()), Some(bundled.path()))
            .unwrap()
            .into_iter()
            .find(|workflow| workflow.name == name)
            .unwrap();
        assert_eq!(project.source, WorkflowSource::Project);
        assert_eq!(
            project.overrides,
            [WorkflowSource::Global, WorkflowSource::Bundled]
        );
        assert_eq!(project.entry, format!(".cairn/workflows/{name}.py"));

        fs::remove_file(project_path).unwrap();
        let global =
            resolve_with_sources(root.path(), &name, Some(data.path()), Some(bundled.path()))
                .unwrap();
        assert_eq!(global.source, WorkflowSource::Global);
        let global_list = list_with_sources(root.path(), Some(data.path()), Some(bundled.path()))
            .unwrap()
            .into_iter()
            .find(|workflow| workflow.name == name)
            .unwrap();
        assert_eq!(global_list.overrides, [WorkflowSource::Bundled]);
        assert_eq!(global_list.entry, format!("cairn/workflows/{name}.py"));

        fs::remove_file(global_path).unwrap();
        let bundled_workflow =
            resolve_with_sources(root.path(), &name, Some(data.path()), Some(bundled.path()))
                .unwrap();
        assert_eq!(bundled_workflow.source, WorkflowSource::Bundled);
        assert!(bundled_workflow.trusted);
        assert_eq!(bundled_workflow.entry, format!("workflows/{name}.py"));
        let bundled_list = list_with_sources(root.path(), Some(data.path()), Some(bundled.path()))
            .unwrap()
            .into_iter()
            .find(|workflow| workflow.name == name)
            .unwrap();
        assert!(bundled_list.overrides.is_empty());
    }

    #[test]
    fn global_and_bundled_workflows_pass_the_run_trust_gate_without_approval() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let bundled = tempdir().unwrap();
        let name = format!("slice7b-global-{}", uuid::Uuid::new_v4().simple());
        let global_dir = dirs::config_dir().unwrap().join("cairn").join("workflows");
        let global_path = global_dir.join(format!("{name}.py"));
        create_workflow(&global_dir, &name, "pass");
        create_workflow(bundled.path(), "only-bundled", "pass");

        let global =
            resolve_with_sources(root.path(), &name, Some(data.path()), Some(bundled.path()))
                .unwrap();
        assert_eq!(global.source, WorkflowSource::Global);
        assert!(global.trusted);
        require_trust(root.path(), &global).unwrap();

        let bundled = resolve_with_sources(
            root.path(),
            "only-bundled",
            Some(data.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(bundled.source, WorkflowSource::Bundled);
        assert!(bundled.trusted);
        require_trust(root.path(), &bundled).unwrap();
        fs::remove_file(global_path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_hashed_as_link_targets_without_following_them() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        create_workflow(&directory, "main", "pass");
        symlink("missing-helper.py", directory.join("link.py")).unwrap();
        let status = trust_status(root.path(), Some(data.path())).unwrap();
        let link = status
            .files
            .iter()
            .find(|file| file.path == "link.py")
            .unwrap();
        assert_eq!(
            link.sha256,
            format!("{:x}", Sha256::digest(b"missing-helper.py"))
        );
        assert_eq!(link.size, "missing-helper.py".len() as u64);
    }
}
