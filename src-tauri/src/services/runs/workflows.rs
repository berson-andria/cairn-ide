use crate::services::service_error::{ServiceError, ServiceErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

const TRUST_FILE: &str = "workflow-trust.json";
static TRUST_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowSource {
    Project,
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInfo {
    pub name: String,
    pub source: WorkflowSource,
    pub trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInspection {
    pub name: String,
    pub source: WorkflowSource,
    pub path: String,
    pub hash: String,
    pub trusted: bool,
    pub files: Vec<WorkflowFile>,
}

#[derive(Debug, Clone)]
pub struct Workflow {
    pub path: PathBuf,
    pub source: WorkflowSource,
    pub script_hash: String,
    pub trusted: bool,
}

pub fn resolve(root: &Path, name: &str) -> Result<Workflow, ServiceError> {
    resolve_in(root, name, None)
}

pub fn resolve_in(
    root: &Path,
    name: &str,
    data_dir: Option<&Path>,
) -> Result<Workflow, ServiceError> {
    validate_name(name)?;
    let project_path = root
        .join(".cairn")
        .join("workflows")
        .join(format!("{name}.py"));
    let (path, source) = if is_regular_file(&project_path) {
        (project_path, WorkflowSource::Project)
    } else {
        let global_path = dirs::config_dir().map(|directory| {
            directory
                .join("cairn")
                .join("workflows")
                .join(format!("{name}.py"))
        });
        if !global_path
            .as_ref()
            .is_some_and(|path| is_regular_file(path))
        {
            return Err(ServiceError::new(
                ServiceErrorCode::WorkflowNotFound,
                format!("Workflow '{name}' was not found"),
            ));
        }
        (global_path.unwrap(), WorkflowSource::Global)
    };
    let path = path
        .canonicalize()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let script_hash = match source {
        WorkflowSource::Project => hash_workflows_dir(&root.join(".cairn").join("workflows"))?.hash,
        WorkflowSource::Global => hash_file(&path)?,
    };
    let trusted = match source {
        WorkflowSource::Global => true,
        WorkflowSource::Project => is_trusted(root, &script_hash, data_dir)?,
    };
    Ok(Workflow {
        path,
        source,
        script_hash,
        trusted,
    })
}

pub fn inspect_in(
    root: &Path,
    name: &str,
    data_dir: Option<&Path>,
) -> Result<WorkflowInspection, ServiceError> {
    let workflow = resolve_in(root, name, data_dir)?;
    let files = match workflow.source {
        WorkflowSource::Project => {
            hash_workflows_dir(&root.join(".cairn").join("workflows"))?.files
        }
        WorkflowSource::Global => {
            let size = fs::metadata(&workflow.path)
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
                .len();
            vec![WorkflowFile {
                path: workflow
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                size,
            }]
        }
    };
    Ok(WorkflowInspection {
        name: name.to_owned(),
        source: workflow.source,
        path: workflow.path.to_string_lossy().into_owned(),
        hash: workflow.script_hash,
        trusted: workflow.trusted,
        files,
    })
}

pub fn require_trust(root: &Path, workflow: &Workflow) -> Result<(), ServiceError> {
    if workflow.trusted {
        return Ok(());
    }
    Err(ServiceError::new(
        ServiceErrorCode::TrustRequired,
        format!(
            "Workflow folder trust required for {} (SHA-256 {})",
            root.join(".cairn").join("workflows").display(),
            workflow.script_hash
        ),
    ))
}

pub fn trust(root: &Path, name: &str, hash: &str) -> Result<(), ServiceError> {
    trust_in(root, name, hash, None)
}

pub fn trust_in(
    root: &Path,
    name: &str,
    hash: &str,
    data_dir: Option<&Path>,
) -> Result<(), ServiceError> {
    let workflow = resolve_in(root, name, data_dir)?;
    if workflow.source != WorkflowSource::Project || workflow.script_hash != hash {
        return Err(ServiceError::validation(
            "Workflow folder hash does not match the current project workflows folder",
        ));
    }
    let current_hash = hash_workflows_dir(&root.join(".cairn").join("workflows"))?.hash;
    if current_hash != hash {
        return Err(ServiceError::validation(
            "Workflow folder changed before its trust could be stored",
        ));
    }
    let _guard = TRUST_STORE_LOCK
        .lock()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let mut store = read_trust_store(data_dir)?;
    store.insert(trust_key(root)?, hash.to_owned());
    write_trust_store(&store, data_dir)
}

pub fn list(root: &Path) -> Result<Vec<WorkflowInfo>, ServiceError> {
    list_in(root, None)
}

pub fn list_in(root: &Path, data_dir: Option<&Path>) -> Result<Vec<WorkflowInfo>, ServiceError> {
    let mut names = BTreeMap::<String, WorkflowSource>::new();
    let project_dir = root.join(".cairn").join("workflows");
    collect_names(&project_dir, WorkflowSource::Project, &mut names)?;
    if let Some(config_dir) = dirs::config_dir() {
        collect_names(
            &config_dir.join("cairn").join("workflows"),
            WorkflowSource::Global,
            &mut names,
        )?;
    }
    names
        .into_iter()
        .map(|(name, source)| {
            let workflow = resolve_in(root, &name, data_dir)?;
            Ok(WorkflowInfo {
                name,
                source,
                trusted: workflow.trusted,
            })
        })
        .collect()
}

fn collect_names(
    directory: &Path,
    source: WorkflowSource,
    names: &mut BTreeMap<String, WorkflowSource>,
) -> Result<(), ServiceError> {
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
            names.entry(name.into()).or_insert(source);
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
    let mut files = walkdir::WalkDir::new(directory)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.file_type().is_file()
                || !entry
                    .path()
                    .strip_prefix(directory)
                    .unwrap_or(entry.path())
                    .components()
                    .any(|component| component.as_os_str() == "__pycache__")
        })
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_file() => {
                let relative = entry.path().strip_prefix(directory).ok()?.to_path_buf();
                if relative
                    .extension()
                    .and_then(|extension| extension.to_str())
                    == Some("pyc")
                    || relative
                        .components()
                        .any(|component| component.as_os_str() == "__pycache__")
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
        digest.update(relative.as_os_str().as_encoded_bytes());
        let contents = fs::read(directory.join(&relative))
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        inventory.push(WorkflowFile {
            path: relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            size: contents.len() as u64,
        });
        digest.update(contents);
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

fn read_trust_store(data_dir: Option<&Path>) -> Result<BTreeMap<String, String>, ServiceError> {
    let path = app_data_dir(data_dir)?.join(TRUST_FILE);
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Corrupt, error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    }
}

fn write_trust_store(
    store: &BTreeMap<String, String>,
    data_dir: Option<&Path>,
) -> Result<(), ServiceError> {
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
    let root = root
        .canonicalize()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    Ok(format!("{}|.cairn/workflows", root.to_string_lossy()))
}

fn is_trusted(
    root: &Path,
    current_hash: &str,
    data_dir: Option<&Path>,
) -> Result<bool, ServiceError> {
    Ok(read_trust_store(data_dir)?
        .get(&trust_key(root)?)
        .is_some_and(|trusted_hash| trusted_hash == current_hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn project_workflow_requires_current_hash_trust() {
        let root = tempdir().unwrap();
        let workflow_dir = root.path().join(".cairn/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        let script = workflow_dir.join("sample.py");
        fs::write(&script, "print('first')").unwrap();

        let data = tempdir().unwrap();
        let resolved = resolve_in(root.path(), "sample", Some(data.path())).unwrap();
        assert_eq!(resolved.source, WorkflowSource::Project);
        assert!(!resolved.trusted);
        assert_eq!(
            require_trust(root.path(), &resolved).unwrap_err().code,
            ServiceErrorCode::TrustRequired
        );
        trust_in(
            root.path(),
            "sample",
            &resolved.script_hash,
            Some(data.path()),
        )
        .unwrap();
        assert!(
            resolve_in(root.path(), "sample", Some(data.path()))
                .unwrap()
                .trusted
        );

        fs::write(&script, "print('edited')").unwrap();
        let edited = resolve_in(root.path(), "sample", Some(data.path())).unwrap();
        assert!(!edited.trusted);
        assert_eq!(
            require_trust(root.path(), &edited).unwrap_err().code,
            ServiceErrorCode::TrustRequired
        );
        trust_in(
            root.path(),
            "sample",
            &edited.script_hash,
            Some(data.path()),
        )
        .unwrap();
        assert!(
            resolve_in(root.path(), "sample", Some(data.path()))
                .unwrap()
                .trusted
        );
    }

    #[test]
    fn invalid_names_and_wrong_hashes_are_rejected() {
        let root = tempdir().unwrap();
        assert_eq!(
            resolve_in(root.path(), "../workflow", None)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
        let workflow_dir = root.path().join(".cairn/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        fs::write(workflow_dir.join("sample.py"), "pass").unwrap();
        assert_eq!(
            trust_in(root.path(), "sample", "wrong", Some(root.path()))
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
    }

    #[test]
    fn sibling_edits_and_new_files_invalidate_project_folder_trust() {
        let root = tempdir().unwrap();
        let workflow_dir = root.path().join(".cairn/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        fs::write(workflow_dir.join("default.py"), "pass").unwrap();
        fs::write(workflow_dir.join("helper.py"), "VALUE = 1").unwrap();
        let data = tempdir().unwrap();

        let initial = resolve_in(root.path(), "default", Some(data.path())).unwrap();
        trust_in(
            root.path(),
            "default",
            &initial.script_hash,
            Some(data.path()),
        )
        .unwrap();
        assert!(
            resolve_in(root.path(), "default", Some(data.path()))
                .unwrap()
                .trusted
        );

        fs::write(workflow_dir.join("helper.py"), "VALUE = 2").unwrap();
        let edited_sibling = resolve_in(root.path(), "default", Some(data.path())).unwrap();
        assert!(!edited_sibling.trusted);
        trust_in(
            root.path(),
            "default",
            &edited_sibling.script_hash,
            Some(data.path()),
        )
        .unwrap();

        fs::write(workflow_dir.join("new.txt"), "new").unwrap();
        assert!(
            !resolve_in(root.path(), "default", Some(data.path()))
                .unwrap()
                .trusted
        );
        let after_new_file = resolve_in(root.path(), "default", Some(data.path())).unwrap();
        trust_in(
            root.path(),
            "default",
            &after_new_file.script_hash,
            Some(data.path()),
        )
        .unwrap();

        let pycache = workflow_dir.join("__pycache__");
        fs::create_dir_all(&pycache).unwrap();
        fs::write(pycache.join("default.cpython-313.pyc"), "cache").unwrap();
        assert!(
            resolve_in(root.path(), "default", Some(data.path()))
                .unwrap()
                .trusted
        );
    }

    #[test]
    fn workflow_inspection_matches_trust_hash_and_hashed_file_inventory() {
        let root = tempdir().unwrap();
        let workflow_dir = root.path().join(".cairn/workflows");
        let pycache = workflow_dir.join("__pycache__");
        fs::create_dir_all(&pycache).unwrap();
        fs::write(workflow_dir.join("default.py"), "pass").unwrap();
        fs::write(pycache.join("ignored.pyc"), "cache").unwrap();
        let data = tempdir().unwrap();

        let initial = inspect_in(root.path(), "default", Some(data.path())).unwrap();
        assert_eq!(
            initial.files,
            [WorkflowFile {
                path: "default.py".into(),
                size: 4
            }]
        );
        assert_eq!(
            initial.hash,
            resolve_in(root.path(), "default", Some(data.path()))
                .unwrap()
                .script_hash
        );
        assert_eq!(
            serde_json::to_value(&initial).unwrap(),
            serde_json::json!({
                "name": "default",
                "source": "project",
                "path": root.path().join(".cairn/workflows/default.py").canonicalize().unwrap().to_string_lossy(),
                "hash": initial.hash,
                "trusted": false,
                "files": [{"path": "default.py", "size": 4}]
            })
        );
        trust_in(root.path(), "default", &initial.hash, Some(data.path())).unwrap();
        assert!(
            inspect_in(root.path(), "default", Some(data.path()))
                .unwrap()
                .trusted
        );

        fs::write(workflow_dir.join("helper.py"), "VALUE = 1").unwrap();
        fs::write(pycache.join("helper.pyc"), "more cache").unwrap();
        let updated = inspect_in(root.path(), "default", Some(data.path())).unwrap();
        assert_ne!(updated.hash, initial.hash);
        assert_eq!(
            updated
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["default.py", "helper.py"]
        );
        trust_in(root.path(), "default", &updated.hash, Some(data.path())).unwrap();
        assert!(
            inspect_in(root.path(), "default", Some(data.path()))
                .unwrap()
                .trusted
        );

        assert_eq!(
            inspect_in(root.path(), "missing", Some(data.path()))
                .unwrap_err()
                .code,
            ServiceErrorCode::WorkflowNotFound
        );
    }

    #[test]
    fn global_workflow_is_trusted() {
        let config_dir = dirs::config_dir().unwrap();
        let global_dir = config_dir.join("cairn/workflows");
        fs::create_dir_all(&global_dir).unwrap();
        let path = global_dir.join("slice6a-global-test.py");
        fs::write(&path, "pass").unwrap();
        let root = tempdir().unwrap();
        let workflow = resolve_in(root.path(), "slice6a-global-test", None).unwrap();
        assert_eq!(workflow.source, WorkflowSource::Global);
        assert!(workflow.trusted);
        let inspection = inspect_in(root.path(), "slice6a-global-test", None).unwrap();
        assert_eq!(
            serde_json::to_value(&inspection).unwrap(),
            serde_json::json!({
                "name": "slice6a-global-test",
                "source": "global",
                "path": path.canonicalize().unwrap().to_string_lossy(),
                "hash": workflow.script_hash,
                "trusted": true,
                "files": [{"path": "slice6a-global-test.py", "size": 4}]
            })
        );
        fs::remove_file(path).unwrap();
    }
}
