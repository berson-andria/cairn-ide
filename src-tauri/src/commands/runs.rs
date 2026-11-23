use crate::services::{
    models::Registry,
    project::{ProjectState, TauriEventSink},
    runs::workflows::{WorkflowCreated, WorkflowStatus, WorkflowTemplate, WorkflowTrustStatus},
    runs::{RunManager, RunRecord},
    service_error::ServiceError,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn run_start(
    task_id: String,
    expected_rev: u64,
    app: AppHandle,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<RunRecord, ServiceError> {
    let registry = match app.path().app_data_dir() {
        Ok(directory) => Registry::load(&directory),
        Err(error) => {
            tauri_plugin_log::log::warn!("Could not locate user settings directory: {error}");
            Registry::default()
        }
    };
    runs.run_start_with_registry(
        &projects,
        task_id,
        expected_rev,
        Arc::new(registry),
        Arc::new(TauriEventSink(app)),
    )
}

#[tauri::command]
pub async fn run_cancel(runs: State<'_, RunManager>) -> Result<(), ServiceError> {
    runs.run_cancel()
}

#[tauri::command]
pub async fn run_get(
    run_id: Option<String>,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<Option<RunRecord>, ServiceError> {
    match run_id {
        Some(run_id) => runs.run_get_by_id(&projects, &run_id).map(Some),
        None => runs.run_get(),
    }
}

#[tauri::command]
pub async fn run_list(
    limit: u32,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<Vec<RunRecord>, ServiceError> {
    runs.run_list(&projects, limit)
}

#[tauri::command]
pub async fn run_log(
    run_id: String,
    max_lines: u32,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<Vec<String>, ServiceError> {
    runs.run_log(&projects, &run_id, max_lines)
}

#[tauri::command]
pub async fn workflow_status(
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<WorkflowStatus, ServiceError> {
    runs.workflow_status(&projects)
}

#[tauri::command]
pub async fn workflow_templates(
    runs: State<'_, RunManager>,
) -> Result<Vec<WorkflowTemplate>, ServiceError> {
    runs.workflow_templates()
}

#[tauri::command]
pub async fn workflow_create(
    scope: String,
    template: String,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<WorkflowCreated, ServiceError> {
    runs.workflow_create(&projects, &scope, &template)
}

#[tauri::command]
pub async fn workspace_trust_status(
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<WorkflowTrustStatus, ServiceError> {
    runs.workspace_trust_status(&projects)
}

#[tauri::command]
pub async fn workspace_trust(
    hash: String,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<(), ServiceError> {
    runs.workspace_trust(&projects, &hash)
}

#[tauri::command]
pub async fn workspace_trust_revoke(
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<(), ServiceError> {
    runs.workspace_trust_revoke(&projects)
}

#[tauri::command]
pub async fn patch_list(
    run_id: Option<String>,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<Vec<crate::services::runs::files::PatchSummary>, ServiceError> {
    runs.patch_list(&projects, run_id.as_deref())
}

#[tauri::command]
pub async fn patch_get(
    run_id: String,
    patch_id: String,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<crate::services::runs::files::Patch, ServiceError> {
    runs.patch_get(&projects, &run_id, &patch_id)
}

#[tauri::command]
pub async fn patch_discard(
    run_id: String,
    patch_id: String,
    app: AppHandle,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<crate::services::runs::files::PatchSummary, ServiceError> {
    runs.patch_discard(&projects, &run_id, &patch_id, Arc::new(TauriEventSink(app)))
}

#[tauri::command]
pub async fn patch_apply(
    run_id: String,
    patch_id: String,
    app: AppHandle,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<crate::services::runs::files::PatchSummary, ServiceError> {
    runs.patch_apply(&projects, &run_id, &patch_id, Arc::new(TauriEventSink(app)))
}
