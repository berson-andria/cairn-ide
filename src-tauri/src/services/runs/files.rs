use crate::services::{
    project::{strip_windows_verbatim_prefix, ProjectServices},
    service_error::{now_ms, ChangeEvent, EventSink, ServiceError, ServiceErrorCode},
    storage::ensure_cairn_dir,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const SECRET_FILE_PATTERNS: [&str; 10] = [
    ".env",
    ".env.*",
    ".npmrc",
    ".pypirc",
    "id_rsa*",
    "id_ed25519*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
];

const DEFAULT_MAX_BYTES: u64 = 200_000;
const MAX_READ_BYTES: u64 = 1_000_000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_LIST_ENTRIES: usize = 200;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_PATCH_EDITS: usize = 50;
const MAX_PATCH_FILES: usize = 20;
const MAX_PATCH_AFTER_BYTES: usize = 1_024 * 1_024;
const MAX_PATCHES_PER_RUN: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchStatus {
    Pending,
    Applied,
    Discarded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchOp {
    Create,
    Modify,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchFile {
    pub path: String,
    pub op: PatchOp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub status: PatchStatus,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<u64>,
    pub files: Vec<PatchFile>,
}

impl Patch {
    pub fn summary(&self) -> PatchSummary {
        PatchSummary {
            id: self.id.clone(),
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            subtask_id: self.subtask_id.clone(),
            title: self.title.clone(),
            summary: self.summary.clone(),
            status: self.status,
            created_at: self.created_at,
            applied_at: self.applied_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSummary {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub status: PatchStatus,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum PatchEdit {
    Replace {
        path: String,
        search: String,
        replace: String,
    },
    Write {
        path: String,
        content: String,
    },
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validation_path(path: &str) -> ServiceError {
    ServiceError::validation(format!("Path denied: {path}"))
}

fn secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower == ".npmrc"
        || lower == ".pypirc"
        || (lower.starts_with("id_rsa") || lower.starts_with("id_ed25519"))
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
}

fn windows_component_invalid(name: &str) -> bool {
    if name.contains(':') || name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    let stem = name
        .split_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(name)
        .to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

fn denied_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".git" || lower == ".cairn" || secret_name(name) || windows_component_invalid(name)
}

pub fn is_denied_name(name: &str) -> bool {
    secret_name(name)
}

pub fn resolve_in_project(root: &Path, rel: &str) -> Result<(PathBuf, String), ServiceError> {
    if rel.is_empty() || rel.contains('\0') {
        return Err(validation_path(rel));
    }
    let slash = rel.replace('\\', "/");
    if slash.starts_with('/') || slash.starts_with("//") {
        return Err(validation_path(rel));
    }
    if slash.as_bytes().get(1) == Some(&b':') || slash.contains(':') {
        return Err(validation_path(rel));
    }
    let parts = slash.split('/');
    let mut relative = PathBuf::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if part == ".." {
            return Err(validation_path(rel));
        }
        if denied_component(part) {
            return Err(validation_path(rel));
        }
        relative.push(part);
    }
    if relative.as_os_str().is_empty() {
        return Err(validation_path(rel));
    }
    let root_normalized = PathBuf::from(strip_windows_verbatim_prefix(
        &root
            .canonicalize()
            .unwrap_or_else(|_| root.to_path_buf())
            .to_string_lossy(),
    ));
    let target = root_normalized.join(&relative);
    let target_normalized = if target.exists() {
        PathBuf::from(strip_windows_verbatim_prefix(
            &target
                .canonicalize()
                .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
                .to_string_lossy(),
        ))
    } else {
        let mut ancestor = target.as_path();
        let mut missing = Vec::new();
        while !ancestor.exists() {
            if let Some(name) = ancestor.file_name() {
                missing.push(name.to_os_string());
            }
            if let Some(parent) = ancestor.parent() {
                ancestor = parent;
            } else {
                break;
            }
        }
        let canonical_ancestor = ancestor
            .canonicalize()
            .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let mut resolved = PathBuf::from(strip_windows_verbatim_prefix(
            &canonical_ancestor.to_string_lossy(),
        ));
        for component in missing.iter().rev() {
            resolved.push(component);
        }
        resolved
    };
    if !target_normalized.starts_with(&root_normalized) {
        return Err(validation_path(rel));
    }
    if let Ok(canonical_relative) = target_normalized.strip_prefix(&root_normalized) {
        for component in canonical_relative.components() {
            if let Some(name) = component.as_os_str().to_str() {
                if denied_component(name) {
                    return Err(validation_path(rel));
                }
            }
        }
    }
    let display = relative.to_string_lossy().replace('\\', "/");
    Ok((target_normalized, display))
}

pub fn read_file(root: &Path, rel: &str, max_bytes: Option<u64>) -> Result<FileRead, ServiceError> {
    let (path, display) = resolve_in_project(root, rel)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            ServiceErrorCode::NotFound
        } else {
            ServiceErrorCode::Io
        };
        ServiceError::new(code, error.to_string())
    })?;
    if !metadata.is_file() {
        return Err(ServiceError::validation("Path is not a file"));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(ServiceError::validation("binary or too large"));
    }
    let bytes = fs::read(&path)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err(ServiceError::validation("binary or too large"));
    }
    let limit = max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .clamp(1, MAX_READ_BYTES);
    let read_len = (bytes.len() as u64).min(limit) as usize;
    let text = String::from_utf8_lossy(&bytes[..read_len]).into_owned();
    Ok(FileRead {
        path: display,
        text,
        truncated: read_len < bytes.len(),
        bytes: bytes.len() as u64,
        sha256: sha256(&bytes),
    })
}

pub fn list_files(
    root: &Path,
    rel: &str,
    max_entries: Option<u64>,
) -> Result<Vec<FileEntry>, ServiceError> {
    let path = if rel.is_empty() {
        root.to_path_buf()
    } else {
        resolve_in_project(root, rel)?.0
    };
    let metadata = fs::metadata(&path).map_err(|error| {
        ServiceError::new(
            if error.kind() == std::io::ErrorKind::NotFound {
                ServiceErrorCode::NotFound
            } else {
                ServiceErrorCode::Io
            },
            error.to_string(),
        )
    })?;
    if !metadata.is_dir() {
        return Err(ServiceError::validation("Path is not a directory"));
    }
    let limit = max_entries
        .unwrap_or(DEFAULT_LIST_ENTRIES as u64)
        .clamp(1, MAX_LIST_ENTRIES as u64) as usize;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
    {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if denied_component(&name) {
            continue;
        }
        if resolve_in_project(root, &name).is_err() {
            continue;
        }
        let metadata = entry.metadata().ok();
        let kind = if metadata.as_ref().is_some_and(|item| item.is_dir()) {
            "dir"
        } else {
            "file"
        };
        let size = if kind == "file" {
            Some(metadata.as_ref().map(|item| item.len()).unwrap_or(0))
        } else {
            None
        };
        entries.push(FileEntry {
            name,
            kind: kind.into(),
            size,
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries.truncate(limit);
    Ok(entries)
}

fn read_text_file(path: &Path) -> Result<(Vec<u8>, String), ServiceError> {
    let bytes = fs::read(path)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    if bytes.len() > MAX_FILE_BYTES as usize || bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err(ServiceError::validation("binary or too large"));
    }
    Ok((bytes.clone(), String::from_utf8_lossy(&bytes).into_owned()))
}

fn text_is_allowed(content: &str) -> bool {
    !content.as_bytes().iter().take(8192).any(|byte| *byte == 0)
        && content.len() <= MAX_FILE_BYTES as usize
}

fn atomic_json(path: &Path, value: &Patch) -> Result<(), ServiceError> {
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let temp = parent.join(format!(".patch.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value).unwrap();
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string()));
    }
    Ok(())
}

fn patch_directory(project: &ProjectServices, run_id: &str) -> PathBuf {
    project
        .root
        .join(".cairn/runs")
        .join(run_id)
        .join("patches")
}

fn validate_patch_id(id: &str) -> Result<(), ServiceError> {
    if (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err(ServiceError::validation(
            "Patch id must match [A-Za-z0-9-]{1,64}",
        ))
    }
}

pub fn propose(
    project: &ProjectServices,
    run_id: &str,
    task_id: &str,
    _run_directory: &Path,
    edits: Vec<PatchEdit>,
    title: &str,
    summary: Option<String>,
    sink: &dyn EventSink,
) -> Result<Patch, ServiceError> {
    if edits.is_empty() || edits.len() > MAX_PATCH_EDITS {
        return Err(ServiceError::validation("Patch must contain 1 to 50 edits"));
    }
    let mut distinct = std::collections::BTreeSet::new();
    for edit in &edits {
        let rel = match edit {
            PatchEdit::Replace { path, .. } => path.as_str(),
            PatchEdit::Write { path, .. } => path.as_str(),
        };
        distinct.insert(rel.to_string());
    }
    if distinct.len() > MAX_PATCH_FILES {
        return Err(ServiceError::validation(
            "Patch must contain at most 20 distinct files",
        ));
    }

    let mut patch_files: Vec<PatchFile> = Vec::new();
    let mut text_by_path: std::collections::BTreeMap<
        String,
        (PathBuf, PatchOp, Option<String>, Option<String>, String),
    > = std::collections::BTreeMap::new();
    for edit in edits {
        let (rel, search, replace, content, is_replace) = match edit {
            PatchEdit::Replace {
                path,
                search,
                replace,
            } => (path, Some(search), Some(replace), None, true),
            PatchEdit::Write { path, content } => (path, None, None, Some(content), false),
        };
        let (path, display) = resolve_in_project(&project.root, &rel)?;
        if path.exists() {
            read_text_file(&path)?;
        }
        let entry = text_by_path.entry(display.clone()).or_insert_with(|| {
            if path.exists() {
                let bytes = fs::read(&path).unwrap_or_default();
                let before = String::from_utf8_lossy(&bytes).into_owned();
                (
                    path.clone(),
                    PatchOp::Modify,
                    Some(sha256(&bytes)),
                    Some(before.clone()),
                    before,
                )
            } else {
                (path.clone(), PatchOp::Create, None, None, String::new())
            }
        });
        if is_replace {
            if !path.is_file() {
                return Err(ServiceError::validation(format!(
                    "Replace file must exist: {display}"
                )));
            }
            let search = search.unwrap();
            let count = entry.4.match_indices(&search).count();
            if search.is_empty() {
                return Err(ServiceError::validation(format!(
                    "search matched 0 times in {display}"
                )));
            }
            if count != 1 {
                return Err(ServiceError::validation(format!(
                    "search matched {count} times in {display}"
                )));
            }
            entry.4 = entry.4.replacen(&search, &replace.unwrap(), 1);
        } else {
            let content = content.unwrap();
            entry.1 = if path.exists() {
                PatchOp::Modify
            } else {
                PatchOp::Create
            };
            entry.4 = content;
        }
        if !text_is_allowed(&entry.4) {
            return Err(ServiceError::validation("binary or too large"));
        }
    }
    let total_after: usize = text_by_path.values().map(|entry| entry.4.len()).sum();
    if total_after > MAX_PATCH_AFTER_BYTES {
        return Err(ServiceError::validation("Patch after text exceeds 1 MB"));
    }
    for (display, (_, op, base, before, after)) in text_by_path {
        patch_files.push(PatchFile {
            path: display,
            op,
            base_sha256: base,
            before,
            after,
        });
    }

    let directory = patch_directory(project, run_id);
    ensure_cairn_dir(&project.root)
        .and_then(|_| fs::create_dir_all(&directory))
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
    let mut existing = fs::read_dir(&directory)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
        .count();
    if existing >= MAX_PATCHES_PER_RUN {
        return Err(ServiceError::validation(
            "Run has reached the 20 patch limit",
        ));
    }
    let mut n = 1usize;
    while directory.join(format!("{n}.json")).exists() {
        n += 1;
    }
    existing = n - 1;
    while n <= existing {
        n += 1;
    }
    let task = project
        .tasks
        .get(task_id)
        .map_err(|error| ServiceError::new(error.code, error.message))?;
    let subtask_id = task
        .sub_tasks
        .unwrap_or_default()
        .into_iter()
        .find(|subtask| subtask.status == crate::types::task::TaskStatus::Running)
        .map(|subtask| subtask.id);
    let patch = Patch {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        task_id: task_id.to_string(),
        subtask_id,
        title: title.to_string(),
        summary,
        status: PatchStatus::Pending,
        created_at: now_ms(),
        applied_at: None,
        files: patch_files,
    };
    let path = directory.join(format!("{n}.json"));
    atomic_json(&path, &patch)?;
    sink.emit(ChangeEvent::PatchCreated(patch.summary()));
    Ok(patch)
}

pub fn patch_list(
    project: &ProjectServices,
    run_id: &str,
) -> Result<Vec<PatchSummary>, ServiceError> {
    validate_patch_id(run_id)?;
    let directory = patch_directory(project, run_id);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string())),
    };
    let mut patches = Vec::new();
    for entry in entries.flatten() {
        if let Ok(patch) =
            serde_json::from_slice::<Patch>(&fs::read(entry.path()).unwrap_or_default())
        {
            patches.push(patch.summary());
        }
    }
    patches.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(patches)
}

pub fn patch_get(
    project: &ProjectServices,
    run_id: &str,
    patch_id: &str,
) -> Result<Patch, ServiceError> {
    validate_patch_id(run_id)?;
    validate_patch_id(patch_id)?;
    for entry in fs::read_dir(patch_directory(project, run_id))
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
    {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        if let Ok(bytes) = fs::read(entry.path()) {
            if let Ok(patch) = serde_json::from_slice::<Patch>(&bytes) {
                if patch.id == patch_id {
                    return Ok(patch);
                }
            }
        }
    }
    Err(ServiceError::new(
        ServiceErrorCode::NotFound,
        "Patch not found",
    ))
}

fn patch_path(
    project: &ProjectServices,
    run_id: &str,
    patch_id: &str,
) -> Result<(Patch, PathBuf), ServiceError> {
    let patch = patch_get(project, run_id, patch_id)?;
    let directory = patch_directory(project, run_id);
    let mut found = None;
    for entry in fs::read_dir(&directory)
        .map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?
    {
        let entry =
            entry.map_err(|error| ServiceError::new(ServiceErrorCode::Io, error.to_string()))?;
        if let Ok(bytes) = fs::read(entry.path()) {
            if serde_json::from_slice::<Patch>(&bytes)
                .ok()
                .as_ref()
                .is_some_and(|item| item.id == patch_id)
            {
                found = Some(entry.path());
                break;
            }
        }
    }
    Ok((
        patch,
        found.ok_or_else(|| ServiceError::new(ServiceErrorCode::NotFound, "Patch not found"))?,
    ))
}

pub fn patch_discard(
    project: &ProjectServices,
    run_id: &str,
    patch_id: &str,
    sink: &dyn EventSink,
) -> Result<PatchSummary, ServiceError> {
    let (mut patch, path) = patch_path(project, run_id, patch_id)?;
    if patch.status != PatchStatus::Pending {
        return Err(ServiceError::new(
            ServiceErrorCode::InvalidTransition,
            "Only pending patches can be discarded",
        ));
    }
    patch.status = PatchStatus::Discarded;
    atomic_json(&path, &patch)?;
    let summary = patch.summary();
    sink.emit(ChangeEvent::PatchUpdated(summary.clone()));
    Ok(summary)
}

fn atomic_write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".cairn-write-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        Err(error)
    } else {
        Ok(())
    }
}

fn rollback_file(project: &ProjectServices, file: &PatchFile) -> io::Result<()> {
    let (path, _) = resolve_in_project(&project.root, &file.path)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error.message))?;
    match file.op {
        PatchOp::Create => fs::remove_file(path),
        PatchOp::Modify => {
            atomic_write_file(&path, file.before.as_deref().unwrap_or("").as_bytes())
        }
    }
}

pub fn patch_apply(
    project: &ProjectServices,
    run_id: &str,
    patch_id: &str,
    sink: &dyn EventSink,
) -> Result<PatchSummary, ServiceError> {
    let (mut patch, path) = patch_path(project, run_id, patch_id)?;
    if patch.status != PatchStatus::Pending {
        return Err(ServiceError::new(
            ServiceErrorCode::InvalidTransition,
            "Only pending patches can be applied",
        ));
    }

    let mut conflicts = Vec::new();
    for file in &patch.files {
        let (target, _) = resolve_in_project(&project.root, &file.path)?;
        match file.op {
            PatchOp::Modify => {
                if let Ok(bytes) = fs::read(&target) {
                    if file.base_sha256.as_deref() != Some(sha256(&bytes).as_str()) {
                        conflicts.push(file.path.clone());
                    }
                } else {
                    conflicts.push(file.path.clone());
                }
            }
            PatchOp::Create => {
                if target.exists() {
                    conflicts.push(file.path.clone());
                }
            }
        }
    }
    if !conflicts.is_empty() {
        return Err(ServiceError::new(
            ServiceErrorCode::PatchConflict,
            format!("Patch conflict: {}", conflicts.join(", ")),
        ));
    }

    let mut written = Vec::new();
    for file in &patch.files {
        let (target, _) = resolve_in_project(&project.root, &file.path)?;
        if let Err(error) = atomic_write_file(&target, file.after.as_bytes()) {
            let mut rollback_error = None;
            for written_file in written.iter().rev() {
                if let Err(error) = rollback_file(project, written_file) {
                    rollback_error = Some(error);
                }
            }
            if let Some(rollback_error) = rollback_error {
                return Err(ServiceError::new(
                    ServiceErrorCode::Io,
                    format!("Could not write patch and rollback failed: {rollback_error}; original write: {error}"),
                ));
            }
            return Err(ServiceError::new(ServiceErrorCode::Io, error.to_string()));
        }
        written.push(file.clone());
    }
    patch.status = PatchStatus::Applied;
    patch.applied_at = Some(now_ms());
    atomic_json(&path, &patch)?;
    let summary = patch.summary();
    sink.emit(ChangeEvent::PatchUpdated(summary.clone()));
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{
        project::ProjectState,
        service_error::{NoopSink, RecordingSink},
    };

    #[test]
    fn confinement_rejects_unsafe_paths_and_accepts_nested() {
        let dir = tempfile::tempdir().unwrap();
        for path in [
            r"C:\x",
            "/x",
            "../x",
            r"a\..\..\x",
            ".git/config",
            ".cairn/tasks/x.json",
            ".env",
            ".ENV.local",
            "server.PEM",
            "id_rsa.pub",
        ] {
            assert!(resolve_in_project(dir.path(), path).is_err(), "{path}");
        }
        assert!(resolve_in_project(dir.path(), "src/nested.rs").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn confinement_rejects_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        assert!(resolve_in_project(dir.path(), "escape/file.txt").is_err());
    }

    #[test]
    fn read_and_list_report_content_and_secret_omission() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.txt"), b"abcdef").unwrap();
        fs::write(dir.path().join(".env"), b"secret").unwrap();
        fs::write(dir.path().join(".cairn"), b"secret").unwrap();
        let read = read_file(dir.path(), "src/a.txt", Some(3)).unwrap();
        assert_eq!(read.text, "abc");
        assert!(read.truncated);
        assert_eq!(read.bytes, 6);
        assert_eq!(read.sha256, sha256(b"abcdef"));
        let mut names = list_files(dir.path(), "", None).unwrap();
        names.retain(|entry| entry.name == "src" || entry.name == ".env" || entry.name == ".cairn");
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn read_rejects_binary_and_oversize() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("binary.txt"), [b'a', 0, b'b']).unwrap();
        assert_eq!(
            read_file(dir.path(), "binary.txt", None).unwrap_err().code,
            ServiceErrorCode::Validation
        );
        fs::write(dir.path().join("large.txt"), vec![b'x'; 6 * 1024 * 1024]).unwrap();
        assert_eq!(
            read_file(dir.path(), "large.txt", None).unwrap_err().code,
            ServiceErrorCode::Validation
        );
    }

    #[test]
    fn list_caps_entries_and_omits_denied_names() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            ".git",
            ".cairn",
            ".env",
            ".ENV.local",
            "server.PEM",
            "id_rsa.pub",
        ] {
            fs::create_dir_all(dir.path().join(name)).ok();
        }
        for index in 0..4 {
            fs::write(dir.path().join(format!("file-{index}.txt")), b"x").unwrap();
        }
        let entries = list_files(dir.path(), "", Some(2)).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| !is_denied_name(&entry.name)));
        assert!(entries
            .iter()
            .all(|entry| entry.name != ".git" && entry.name != ".cairn"));
    }

    #[test]
    fn propose_two_edits_and_apply_create_modify() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("one.txt"), "alpha beta").unwrap();
        let state = ProjectState::default();
        state.open(dir.path(), NoopSink).unwrap();
        let project = state.services().unwrap();
        let task = project.tasks.get(
            &project
                .tasks
                .list()
                .unwrap()
                .records
                .first()
                .map(|item| item.id.clone())
                .unwrap_or_else(|| "missing".into()),
        );
        let task_id = if let Ok(task) = task {
            task.id
        } else {
            crate::types::task::TaskItem::new("task").id
        };
        let sink = RecordingSink::default();
        let patch = propose(
            project.as_ref(),
            "run-1",
            &task_id,
            &project.root.join(".cairn/runs/run-1"),
            vec![
                PatchEdit::Replace {
                    path: "one.txt".into(),
                    search: "alpha".into(),
                    replace: "gamma".into(),
                },
                PatchEdit::Replace {
                    path: "one.txt".into(),
                    search: "beta".into(),
                    replace: "delta".into(),
                },
                PatchEdit::Write {
                    path: "new.txt".into(),
                    content: "created".into(),
                },
            ],
            "Edit files",
            None,
            &sink,
        );
        let patch = match patch {
            Ok(patch) => patch,
            Err(_) => {
                let mut task = crate::types::task::TaskItem::new("task");
                task.id = task_id;
                let task = project.tasks.create(task).unwrap();
                propose(
                    project.as_ref(),
                    "run-1",
                    &task.id,
                    &project.root.join(".cairn/runs/run-1"),
                    vec![
                        PatchEdit::Replace {
                            path: "one.txt".into(),
                            search: "alpha".into(),
                            replace: "gamma".into(),
                        },
                        PatchEdit::Replace {
                            path: "one.txt".into(),
                            search: "beta".into(),
                            replace: "delta".into(),
                        },
                        PatchEdit::Write {
                            path: "new.txt".into(),
                            content: "created".into(),
                        },
                    ],
                    "Edit files",
                    None,
                    &sink,
                )
                .unwrap()
            }
        };
        assert_eq!(
            fs::read_to_string(dir.path().join("one.txt")).unwrap(),
            "alpha beta"
        );
        let summary = patch_apply(project.as_ref(), "run-1", &patch.id, &sink).unwrap();
        assert_eq!(summary.status, PatchStatus::Applied);
        assert_eq!(
            fs::read_to_string(dir.path().join("one.txt")).unwrap(),
            "gamma delta"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "created"
        );
    }

    fn test_project(root: &Path) -> (ProjectState, std::sync::Arc<ProjectServices>, String) {
        let state = ProjectState::default();
        state.open(root, NoopSink).unwrap();
        let project = state.services().unwrap();
        let mut task = crate::types::task::TaskItem::new("patch task");
        task.id = "patch-task".into();
        let task = project.tasks.create(task).unwrap();
        (state, project, task.id)
    }

    #[test]
    fn propose_validates_match_counts_limits_and_preserves_workspace() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("one.txt"), "one one").unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();

        let zero = propose(
            project.as_ref(),
            "run-1",
            &task_id,
            &project.root,
            vec![PatchEdit::Replace {
                path: "one.txt".into(),
                search: "missing".into(),
                replace: "x".into(),
            }],
            "zero",
            None,
            &sink,
        )
        .unwrap_err();
        assert_eq!(zero.code, ServiceErrorCode::Validation);
        assert!(zero.message.contains("0 times"));

        let two = propose(
            project.as_ref(),
            "run-1",
            &task_id,
            &project.root,
            vec![PatchEdit::Replace {
                path: "one.txt".into(),
                search: "one".into(),
                replace: "x".into(),
            }],
            "two",
            None,
            &sink,
        )
        .unwrap_err();
        assert_eq!(two.code, ServiceErrorCode::Validation);
        assert!(two.message.contains("2 times"));

        let too_many = vec![
            PatchEdit::Write {
                path: "many.txt".into(),
                content: "x".into(),
            };
            51
        ];
        assert_eq!(
            propose(
                project.as_ref(),
                "run-1",
                &task_id,
                &project.root,
                too_many,
                "many",
                None,
                &sink,
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::Validation
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("one.txt")).unwrap(),
            "one one"
        );
        assert!(!dir.path().join("many.txt").exists());
    }

    #[test]
    fn propose_enforces_distinct_file_and_after_size_limits() {
        let dir = tempfile::tempdir().unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();
        let edits = (0..21)
            .map(|index| PatchEdit::Write {
                path: format!("file-{index}.txt"),
                content: "x".into(),
            })
            .collect();
        assert_eq!(
            propose(
                project.as_ref(),
                "run-limit",
                &task_id,
                &project.root,
                edits,
                "distinct",
                None,
                &sink,
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::Validation
        );

        let result = propose(
            project.as_ref(),
            "run-limit",
            &task_id,
            &project.root,
            vec![PatchEdit::Write {
                path: "large.txt".into(),
                content: "x".repeat(MAX_PATCH_AFTER_BYTES + 1),
            }],
            "large",
            None,
            &sink,
        )
        .unwrap_err();
        assert_eq!(result.code, ServiceErrorCode::Validation);
        assert!(!dir.path().join("large.txt").exists());
    }

    #[test]
    fn propose_enforces_twenty_patch_limit_per_run() {
        let dir = tempfile::tempdir().unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();
        for index in 0..20 {
            propose(
                project.as_ref(),
                "run-20",
                &task_id,
                &project.root,
                vec![PatchEdit::Write {
                    path: format!("patch-{index}.txt"),
                    content: "x".into(),
                }],
                "limited",
                None,
                &sink,
            )
            .unwrap();
        }
        let error = propose(
            project.as_ref(),
            "run-20",
            &task_id,
            &project.root,
            vec![PatchEdit::Write {
                path: "patch-21.txt".into(),
                content: "x".into(),
            }],
            "limited",
            None,
            &sink,
        )
        .unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Validation);
        assert!(!dir.path().join("patch-21.txt").exists());
    }

    #[test]
    fn patch_apply_conflicts_when_create_file_appears_after_proposal() {
        let dir = tempfile::tempdir().unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();
        let patch = propose(
            project.as_ref(),
            "run-create-conflict",
            &task_id,
            &project.root,
            vec![PatchEdit::Write {
                path: "meanwhile.txt".into(),
                content: "proposed".into(),
            }],
            "create",
            None,
            &sink,
        )
        .unwrap();
        fs::write(dir.path().join("meanwhile.txt"), "created meanwhile").unwrap();
        let error =
            patch_apply(project.as_ref(), "run-create-conflict", &patch.id, &sink).unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::PatchConflict);
        assert_eq!(
            fs::read_to_string(dir.path().join("meanwhile.txt")).unwrap(),
            "created meanwhile"
        );
    }

    #[test]
    fn patch_apply_write_failure_rolls_back_already_written_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("first.txt"), "before").unwrap();
        fs::write(dir.path().join("blocking-file"), "block").unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();
        let patch = propose(
            project.as_ref(),
            "run-rollback",
            &task_id,
            &project.root,
            vec![
                PatchEdit::Write {
                    path: "first.txt".into(),
                    content: "after".into(),
                },
                PatchEdit::Write {
                    path: "blocking-file/child.txt".into(),
                    content: "child".into(),
                },
            ],
            "rollback",
            None,
            &sink,
        )
        .unwrap();
        let error = patch_apply(project.as_ref(), "run-rollback", &patch.id, &sink).unwrap_err();
        assert_eq!(error.code, ServiceErrorCode::Io);
        assert_eq!(
            fs::read_to_string(dir.path().join("first.txt")).unwrap(),
            "before"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("blocking-file")).unwrap(),
            "block"
        );
        assert!(!dir.path().join("blocking-file/child.txt").exists());
    }

    #[test]
    fn patch_apply_conflict_second_apply_discard_and_malformed_ids() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("changed.txt"), "before").unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();
        let patch = propose(
            project.as_ref(),
            "run-1",
            &task_id,
            &project.root,
            vec![
                PatchEdit::Write {
                    path: "changed.txt".into(),
                    content: "after".into(),
                },
                PatchEdit::Write {
                    path: "new.txt".into(),
                    content: "new".into(),
                },
            ],
            "conflict",
            None,
            &sink,
        )
        .unwrap();
        assert_eq!(patch.files[0].op, PatchOp::Modify,);
        assert_eq!(
            patch.files[0].base_sha256.as_deref(),
            Some(sha256(b"before").as_str())
        );

        fs::write(dir.path().join("changed.txt"), "different").unwrap();
        let conflict = patch_apply(project.as_ref(), "run-1", &patch.id, &sink).unwrap_err();
        assert_eq!(conflict.code, ServiceErrorCode::PatchConflict);
        assert_eq!(
            fs::read_to_string(dir.path().join("changed.txt")).unwrap(),
            "different"
        );
        assert!(!dir.path().join("new.txt").exists());

        fs::write(dir.path().join("changed.txt"), "before").unwrap();
        patch_apply(project.as_ref(), "run-1", &patch.id, &sink).unwrap();
        let second = patch_apply(project.as_ref(), "run-1", &patch.id, &sink).unwrap_err();
        assert_eq!(second.code, ServiceErrorCode::InvalidTransition);

        let discarded = propose(
            project.as_ref(),
            "run-2",
            &task_id,
            &project.root,
            vec![PatchEdit::Write {
                path: "discard.txt".into(),
                content: "discard".into(),
            }],
            "discard",
            None,
            &sink,
        )
        .unwrap();
        patch_discard(project.as_ref(), "run-2", &discarded.id, &sink).unwrap();
        assert_eq!(
            patch_discard(project.as_ref(), "run-2", &discarded.id, &sink)
                .unwrap_err()
                .code,
            ServiceErrorCode::InvalidTransition
        );
        assert!(patch_discard(project.as_ref(), "../bad", &discarded.id, &sink).is_err());
        assert!(patch_get(project.as_ref(), "bad/id", "patch").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_device_ads_and_trailing_characters_for_patch_paths() {
        let dir = tempfile::tempdir().unwrap();
        let (_state, project, task_id) = test_project(dir.path());
        let sink = RecordingSink::default();
        for path in [
            ".env.",
            ".env ",
            ".env::$DATA",
            ".env:x",
            "NUL",
            "con.txt",
            "a/NUL/b",
        ] {
            assert!(resolve_in_project(dir.path(), path).is_err(), "{path}");
            assert!(read_file(dir.path(), path, None).is_err(), "{path}");
            let names = list_files(dir.path(), "", None).unwrap();
            assert!(!names.iter().any(|entry| entry.name == path));
            let error = propose(
                project.as_ref(),
                "run-1",
                &task_id,
                &project.root,
                vec![PatchEdit::Write {
                    path: path.into(),
                    content: "secret".into(),
                }],
                "windows",
                None,
                &sink,
            )
            .unwrap_err();
            assert_eq!(error.code, ServiceErrorCode::Validation);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_confinement_rejects_outside_and_allows_inside() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.txt"), "outside").unwrap();
        let outside_link = dir.path().join("outside-link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&outside_link)
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(resolve_in_project(dir.path(), "outside-link/outside.txt").is_err());
        assert!(read_file(dir.path(), "outside-link/outside.txt", None).is_err());

        fs::create_dir_all(dir.path().join("src")).unwrap();
        let inside_link = dir.path().join("inside-link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&inside_link)
            .arg(dir.path().join("src"))
            .status();
        if let Ok(status) = status {
            if status.success() {
                fs::create_dir_all(dir.path().join("src")).unwrap();
                assert!(resolve_in_project(dir.path(), "inside-link/new.txt").is_ok());
            }
        }
    }
}
