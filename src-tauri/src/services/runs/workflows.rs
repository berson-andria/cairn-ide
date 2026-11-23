use crate::services::service_error::{now_ms, ServiceError, ServiceErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const TRUST_FILE: &str = "workflow-trust.json";
const CHOICE_FILE: &str = "workflow-choice.json";
pub const ENTRY_FILE: &str = "main.py";
const PROJECT_FOLDER: &str = ".cairn/workflows";
const GLOBAL_FOLDER: &str = "<config dir>/cairn/workflows";
const BUNDLED_FOLDER: &str = "<app>/workflows";
const STDLIB_MODULES: &[&str] = &[
    "abc",
    "argparse",
    "array",
    "asyncio",
    "base64",
    "bisect",
    "calendar",
    "cmath",
    "collections",
    "concurrent",
    "copy",
    "csv",
    "dataclasses",
    "datetime",
    "decimal",
    "email",
    "enum",
    "fractions",
    "functools",
    "hashlib",
    "heapq",
    "http",
    "io",
    "itertools",
    "json",
    "logging",
    "math",
    "multiprocessing",
    "operator",
    "os",
    "pathlib",
    "pickle",
    "queue",
    "random",
    "re",
    "shutil",
    "socket",
    "statistics",
    "string",
    "subprocess",
    "sys",
    "threading",
    "time",
    "typing",
    "unittest",
    "urllib",
    "uuid",
];
static TRUST_STORE_LOCK: Mutex<()> = Mutex::new(());
static CHOICE_STORE_LOCK: Mutex<()> = Mutex::new(());
static WORKFLOW_CREATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowSource {
    Project,
    Global,
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowScopeStatus {
    pub source: WorkflowSource,
    pub folder: String,
    pub status: WorkflowFolderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub warnings: Vec<String>,
    pub trusted: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowFolderStatus {
    Empty,
    Ok,
    NoEntry,
    ReservedName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStatus {
    pub active: Option<WorkflowSource>,
    pub sources: Vec<WorkflowScopeStatus>,
    pub needs_choice: bool,
    pub choice: Option<WorkflowSource>,
    pub choice_options: WorkflowChoiceOptions,
    pub active_via: Option<WorkflowActiveVia>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowChoiceOptions {
    pub bundled: bool,
    pub global: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowActiveVia {
    Project,
    Chosen,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowChoice {
    scope: WorkflowSource,
    chosen_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTemplate {
    pub id: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCreated {
    pub source: WorkflowSource,
    pub entry: String,
    pub entry_path: PathBuf,
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
type WorkflowChoiceStore = BTreeMap<String, WorkflowChoice>;

pub fn workflow_status(
    root: &Path,
    data_dir: Option<&Path>,
    bundled_dir: Option<&Path>,
) -> Result<WorkflowStatus, ServiceError> {
    let global_dir = global_workflows_dir();
    workflow_status_with_dirs(root, data_dir, global_dir.as_deref(), bundled_dir)
}

pub fn workflow_status_with_dirs(
    root: &Path,
    data_dir: Option<&Path>,
    global_dir: Option<&Path>,
    bundled_dir: Option<&Path>,
) -> Result<WorkflowStatus, ServiceError> {
    let definitions = [
        (
            WorkflowSource::Project,
            Some(root.join(PROJECT_FOLDER)),
            PROJECT_FOLDER,
        ),
        (
            WorkflowSource::Global,
            global_dir.map(Path::to_path_buf),
            GLOBAL_FOLDER,
        ),
        (
            WorkflowSource::Bundled,
            bundled_dir.map(Path::to_path_buf),
            BUNDLED_FOLDER,
        ),
    ];
    let mut sources = Vec::with_capacity(definitions.len());
    for (source, directory, display_folder) in definitions {
        sources.push(scope_status(
            root,
            source,
            directory.as_deref(),
            display_folder,
            data_dir,
            true,
        )?);
    }
    let choices = read_workflow_choice_store(data_dir)?;
    let stored_choice = choices.get(&trust_key(root)?).map(|choice| choice.scope);
    let project_status = sources[0].status;
    let global_status = sources[1].status;
    let bundled_status = sources[2].status;
    let (active, needs_choice, choice, active_via) = match project_status {
        WorkflowFolderStatus::Ok => (
            Some(WorkflowSource::Project),
            false,
            None,
            Some(WorkflowActiveVia::Project),
        ),
        WorkflowFolderStatus::ReservedName => (None, false, None, None),
        WorkflowFolderStatus::NoEntry => {
            let choice = match stored_choice {
                Some(WorkflowSource::Bundled) => Some(WorkflowSource::Bundled),
                Some(WorkflowSource::Global) if global_status == WorkflowFolderStatus::Ok => {
                    Some(WorkflowSource::Global)
                }
                _ => None,
            };
            let active = choice.filter(|choice| {
                let status = match choice {
                    WorkflowSource::Global => global_status,
                    WorkflowSource::Bundled => bundled_status,
                    WorkflowSource::Project => unreachable!(),
                };
                status == WorkflowFolderStatus::Ok
            });
            (
                active,
                choice.is_none(),
                choice,
                active.map(|_| WorkflowActiveVia::Chosen),
            )
        }
        WorkflowFolderStatus::Empty => {
            let fallback = if global_status != WorkflowFolderStatus::Empty {
                Some((WorkflowSource::Global, global_status))
            } else if bundled_status != WorkflowFolderStatus::Empty {
                Some((WorkflowSource::Bundled, bundled_status))
            } else {
                None
            };
            match fallback {
                Some((source, WorkflowFolderStatus::Ok)) => {
                    (Some(source), false, None, Some(WorkflowActiveVia::Fallback))
                }
                _ => (None, false, None, None),
            }
        }
    };
    Ok(WorkflowStatus {
        active,
        sources,
        needs_choice,
        choice,
        choice_options: WorkflowChoiceOptions {
            bundled: true,
            global: global_status == WorkflowFolderStatus::Ok,
        },
        active_via,
    })
}

pub fn resolve_active_with_dirs(
    root: &Path,
    data_dir: Option<&Path>,
    global_dir: Option<&Path>,
    bundled_dir: Option<&Path>,
) -> Result<Workflow, ServiceError> {
    let status = workflow_status_with_dirs(root, data_dir, global_dir, bundled_dir)?;
    if status.sources[0].status == WorkflowFolderStatus::Ok {
        workflow_choice_clear(root, data_dir)?;
    }
    if status.sources[0].status == WorkflowFolderStatus::ReservedName {
        return Err(scope_validation(&status.sources[0]));
    }
    if status.needs_choice {
        return Err(ServiceError::new(
            ServiceErrorCode::WorkflowChoiceRequired,
            "This project's workflows folder has no main.py. Choose which workflow to use.",
        ));
    }
    let source = status.active.ok_or_else(|| {
        let failed_scope = if status.sources[0].status == WorkflowFolderStatus::NoEntry {
            status
                .choice
                .and_then(|choice| status.sources.iter().find(|scope| scope.source == choice))
        } else if status.sources[0].status == WorkflowFolderStatus::Empty
            && status.sources[1].status != WorkflowFolderStatus::Empty
        {
            Some(&status.sources[1])
        } else if status.sources[0].status == WorkflowFolderStatus::Empty
            && status.sources[1].status == WorkflowFolderStatus::Empty
            && status.sources[2].status != WorkflowFolderStatus::Empty
        {
            Some(&status.sources[2])
        } else {
            None
        };
        failed_scope
            .map(scope_validation)
            .unwrap_or_else(|| ServiceError::validation("no workflow is available in any scope"))
    })?;
    let scope = status
        .sources
        .iter()
        .find(|scope| scope.source == source)
        .expect("active source comes from the source list");
    if scope.status != WorkflowFolderStatus::Ok {
        return Err(ServiceError::validation(
            scope
                .message
                .as_deref()
                .unwrap_or("workflow scope is not runnable"),
        ));
    }

    let directory = match source {
        WorkflowSource::Project => root.join(PROJECT_FOLDER),
        WorkflowSource::Global => global_dir.map(Path::to_path_buf).ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::RuntimeUnavailable,
                "Could not determine the global workflows directory",
            )
        })?,
        WorkflowSource::Bundled => bundled_dir.map(Path::to_path_buf).ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::RuntimeUnavailable,
                "Bundled workflows are unavailable",
            )
        })?,
    };
    let path = directory
        .join(ENTRY_FILE)
        .canonicalize()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let script_hash = match source {
        WorkflowSource::Project => hash_workflows_dir(&directory)?.hash,
        WorkflowSource::Global | WorkflowSource::Bundled => hash_file(&path)?,
    };
    Ok(Workflow {
        path,
        source,
        script_hash,
        trusted: scope.trusted.unwrap_or(false),
    })
}

fn scope_validation(scope: &WorkflowScopeStatus) -> ServiceError {
    ServiceError::validation(
        scope
            .message
            .as_deref()
            .unwrap_or("workflow scope is not runnable"),
    )
}

fn scope_status(
    root: &Path,
    source: WorkflowSource,
    directory: Option<&Path>,
    display_folder: &str,
    data_dir: Option<&Path>,
    include_trust: bool,
) -> Result<WorkflowScopeStatus, ServiceError> {
    let Some(directory) = directory else {
        return Ok(WorkflowScopeStatus {
            source,
            folder: display_folder.into(),
            status: WorkflowFolderStatus::Empty,
            entry: None,
            message: None,
            warnings: Vec::new(),
            trusted: None,
        });
    };
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries
            .map(|entry| {
                entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    };
    let warnings = workflow_warnings(&entries)?;
    let mut reserved_name = None;
    let mut has_entry = false;
    let mut has_content = false;
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry
            .file_type()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        if (name.eq_ignore_ascii_case("cairn.py") && kind.is_file())
            || (name.eq_ignore_ascii_case("cairn") && kind.is_dir())
        {
            reserved_name = Some(name.clone());
        }
        has_entry |= name == ENTRY_FILE && kind.is_file();
        has_content |= !(name == "__pycache__" && kind.is_dir());
    }
    let (status, entry, message) = if let Some(name) = reserved_name {
        (
            WorkflowFolderStatus::ReservedName,
            None,
            Some(format!("{name} would shadow the Cairn SDK; rename it")),
        )
    } else if has_entry {
        (
            WorkflowFolderStatus::Ok,
            Some(format!("{display_folder}/{ENTRY_FILE}")),
            None,
        )
    } else if has_content {
        (
            WorkflowFolderStatus::NoEntry,
            None,
            Some(format!("no main.py in {display_folder}")),
        )
    } else {
        (WorkflowFolderStatus::Empty, None, None)
    };
    let trusted = if status == WorkflowFolderStatus::Empty || !include_trust {
        None
    } else {
        Some(match source {
            WorkflowSource::Project => {
                let hash = hash_workflows_dir(directory)?.hash;
                is_trusted(root, &hash, data_dir)?
            }
            WorkflowSource::Global | WorkflowSource::Bundled => true,
        })
    };
    Ok(WorkflowScopeStatus {
        source,
        folder: display_folder.into(),
        status,
        entry,
        message,
        warnings,
        trusted,
    })
}

fn workflow_warnings(entries: &[fs::DirEntry]) -> Result<Vec<String>, ServiceError> {
    let mut warnings = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_directory = entry
            .file_type()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
            .is_dir();
        let module = if is_directory {
            name.as_str()
        } else {
            let path = Path::new(&name);
            if path.extension().and_then(|extension| extension.to_str()) != Some("py") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            stem
        };
        if STDLIB_MODULES.contains(&module) {
            let entry_name = if is_directory {
                format!("{name}/")
            } else {
                name
            };
            warnings.push(format!("{entry_name} may shadow a standard library module"));
        }
    }
    warnings.sort();
    Ok(warnings)
}

pub fn workflow_templates(sdk_path: &Path) -> Result<Vec<WorkflowTemplate>, ServiceError> {
    let directory = sdk_path.join("templates");
    let entries = fs::read_dir(&directory).map_err(|error| {
        ServiceError::new(ServiceErrorCode::RuntimeUnavailable, error.to_string())
    })?;
    let mut templates = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
            .is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("py")
        {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| {
                ServiceError::new(ServiceErrorCode::Corrupt, "Invalid template filename")
            })?
            .to_owned();
        let contents = fs::read_to_string(&path)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let (title, description) = parse_template_metadata(&contents).ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::Corrupt,
                format!("Template '{id}' must define title and description in its first 10 lines"),
            )
        })?;
        templates.push(WorkflowTemplate {
            id,
            title,
            description,
        });
    }
    templates.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(templates)
}

fn parse_template_metadata(contents: &str) -> Option<(String, String)> {
    let mut title = None;
    let mut description = None;
    for line in contents.lines().take(10) {
        if let Some(value) = line.strip_prefix("# title:") {
            title = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("# description:") {
            description = Some(value.trim().to_owned());
        }
    }
    match (title, description) {
        (Some(title), Some(description)) if !title.is_empty() && !description.is_empty() => {
            Some((title, description))
        }
        _ => None,
    }
}

pub fn create_workflow(
    root: &Path,
    scope: &str,
    template: &str,
    sdk_path: &Path,
    global_dir: Option<&Path>,
    bundled_dir: Option<&Path>,
) -> Result<WorkflowCreated, ServiceError> {
    let source = match scope {
        "project" => WorkflowSource::Project,
        "global" => WorkflowSource::Global,
        _ => return Err(ServiceError::validation("scope must be project or global")),
    };
    let directory = match source {
        WorkflowSource::Project => root.join(PROJECT_FOLDER),
        WorkflowSource::Global => global_dir.map(Path::to_path_buf).ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::RuntimeUnavailable,
                "Could not determine the global workflows directory",
            )
        })?,
        WorkflowSource::Bundled => unreachable!(),
    };
    let display_folder = match source {
        WorkflowSource::Project => PROJECT_FOLDER,
        WorkflowSource::Global => GLOBAL_FOLDER,
        WorkflowSource::Bundled => unreachable!(),
    };
    let _guard = WORKFLOW_CREATE_LOCK
        .lock()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let existing = scope_status(root, source, Some(&directory), display_folder, None, false)?;
    if source == WorkflowSource::Project && directory.is_dir() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
        {
            let entry = entry
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case(ENTRY_FILE) && name != ENTRY_FILE {
                return Err(ServiceError::validation(format!(
                    "rename {name} to {ENTRY_FILE} instead"
                )));
            }
        }
    }
    if source == WorkflowSource::Project && existing.status == WorkflowFolderStatus::ReservedName {
        return Err(scope_validation(&existing));
    }
    if existing.status != WorkflowFolderStatus::Empty
        && !(source == WorkflowSource::Project && existing.status == WorkflowFolderStatus::NoEntry)
    {
        return Err(ServiceError::validation(format!(
            "a workflow already exists in {display_folder}"
        )));
    }

    let bundled_source = if template == "bundled" {
        let bundled_dir = bundled_dir.ok_or_else(|| {
            ServiceError::new(
                ServiceErrorCode::RuntimeUnavailable,
                "Bundled workflows are unavailable",
            )
        })?;
        if !bundled_dir.is_dir() {
            return Err(ServiceError::new(
                ServiceErrorCode::RuntimeUnavailable,
                "Bundled workflows are unavailable",
            ));
        }
        Some(bundled_dir)
    } else {
        None
    };
    if source == WorkflowSource::Project {
        if let Some(bundled_source) = bundled_source {
            let collisions = bundled_copy_collisions(bundled_source, &directory)?;
            if !collisions.is_empty() {
                return Err(ServiceError::validation(format!(
                    "bundled workflow paths already exist: {}",
                    collisions.join(", ")
                )));
            }
        }
    }
    let template_contents = if bundled_source.is_none() {
        let templates = workflow_templates(sdk_path)?;
        if !templates.iter().any(|item| item.id == template) {
            return Err(ServiceError::validation(format!(
                "unknown workflow template '{template}'"
            )));
        }
        Some(
            fs::read(sdk_path.join("templates").join(format!("{template}.py")))
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?,
        )
    } else {
        None
    };
    fs::create_dir_all(&directory)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    if let Some(bundled_source) = bundled_source {
        copy_directory(bundled_source, &directory)?;
    } else if let Some(bytes) = template_contents {
        let path = directory.join(ENTRY_FILE);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        file.write_all(&bytes)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    } else {
        unreachable!("workflow source was validated before creating the destination");
    }
    let entry_path = directory
        .join(ENTRY_FILE)
        .canonicalize()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    Ok(WorkflowCreated {
        source,
        entry: format!("{display_folder}/{ENTRY_FILE}"),
        entry_path,
    })
}

pub fn workflow_choose(
    root: &Path,
    scope: &str,
    data_dir: Option<&Path>,
    global_dir: Option<&Path>,
) -> Result<(), ServiceError> {
    let source = match scope {
        "bundled" => WorkflowSource::Bundled,
        "global" => {
            let status = scope_status(
                root,
                WorkflowSource::Global,
                global_dir,
                GLOBAL_FOLDER,
                None,
                false,
            )?;
            if status.status != WorkflowFolderStatus::Ok {
                return Err(ServiceError::validation("no usable global workflow"));
            }
            WorkflowSource::Global
        }
        _ => return Err(ServiceError::validation("scope must be bundled or global")),
    };
    let _guard = CHOICE_STORE_LOCK
        .lock()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let mut store = read_workflow_choice_store(data_dir)?;
    store.insert(
        trust_key(root)?,
        WorkflowChoice {
            scope: source,
            chosen_at: now_ms(),
        },
    );
    write_workflow_choice_store(&store, data_dir)
}

pub fn workflow_choice_clear(root: &Path, data_dir: Option<&Path>) -> Result<(), ServiceError> {
    let _guard = CHOICE_STORE_LOCK
        .lock()
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let mut store = read_workflow_choice_store(data_dir)?;
    if store.remove(&trust_key(root)?).is_some() {
        write_workflow_choice_store(&store, data_dir)?;
    }
    Ok(())
}

fn bundled_copy_collisions(source: &Path, destination: &Path) -> Result<Vec<String>, ServiceError> {
    fn collect_paths(
        root: &Path,
        path: &Path,
        paths: &mut BTreeMap<String, String>,
    ) -> Result<(), ServiceError> {
        let entries = fs::read_dir(path)
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            let entry_path = entry.path();
            let relative = entry_path
                .strip_prefix(root)
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            let display = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            paths.insert(display.to_lowercase(), display);
            if entry
                .file_type()
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
                .is_dir()
            {
                collect_paths(root, &entry_path, paths)?;
            }
        }
        Ok(())
    }

    let mut source_paths = BTreeMap::new();
    collect_paths(source, source, &mut source_paths)?;
    let mut destination_paths = BTreeMap::new();
    if destination.is_dir() {
        collect_paths(destination, destination, &mut destination_paths)?;
    }
    Ok(source_paths
        .keys()
        .filter_map(|path| destination_paths.get(path).cloned())
        .collect())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), ServiceError> {
    let entries = fs::read_dir(source)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let kind = entry
            .file_type()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            fs::create_dir(&target)
                .or_else(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            copy_directory(&entry.path(), &target)?;
        } else if kind.is_file() {
            let mut input = fs::File::open(entry.path())
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
            std::io::copy(&mut input, &mut output)
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        } else {
            return Err(ServiceError::validation(
                "bundled workflows may contain only files and directories",
            ));
        }
    }
    Ok(())
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

pub fn global_workflows_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|directory| directory.join("cairn").join("workflows"))
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
    let has_workflows = has_main_entry(&directory)?;
    let store = read_trust_store(data_dir)?;
    let approved = store
        .get(&trust_key(root)?)
        .or_else(|| legacy_trust_key(root).ok().and_then(|key| store.get(&key)))
        .map(TrustEntry::project_trust);
    let trusted = has_workflows
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
        has_workflows,
        trusted,
        folder_hash: current.hash,
        approved_hash: approved.map(|approval| approval.folder_hash),
        files: current.files,
        changes,
    })
}

fn has_main_entry(directory: &Path) -> Result<bool, ServiceError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        if entry.file_name() == ENTRY_FILE
            && entry
                .file_type()
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
                .is_file()
        {
            return Ok(true);
        }
    }
    Ok(false)
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

fn read_workflow_choice_store(
    data_dir: Option<&Path>,
) -> Result<WorkflowChoiceStore, ServiceError> {
    let path = app_data_dir(data_dir)?.join(CHOICE_FILE);
    match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(store) => Ok(store),
            Err(error) => {
                tauri_plugin_log::log::warn!(
                    "Ignoring corrupt workflow choice store {}: {error}",
                    path.display()
                );
                Ok(BTreeMap::new())
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tauri_plugin_log::log::debug!(
                "Workflow choice store does not exist yet: {}",
                path.display()
            );
            Ok(BTreeMap::new())
        }
        Err(error) => Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    }
}

fn write_workflow_choice_store(
    store: &WorkflowChoiceStore,
    data_dir: Option<&Path>,
) -> Result<(), ServiceError> {
    let directory = app_data_dir(data_dir)?;
    fs::create_dir_all(&directory)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let path = directory.join(CHOICE_FILE);
    let temporary = directory.join(format!("{CHOICE_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_workflow_choice_file(&temporary, &path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_workflow_choice_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_workflow_choice_file(source: &Path, destination: &Path) -> std::io::Result<()> {
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
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
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

    fn create_entry(directory: &Path, body: &str) {
        fs::create_dir_all(directory).unwrap();
        fs::write(directory.join(ENTRY_FILE), body).unwrap();
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

        create_entry(&workflow_dir(root.path()), "pass\n");
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
                    "path": "main.py",
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
            create_entry(&directory, "pass\n");
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
        create_entry(&directory, "pass\n");
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
        create_entry(&workflow_dir(root.path()), "pass");
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
        create_entry(&workflow_dir(first.path()), "pass");
        create_entry(&workflow_dir(second.path()), "pass");
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
        create_entry(&directory, "pass");
        fs::write(
            root.path().join(".cairn").join("settings.json"),
            r#"{"workflowTrusted":true,"folderHash":"anything"}"#,
        )
        .unwrap();
        let workflow =
            resolve_active_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert!(!workflow.trusted);
        assert!(
            !trust_status(root.path(), Some(data.path()))
                .unwrap()
                .trusted
        );
    }

    fn set_scope_state(directory: &Path, state: WorkflowFolderStatus) {
        if directory.exists() {
            fs::remove_dir_all(directory).unwrap();
        }
        match state {
            WorkflowFolderStatus::Empty => {}
            WorkflowFolderStatus::Ok => create_entry(directory, "pass"),
            WorkflowFolderStatus::NoEntry => {
                fs::create_dir_all(directory).unwrap();
                fs::write(directory.join("helper.py"), "pass").unwrap();
            }
            WorkflowFolderStatus::ReservedName => {
                fs::create_dir_all(directory).unwrap();
                fs::write(directory.join("Cairn.py"), "pass").unwrap();
            }
        }
    }

    #[test]
    fn workflow_status_resolves_fallbacks_and_requests_a_choice_for_project_no_entry() {
        let states = [
            WorkflowFolderStatus::Empty,
            WorkflowFolderStatus::Ok,
            WorkflowFolderStatus::NoEntry,
            WorkflowFolderStatus::ReservedName,
        ];
        for project_state in states {
            for global_state in states {
                for bundled_state in states {
                    let root = tempdir().unwrap();
                    let global = tempdir().unwrap();
                    let bundled = tempdir().unwrap();
                    let data = tempdir().unwrap();
                    let project_dir = workflow_dir(root.path());
                    set_scope_state(&project_dir, project_state);
                    set_scope_state(global.path(), global_state);
                    set_scope_state(bundled.path(), bundled_state);
                    let status = workflow_status_with_dirs(
                        root.path(),
                        Some(data.path()),
                        Some(global.path()),
                        Some(bundled.path()),
                    )
                    .unwrap();
                    let expected = match project_state {
                        WorkflowFolderStatus::Ok => Some(WorkflowSource::Project),
                        WorkflowFolderStatus::Empty if global_state == WorkflowFolderStatus::Ok => {
                            Some(WorkflowSource::Global)
                        }
                        WorkflowFolderStatus::Empty
                            if global_state == WorkflowFolderStatus::Empty
                                && bundled_state == WorkflowFolderStatus::Ok =>
                        {
                            Some(WorkflowSource::Bundled)
                        }
                        _ => None,
                    };
                    assert_eq!(
                        status.needs_choice,
                        project_state == WorkflowFolderStatus::NoEntry
                    );
                    assert_eq!(
                        status.choice_options,
                        WorkflowChoiceOptions {
                            bundled: true,
                            global: global_state == WorkflowFolderStatus::Ok
                        }
                    );
                    assert_eq!(
                        status.active, expected,
                        "unexpected active scope for {project_state:?}/{global_state:?}/{bundled_state:?}"
                    );
                    assert_eq!(
                        status
                            .sources
                            .iter()
                            .map(|scope| scope.status)
                            .collect::<Vec<_>>(),
                        [project_state, global_state, bundled_state]
                    );
                }
            }
        }
    }

    #[test]
    fn workflow_status_has_stable_display_strings_and_exact_empty_json() {
        let root = tempdir().unwrap();
        let global = tempdir().unwrap();
        let bundled = tempdir().unwrap();
        let data = tempdir().unwrap();
        let status = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "active": null,
                "needsChoice": false,
                "choice": null,
                "choiceOptions": {
                    "bundled": true,
                    "global": false
                },
                "activeVia": null,
                "sources": [
                    {
                        "source": "project",
                        "folder": ".cairn/workflows",
                        "status": "empty",
                        "warnings": [],
                        "trusted": null
                    },
                    {
                        "source": "global",
                        "folder": "<config dir>/cairn/workflows",
                        "status": "empty",
                        "warnings": [],
                        "trusted": null
                    },
                    {
                        "source": "bundled",
                        "folder": "<app>/workflows",
                        "status": "empty",
                        "warnings": [],
                        "trusted": null
                    }
                ]
            })
        );
    }

    #[test]
    fn workflow_status_serializes_project_reserved_and_fallback_states_exactly() {
        let root = tempdir().unwrap();
        let global = tempdir().unwrap();
        let bundled = tempdir().unwrap();
        let data = tempdir().unwrap();
        create_entry(global.path(), "global");
        create_entry(bundled.path(), "bundled");
        workflow_choose(
            root.path(),
            "bundled",
            Some(data.path()),
            Some(global.path()),
        )
        .unwrap();

        let project = workflow_dir(root.path());
        create_entry(&project, "project");
        let project_status = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(project_status).unwrap(),
            serde_json::json!({
                "active": "project",
                "sources": [
                    {
                        "source": "project",
                        "folder": ".cairn/workflows",
                        "status": "ok",
                        "entry": ".cairn/workflows/main.py",
                        "warnings": [],
                        "trusted": false
                    },
                    {
                        "source": "global",
                        "folder": "<config dir>/cairn/workflows",
                        "status": "ok",
                        "entry": "<config dir>/cairn/workflows/main.py",
                        "warnings": [],
                        "trusted": true
                    },
                    {
                        "source": "bundled",
                        "folder": "<app>/workflows",
                        "status": "ok",
                        "entry": "<app>/workflows/main.py",
                        "warnings": [],
                        "trusted": true
                    }
                ],
                "needsChoice": false,
                "choice": null,
                "choiceOptions": {
                    "bundled": true,
                    "global": true
                },
                "activeVia": "project"
            })
        );

        fs::remove_file(project.join(ENTRY_FILE)).unwrap();
        fs::write(project.join("Cairn.py"), "reserved").unwrap();
        let reserved = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(reserved).unwrap(),
            serde_json::json!({
                "active": null,
                "sources": [
                    {
                        "source": "project",
                        "folder": ".cairn/workflows",
                        "status": "reserved-name",
                        "message": "Cairn.py would shadow the Cairn SDK; rename it",
                        "warnings": [],
                        "trusted": false
                    },
                    {
                        "source": "global",
                        "folder": "<config dir>/cairn/workflows",
                        "status": "ok",
                        "entry": "<config dir>/cairn/workflows/main.py",
                        "warnings": [],
                        "trusted": true
                    },
                    {
                        "source": "bundled",
                        "folder": "<app>/workflows",
                        "status": "ok",
                        "entry": "<app>/workflows/main.py",
                        "warnings": [],
                        "trusted": true
                    }
                ],
                "needsChoice": false,
                "choice": null,
                "choiceOptions": {
                    "bundled": true,
                    "global": true
                },
                "activeVia": null
            })
        );

        fs::remove_dir_all(&project).unwrap();
        let global_fallback = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(global_fallback).unwrap()["activeVia"],
            "fallback"
        );
        assert_eq!(
            serde_json::to_value(
                workflow_status_with_dirs(
                    root.path(),
                    Some(data.path()),
                    Some(global.path()),
                    Some(bundled.path())
                )
                .unwrap()
            )
            .unwrap()["active"],
            "global"
        );

        fs::remove_dir_all(global.path()).unwrap();
        let bundled_fallback = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(bundled_fallback.active, Some(WorkflowSource::Bundled));
        assert_eq!(
            serde_json::to_value(bundled_fallback).unwrap()["activeVia"],
            "fallback"
        );
    }

    #[test]
    fn main_filename_is_case_sensitive_pycache_is_empty_and_reserved_names_are_case_insensitive() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        fs::create_dir_all(directory.join("__pycache__")).unwrap();
        let empty = workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert_eq!(empty.active, None);

        fs::write(directory.join("Main.py"), "pass").unwrap();
        let status = workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert_eq!(status.active, None);
        assert!(status.needs_choice);
        assert_eq!(status.sources[0].status, WorkflowFolderStatus::NoEntry);
        assert_eq!(
            status.sources[0].message.as_deref(),
            Some("no main.py in .cairn/workflows")
        );

        fs::write(directory.join("main.py"), "pass").unwrap();
        fs::write(directory.join("Cairn.py"), "shadow").unwrap();
        let reserved =
            workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert_eq!(
            reserved.sources[0].status,
            WorkflowFolderStatus::ReservedName
        );
        assert_eq!(
            reserved.sources[0].message.as_deref(),
            Some("Cairn.py would shadow the Cairn SDK; rename it")
        );
        fs::remove_file(directory.join("Cairn.py")).unwrap();
        fs::create_dir(directory.join("CAIRN")).unwrap();
        let reserved_directory =
            workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert_eq!(
            reserved_directory.sources[0].message.as_deref(),
            Some("CAIRN would shadow the Cairn SDK; rename it")
        );
    }

    #[test]
    fn workflow_warnings_include_standard_module_files_and_directories() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        create_entry(&directory, "pass");
        fs::write(directory.join("json.py"), "value = 1").unwrap();
        fs::create_dir(directory.join("logging")).unwrap();
        let status = workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert_eq!(
            status.sources[0].warnings,
            [
                "json.py may shadow a standard library module",
                "logging/ may shadow a standard library module"
            ]
        );
    }

    #[test]
    fn resolve_active_requires_choice_for_project_no_entry_and_keeps_other_invalid_scopes_hard() {
        let root = tempdir().unwrap();
        let global = tempdir().unwrap();
        let bundled = tempdir().unwrap();
        let data = tempdir().unwrap();
        create_entry(global.path(), "pass");
        create_entry(bundled.path(), "pass");
        let project = workflow_dir(root.path());
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("helper.py"), "pass").unwrap();
        let error = resolve_active_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::WorkflowChoiceRequired);
        assert_eq!(
            error.message,
            "This project's workflows folder has no main.py. Choose which workflow to use."
        );

        fs::remove_file(project.join("helper.py")).unwrap();
        fs::write(project.join("cairn.py"), "shadow").unwrap();
        let error = resolve_active_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert_eq!(
            error.message,
            "cairn.py would shadow the Cairn SDK; rename it"
        );

        fs::remove_dir_all(&project).unwrap();
        fs::remove_dir_all(global.path()).unwrap();
        fs::create_dir_all(global.path()).unwrap();
        fs::write(global.path().join("helper.py"), "pass").unwrap();
        let error = resolve_active_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(error.message, "no main.py in <config dir>/cairn/workflows");

        fs::remove_dir_all(global.path()).unwrap();
        fs::remove_dir_all(bundled.path()).unwrap();
        fs::create_dir_all(bundled.path()).unwrap();
        fs::write(bundled.path().join("helper.py"), "pass").unwrap();
        let error = resolve_active_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(error.message, "no main.py in <app>/workflows");
    }

    #[test]
    fn workflow_choices_are_per_project_and_revalidate_global_usability() {
        let root = tempdir().unwrap();
        let other_root = tempdir().unwrap();
        let global = tempdir().unwrap();
        let bundled = tempdir().unwrap();
        let data = tempdir().unwrap();
        let project = workflow_dir(root.path());
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("helper.py"), "keep").unwrap();
        let other_project = workflow_dir(other_root.path());
        fs::create_dir_all(&other_project).unwrap();
        fs::write(other_project.join("helper.py"), "keep").unwrap();
        create_entry(global.path(), "global");
        create_entry(bundled.path(), "bundled");

        assert_eq!(
            resolve_active_with_dirs(
                root.path(),
                Some(data.path()),
                Some(global.path()),
                Some(bundled.path())
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::WorkflowChoiceRequired
        );

        workflow_choose(
            root.path(),
            "bundled",
            Some(data.path()),
            Some(global.path()),
        )
        .unwrap();
        let chosen_status = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&chosen_status).unwrap()["active"],
            "bundled"
        );
        assert_eq!(
            serde_json::to_value(&chosen_status).unwrap()["choice"],
            "bundled"
        );
        assert_eq!(
            serde_json::to_value(&chosen_status).unwrap()["activeVia"],
            "chosen"
        );
        assert_eq!(
            serde_json::to_value(&chosen_status).unwrap(),
            serde_json::json!({
                "active": "bundled",
                "sources": [
                    {
                        "source": "project",
                        "folder": ".cairn/workflows",
                        "status": "no-entry",
                        "message": "no main.py in .cairn/workflows",
                        "warnings": [],
                        "trusted": false
                    },
                    {
                        "source": "global",
                        "folder": "<config dir>/cairn/workflows",
                        "status": "ok",
                        "entry": "<config dir>/cairn/workflows/main.py",
                        "warnings": [],
                        "trusted": true
                    },
                    {
                        "source": "bundled",
                        "folder": "<app>/workflows",
                        "status": "ok",
                        "entry": "<app>/workflows/main.py",
                        "warnings": [],
                        "trusted": true
                    }
                ],
                "needsChoice": false,
                "choice": "bundled",
                "choiceOptions": {
                    "bundled": true,
                    "global": true
                },
                "activeVia": "chosen"
            })
        );
        assert!(!chosen_status.needs_choice);
        assert_eq!(
            resolve_active_with_dirs(
                root.path(),
                Some(data.path()),
                Some(global.path()),
                Some(bundled.path())
            )
            .unwrap()
            .source,
            WorkflowSource::Bundled
        );

        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(data.path().join(CHOICE_FILE)).unwrap()).unwrap();
        let key = trust_key(root.path()).unwrap();
        assert_eq!(stored[&key]["scope"], "bundled");
        assert!(stored[&key]["chosenAt"].as_u64().is_some());

        workflow_choose(
            other_root.path(),
            "bundled",
            Some(data.path()),
            Some(global.path()),
        )
        .unwrap();
        assert_eq!(
            workflow_status_with_dirs(
                other_root.path(),
                Some(data.path()),
                Some(global.path()),
                Some(bundled.path())
            )
            .unwrap()
            .choice,
            Some(WorkflowSource::Bundled)
        );

        workflow_choose(
            root.path(),
            "global",
            Some(data.path()),
            Some(global.path()),
        )
        .unwrap();
        assert_eq!(
            resolve_active_with_dirs(
                root.path(),
                Some(data.path()),
                Some(global.path()),
                Some(bundled.path())
            )
            .unwrap()
            .source,
            WorkflowSource::Global
        );
        fs::remove_dir_all(global.path()).unwrap();
        let removed = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert!(removed.needs_choice);
        assert_eq!(removed.choice, None);
        assert_eq!(removed.active, None);
        assert_eq!(
            resolve_active_with_dirs(
                root.path(),
                Some(data.path()),
                Some(global.path()),
                Some(bundled.path())
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::WorkflowChoiceRequired
        );
        let error = workflow_choose(
            root.path(),
            "global",
            Some(data.path()),
            Some(global.path()),
        )
        .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert_eq!(error.message, "no usable global workflow");

        workflow_choice_clear(root.path(), Some(data.path())).unwrap();
        let cleared = workflow_status_with_dirs(
            root.path(),
            Some(data.path()),
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(cleared.choice, None);
        assert!(cleared.needs_choice);
    }

    #[test]
    fn corrupt_choice_store_is_ignored_and_reserved_projects_never_offer_a_choice() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let project = workflow_dir(root.path());
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("helper.py"), "keep").unwrap();
        fs::write(data.path().join(CHOICE_FILE), b"{ broken json").unwrap();
        let status = workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert!(status.needs_choice);
        assert_eq!(status.choice, None);
        assert_eq!(status.active, None);
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "active": null,
                "sources": [
                    {
                        "source": "project",
                        "folder": ".cairn/workflows",
                        "status": "no-entry",
                        "message": "no main.py in .cairn/workflows",
                        "warnings": [],
                        "trusted": false
                    },
                    {
                        "source": "global",
                        "folder": "<config dir>/cairn/workflows",
                        "status": "empty",
                        "warnings": [],
                        "trusted": null
                    },
                    {
                        "source": "bundled",
                        "folder": "<app>/workflows",
                        "status": "empty",
                        "warnings": [],
                        "trusted": null
                    }
                ],
                "needsChoice": true,
                "choice": null,
                "choiceOptions": {
                    "bundled": true,
                    "global": false
                },
                "activeVia": null
            })
        );

        fs::write(project.join("cairn.py"), "shadow").unwrap();
        let reserved =
            workflow_status_with_dirs(root.path(), Some(data.path()), None, None).unwrap();
        assert_eq!(
            reserved.sources[0].status,
            WorkflowFolderStatus::ReservedName
        );
        assert!(!reserved.needs_choice);
        assert_eq!(reserved.choice, None);
        assert_eq!(
            resolve_active_with_dirs(root.path(), Some(data.path()), None, None)
                .unwrap_err()
                .code,
            ServiceErrorCode::Validation
        );
    }

    #[test]
    fn no_entry_workflow_is_not_advertised_for_trust_review() {
        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let project = workflow_dir(root.path());
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("helper.py"), "pass").unwrap();
        let status = trust_status(root.path(), Some(data.path())).unwrap();
        assert!(!status.has_workflows);
        assert!(!status.trusted);
    }

    #[test]
    fn workflow_templates_parse_comment_metadata_and_create_without_overwriting() {
        let sdk_path =
            super::super::sdk_dir(true, Path::new(env!("CARGO_MANIFEST_DIR")), None).unwrap();
        let templates = workflow_templates(&sdk_path).unwrap();
        assert_eq!(
            templates
                .iter()
                .map(|template| template.id.as_str())
                .collect::<Vec<_>>(),
            ["blank", "edit-file", "steps"]
        );
        assert_eq!(templates[0].title, "Blank workflow");

        for template in &templates {
            let root = tempdir().unwrap();
            let global = tempdir().unwrap();
            let bundled = tempdir().unwrap();
            let created = create_workflow(
                root.path(),
                "project",
                &template.id,
                &sdk_path,
                Some(global.path()),
                Some(bundled.path()),
            )
            .unwrap();
            assert_eq!(created.source, WorkflowSource::Project);
            assert_eq!(created.entry, ".cairn/workflows/main.py");
            let created_text = fs::read_to_string(&created.entry_path).unwrap();
            assert!(created_text.contains(&format!("# title: {}", template.title)));
            let error = create_workflow(
                root.path(),
                "project",
                &template.id,
                &sdk_path,
                Some(global.path()),
                Some(bundled.path()),
            )
            .unwrap_err();
            assert_eq!(error.code, ServiceErrorCode::Validation);
            assert_eq!(
                error.message,
                "a workflow already exists in .cairn/workflows"
            );
            assert_eq!(
                fs::read_to_string(created.entry_path).unwrap(),
                created_text
            );
        }
    }

    #[test]
    fn project_workflow_create_preserves_no_entry_files_and_rejects_case_collisions() {
        let sdk_path =
            super::super::sdk_dir(true, Path::new(env!("CARGO_MANIFEST_DIR")), None).unwrap();
        let global = tempdir().unwrap();
        let bundled = tempdir().unwrap();

        let root = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("helper.py"), "preserve this").unwrap();
        create_workflow(
            root.path(),
            "project",
            "blank",
            &sdk_path,
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("helper.py")).unwrap(),
            "preserve this"
        );
        assert!(directory.join(ENTRY_FILE).is_file());

        let main_case_root = tempdir().unwrap();
        let main_case_directory = workflow_dir(main_case_root.path());
        fs::create_dir_all(&main_case_directory).unwrap();
        fs::write(main_case_directory.join("Main.py"), "existing").unwrap();
        let error = create_workflow(
            main_case_root.path(),
            "project",
            "blank",
            &sdk_path,
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert_eq!(error.message, "rename Main.py to main.py instead");

        let bundled_root = tempdir().unwrap();
        let bundled_directory = workflow_dir(bundled_root.path());
        fs::create_dir_all(bundled_directory.join("Helpers")).unwrap();
        fs::write(bundled_directory.join("Helpers/shared.py"), "keep").unwrap();
        fs::write(bundled.path().join(ENTRY_FILE), "bundled").unwrap();
        fs::create_dir_all(bundled.path().join("helpers")).unwrap();
        fs::write(bundled.path().join("helpers/shared.py"), "copy").unwrap();
        let error = create_workflow(
            bundled_root.path(),
            "project",
            "bundled",
            &sdk_path,
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert!(error.message.contains("Helpers"));
        assert_eq!(
            fs::read_to_string(bundled_directory.join("Helpers/shared.py")).unwrap(),
            "keep"
        );
        assert!(!bundled_directory.join(ENTRY_FILE).exists());

        let copied_root = tempdir().unwrap();
        let copied_directory = workflow_dir(copied_root.path());
        fs::create_dir_all(&copied_directory).unwrap();
        fs::write(copied_directory.join("existing.txt"), "preserve").unwrap();
        create_workflow(
            copied_root.path(),
            "project",
            "bundled",
            &sdk_path,
            Some(global.path()),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(copied_directory.join("existing.txt")).unwrap(),
            "preserve"
        );
        assert_eq!(
            fs::read_to_string(copied_directory.join(ENTRY_FILE)).unwrap(),
            "bundled"
        );
        assert_eq!(
            fs::read_to_string(copied_directory.join("helpers/shared.py")).unwrap(),
            "copy"
        );
    }

    #[test]
    fn workflow_create_makes_global_directories_and_recursively_copies_bundled_files() {
        let sdk_path =
            super::super::sdk_dir(true, Path::new(env!("CARGO_MANIFEST_DIR")), None).unwrap();
        let root = tempdir().unwrap();
        let global_root = tempdir().unwrap();
        let global = global_root.path().join("cairn").join("workflows");
        let bundled = tempdir().unwrap();
        fs::create_dir_all(bundled.path().join("helpers")).unwrap();
        fs::write(bundled.path().join(ENTRY_FILE), "pass").unwrap();
        fs::write(bundled.path().join("helpers/common.py"), "VALUE = 1").unwrap();
        let created = create_workflow(
            root.path(),
            "global",
            "bundled",
            &sdk_path,
            Some(&global),
            Some(bundled.path()),
        )
        .unwrap();
        assert_eq!(created.source, WorkflowSource::Global);
        assert!(created.entry_path.is_file());
        assert_eq!(
            fs::read_to_string(global.join("helpers/common.py")).unwrap(),
            "VALUE = 1"
        );
        let error = create_workflow(
            root.path(),
            "global",
            "bundled",
            &sdk_path,
            Some(&global),
            Some(bundled.path()),
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "a workflow already exists in <config dir>/cairn/workflows"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_hashed_as_link_targets_without_following_them() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let data = tempdir().unwrap();
        let directory = workflow_dir(root.path());
        create_entry(&directory, "pass");
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
