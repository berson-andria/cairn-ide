use crate::{
    services::{
        project::ProjectState,
        service_error::{Actor, ServiceError},
        storage::ListReport,
        task_service::NewTask,
    },
    types::{proposal::Proposal, task::TaskItem},
};
use tauri::State;

fn service(
    state: &ProjectState,
) -> Result<std::sync::Arc<crate::services::project::ProjectServices>, ServiceError> {
    state.services()
}

#[tauri::command]
pub async fn proposal_list(
    state: State<'_, ProjectState>,
) -> Result<ListReport<Proposal>, ServiceError> {
    service(&state)?.proposals.list()
}

#[tauri::command]
pub async fn proposal_accept(
    id: String,
    expected_rev: u64,
    task: Option<NewTask>,
    state: State<'_, ProjectState>,
) -> Result<(Proposal, TaskItem), ServiceError> {
    service(&state)?
        .proposals
        .accept(Actor::Ui, &id, expected_rev, task)
}

#[tauri::command]
pub async fn proposal_reject(
    id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<Proposal, ServiceError> {
    service(&state)?
        .proposals
        .reject(Actor::Ui, &id, expected_rev)
}

#[tauri::command]
pub async fn proposal_delete(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<(), ServiceError> {
    service(&state)?.proposals.delete(Actor::Ui, &id)
}
