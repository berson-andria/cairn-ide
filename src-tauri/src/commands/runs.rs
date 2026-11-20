use crate::services::{
    project::{ProjectState, TauriEventSink},
    runs::workflows::{WorkflowInfo, WorkflowInspection},
    runs::{RunManager, RunRecord},
    service_error::ServiceError,
};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn run_start(
    task_id: String,
    expected_rev: u64,
    workflow: Option<String>,
    app: AppHandle,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<RunRecord, ServiceError> {
    runs.run_start(
        &projects,
        task_id,
        expected_rev,
        workflow,
        Arc::new(TauriEventSink(app)),
    )
}

#[tauri::command]
pub async fn run_cancel(runs: State<'_, RunManager>) -> Result<(), ServiceError> {
    runs.run_cancel()
}

#[tauri::command]
pub async fn run_get(runs: State<'_, RunManager>) -> Result<Option<RunRecord>, ServiceError> {
    runs.run_get()
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
pub async fn workflow_list(
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<Vec<WorkflowInfo>, ServiceError> {
    runs.workflow_list(&projects)
}

#[tauri::command]
pub async fn workflow_inspect(
    name: String,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<WorkflowInspection, ServiceError> {
    runs.workflow_inspect(&projects, &name)
}

#[tauri::command]
pub async fn workflow_trust(
    name: String,
    hash: String,
    projects: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<(), ServiceError> {
    runs.workflow_trust(&projects, &name, &hash)
}
