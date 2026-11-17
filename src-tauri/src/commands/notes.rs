use crate::{
    services::{
        note_service::{NewNote, NotePatch as ServiceNotePatch},
        project::ProjectState,
        service_error::ServiceError,
        storage::ListReport,
    },
    types::note::{NoteAnchor, NoteItem, NoteStatus},
};
use serde::{Deserialize, Deserializer};
use tauri::State;
fn deserialize_some<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotePatch {
    pub content: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub r#type: Option<Option<String>>,
}
fn svc(
    s: &ProjectState,
) -> Result<std::sync::Arc<crate::services::project::ProjectServices>, ServiceError> {
    s.services()
}
pub fn note_list_impl(s: &ProjectState) -> Result<ListReport<NoteItem>, ServiceError> {
    svc(s)?.notes.list()
}
#[tauri::command]
pub fn note_list(state: State<'_, ProjectState>) -> Result<ListReport<NoteItem>, ServiceError> {
    note_list_impl(&state)
}
pub fn note_get_impl(s: &ProjectState, id: String) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.get(&id)
}
#[tauri::command]
pub fn note_get(id: String, state: State<'_, ProjectState>) -> Result<NoteItem, ServiceError> {
    note_get_impl(&state, id)
}
pub fn note_create_impl(s: &ProjectState, note: NewNote) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.create_input(note)
}
#[tauri::command]
pub fn note_create(
    note: NewNote,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_create_impl(&state, note)
}
pub fn note_update_impl(
    s: &ProjectState,
    id: String,
    patch: NotePatch,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.update(
        &id,
        ServiceNotePatch {
            content: patch.content,
            r#type: patch.r#type,
        },
        expected_rev,
    )
}
#[tauri::command]
pub fn note_update(
    id: String,
    patch: NotePatch,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_update_impl(&state, id, patch, expected_rev)
}
pub fn note_delete_impl(s: &ProjectState, id: String) -> Result<(), ServiceError> {
    svc(s)?.notes.delete(&id)
}
#[tauri::command]
pub fn note_delete(id: String, state: State<'_, ProjectState>) -> Result<(), ServiceError> {
    note_delete_impl(&state, id)
}
pub fn note_set_anchors_impl(
    s: &ProjectState,
    id: String,
    anchors: Vec<NoteAnchor>,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.set_anchors(&id, anchors, expected_rev)
}
#[tauri::command]
pub fn note_set_anchors(
    id: String,
    anchors: Vec<NoteAnchor>,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_set_anchors_impl(&state, id, anchors, expected_rev)
}
pub fn note_set_anchor_impl(
    s: &ProjectState,
    id: String,
    anchor: Option<NoteAnchor>,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.set_anchor(&id, anchor, expected_rev)
}
#[tauri::command]
pub fn note_set_anchor(
    id: String,
    anchor: Option<NoteAnchor>,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_set_anchor_impl(&state, id, anchor, expected_rev)
}
pub fn note_add_anchor_impl(
    s: &ProjectState,
    id: String,
    anchor: NoteAnchor,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.add_anchor(&id, anchor, expected_rev)
}
#[tauri::command]
pub fn note_add_anchor(
    id: String,
    anchor: NoteAnchor,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_add_anchor_impl(&state, id, anchor, expected_rev)
}
pub fn note_remove_anchor_impl(
    s: &ProjectState,
    id: String,
    index: usize,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.remove_anchor(&id, index, expected_rev)
}
#[tauri::command]
pub fn note_remove_anchor(
    id: String,
    index: usize,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_remove_anchor_impl(&state, id, index, expected_rev)
}
pub fn note_set_status_impl(
    s: &ProjectState,
    id: String,
    status: NoteStatus,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.set_status(&id, status, expected_rev)
}
#[tauri::command]
pub fn note_set_status(
    id: String,
    status: NoteStatus,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_set_status_impl(&state, id, status, expected_rev)
}
pub fn note_toggle_status_impl(
    s: &ProjectState,
    id: String,
    expected_rev: u64,
) -> Result<NoteItem, ServiceError> {
    svc(s)?.notes.toggle_status(&id, expected_rev)
}
#[tauri::command]
pub fn note_toggle_status(
    id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<NoteItem, ServiceError> {
    note_toggle_status_impl(&state, id, expected_rev)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{
        project::ProjectState,
        service_error::{RecordingSink, ServiceErrorCode},
    };
    use tempfile::tempdir;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NoteCreateArgs {
        note: NewNote,
    }

    #[test]
    fn documented_note_create_example_deserializes() {
        let create: NoteCreateArgs =
            serde_json::from_str(r#"{"note":{"content":"Check API behavior","anchors":[]}}"#)
                .unwrap();
        assert_eq!(create.note.content, "Check API behavior");
        assert!(create.note.anchors.is_empty());
    }
    #[test]
    fn new_note_defaults_anchors_and_rejects_metadata() {
        let note: NewNote = serde_json::from_str(r#"{"content":"new"}"#).unwrap();
        assert!(note.anchors.is_empty());
        for json in [
            r#"{"content":"n","id":"caller-id"}"#,
            r#"{"content":"n","status":"completed"}"#,
            r#"{"content":"n","unknown":true}"#,
        ] {
            assert!(serde_json::from_str::<NewNote>(json).is_err());
        }
        assert!(serde_json::from_str::<NotePatch>(r#"{"unknown":true}"#).is_err());
    }
    #[test]
    fn absent_and_no_project() {
        let s = ProjectState::default();
        assert_eq!(
            note_list_impl(&s).unwrap_err().code,
            ServiceErrorCode::NoProject
        );
        let d = tempdir().unwrap();
        s.open(d.path(), RecordingSink::default()).unwrap();
        let n = note_create_impl(
            &s,
            NewNote {
                content: "n".into(),
                r#type: None,
                anchors: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            note_set_status_impl(&s, n.id.clone(), NoteStatus::Completed, n.rev + 1)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
    }
}
