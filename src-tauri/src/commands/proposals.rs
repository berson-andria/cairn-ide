use crate::{
    services::{
        project::ProjectState,
        proposal_service::{AcceptResult, SourceAction},
        service_error::{Actor, ServiceError},
        storage::ListReport,
    },
    types::proposal::{Proposal, ProposalPayload},
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
    payload: Option<ProposalPayload>,
    source_action: Option<SourceAction>,
    state: State<'_, ProjectState>,
) -> Result<AcceptResult, ServiceError> {
    service(&state)?.proposals.accept_with_options(
        Actor::Ui,
        &id,
        expected_rev,
        payload,
        source_action,
    )
}

#[tauri::command]
pub async fn proposal_mark_seen(
    ids: Vec<String>,
    state: State<'_, ProjectState>,
) -> Result<Vec<Proposal>, ServiceError> {
    service(&state)?.proposals.mark_seen(Actor::Ui, &ids)
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
