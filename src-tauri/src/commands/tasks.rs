use crate::{
    services::{
        project::ProjectState,
        service_error::{Actor, ServiceError},
        storage::ListReport,
        task_service::{NewSubTask, NewTask, SubTaskPatch, TaskPatch as ServiceTaskPatch},
    },
    types::task::{FileAnchor, TaskItem, TaskStatus},
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
pub struct TaskPatch {
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub description: Option<Option<String>>,
}
fn svc(
    s: &ProjectState,
) -> Result<std::sync::Arc<crate::services::project::ProjectServices>, ServiceError> {
    s.services()
}
pub fn task_list_impl(s: &ProjectState) -> Result<ListReport<TaskItem>, ServiceError> {
    svc(s)?.tasks.list()
}
#[tauri::command]
pub fn task_list(state: State<'_, ProjectState>) -> Result<ListReport<TaskItem>, ServiceError> {
    task_list_impl(&state)
}
pub fn task_get_impl(s: &ProjectState, id: String) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.get(&id)
}
#[tauri::command]
pub fn task_get(id: String, state: State<'_, ProjectState>) -> Result<TaskItem, ServiceError> {
    task_get_impl(&state, id)
}
pub fn task_create_impl(s: &ProjectState, task: NewTask) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.create_input(task)
}
#[tauri::command]
pub fn task_create(
    task: NewTask,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_create_impl(&state, task)
}
pub fn task_update_impl(
    s: &ProjectState,
    id: String,
    patch: TaskPatch,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.update(
        &id,
        ServiceTaskPatch {
            title: patch.title,
            description: patch.description,
        },
        expected_rev,
    )
}
#[tauri::command]
pub fn task_update(
    id: String,
    patch: TaskPatch,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_update_impl(&state, id, patch, expected_rev)
}
pub fn task_delete_impl(s: &ProjectState, id: String) -> Result<(), ServiceError> {
    svc(s)?.tasks.delete(&id)
}
#[tauri::command]
pub fn task_delete(id: String, state: State<'_, ProjectState>) -> Result<(), ServiceError> {
    task_delete_impl(&state, id)
}
pub fn task_set_status_impl(
    s: &ProjectState,
    id: String,
    status: TaskStatus,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?
        .tasks
        .set_status(&id, status, expected_rev, Actor::Ui)
}
#[tauri::command]
pub fn task_set_status(
    id: String,
    status: TaskStatus,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_set_status_impl(&state, id, status, expected_rev)
}
pub fn task_start_impl(
    s: &ProjectState,
    id: String,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.start(&id, expected_rev, Actor::Ui)
}
#[tauri::command]
pub fn task_start(
    id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_start_impl(&state, id, expected_rev)
}
pub fn task_complete_impl(
    s: &ProjectState,
    id: String,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.complete(&id, expected_rev)
}
#[tauri::command]
pub fn task_complete(
    id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_complete_impl(&state, id, expected_rev)
}
pub fn task_set_dependency_impl(
    s: &ProjectState,
    id: String,
    depends_on: Option<String>,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.set_dependency(&id, depends_on, expected_rev)
}
#[tauri::command]
pub fn task_set_dependency(
    id: String,
    depends_on: Option<String>,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_set_dependency_impl(&state, id, depends_on, expected_rev)
}
pub fn task_set_anchor_impl(
    s: &ProjectState,
    id: String,
    anchor: Option<FileAnchor>,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.set_anchor(&id, anchor, expected_rev)
}
#[tauri::command]
pub fn task_set_anchor(
    id: String,
    anchor: Option<FileAnchor>,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_set_anchor_impl(&state, id, anchor, expected_rev)
}
pub fn task_link_note_impl(
    s: &ProjectState,
    id: String,
    note_id: String,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.link_note(&id, &note_id, expected_rev)
}
#[tauri::command]
pub fn task_link_note(
    id: String,
    note_id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_link_note_impl(&state, id, note_id, expected_rev)
}
pub fn task_unlink_note_impl(
    s: &ProjectState,
    id: String,
    note_id: String,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.unlink_note(&id, &note_id, expected_rev)
}
#[tauri::command]
pub fn task_unlink_note(
    id: String,
    note_id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_unlink_note_impl(&state, id, note_id, expected_rev)
}
pub fn task_get_dependent_tasks_impl(
    s: &ProjectState,
    id: String,
) -> Result<Vec<TaskItem>, ServiceError> {
    svc(s)?.tasks.get_dependent_tasks(&id)
}
#[tauri::command]
pub fn task_get_dependent_tasks(
    id: String,
    state: State<'_, ProjectState>,
) -> Result<Vec<TaskItem>, ServiceError> {
    task_get_dependent_tasks_impl(&state, id)
}
pub fn task_can_start_impl(s: &ProjectState, id: String) -> Result<bool, ServiceError> {
    svc(s)?.tasks.can_start(&id)
}
#[tauri::command]
pub fn task_can_start(id: String, state: State<'_, ProjectState>) -> Result<bool, ServiceError> {
    task_can_start_impl(&state, id)
}
pub fn task_set_acceptance_criteria_impl(
    s: &ProjectState,
    id: String,
    criteria: Option<String>,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?
        .tasks
        .set_acceptance_criteria(&id, criteria, expected_rev)
}
#[tauri::command]
pub fn task_set_acceptance_criteria(
    id: String,
    criteria: Option<String>,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_set_acceptance_criteria_impl(&state, id, criteria, expected_rev)
}
pub fn task_set_branch_impl(
    s: &ProjectState,
    id: String,
    branch: Option<String>,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.set_branch(&id, branch, expected_rev)
}
#[tauri::command]
pub fn task_set_branch(
    id: String,
    branch: Option<String>,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_set_branch_impl(&state, id, branch, expected_rev)
}
pub fn task_add_subtask_impl(
    s: &ProjectState,
    id: String,
    subtask: NewSubTask,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.add_new_subtask(&id, subtask, expected_rev)
}
#[tauri::command]
pub fn task_add_subtask(
    id: String,
    subtask: NewSubTask,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_add_subtask_impl(&state, id, subtask, expected_rev)
}
pub fn task_update_subtask_impl(
    s: &ProjectState,
    id: String,
    sub_id: String,
    patch: SubTaskPatch,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?
        .tasks
        .patch_subtask(&id, &sub_id, patch, expected_rev, Actor::Ui)
}
#[tauri::command]
pub fn task_update_subtask(
    id: String,
    sub_id: String,
    patch: SubTaskPatch,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_update_subtask_impl(&state, id, sub_id, patch, expected_rev)
}
pub fn task_delete_subtask_impl(
    s: &ProjectState,
    id: String,
    sub_id: String,
    expected_rev: u64,
) -> Result<TaskItem, ServiceError> {
    svc(s)?.tasks.delete_subtask(&id, &sub_id, expected_rev)
}
#[tauri::command]
pub fn task_delete_subtask(
    id: String,
    sub_id: String,
    expected_rev: u64,
    state: State<'_, ProjectState>,
) -> Result<TaskItem, ServiceError> {
    task_delete_subtask_impl(&state, id, sub_id, expected_rev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        services::task_service::NewTask,
        services::{
            project::ProjectState,
            service_error::{RecordingSink, ServiceErrorCode},
        },
        types::task::TaskStatus,
    };
    use tempfile::tempdir;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TaskCreateArgs {
        task: NewTask,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TaskUpdateArgs {
        id: String,
        patch: TaskPatch,
        expected_rev: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TaskAddSubtaskArgs {
        id: String,
        subtask: NewSubTask,
        expected_rev: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TaskSubTaskPatchArgs {
        id: String,
        sub_id: String,
        patch: SubTaskPatch,
        expected_rev: u64,
    }

    #[test]
    fn documented_task_examples_deserialize() {
        let create: TaskCreateArgs = serde_json::from_str(r#"{"task":{"title":"Write migration","description":null,"subTasks":[{"title":"Add tests"}]}}"#).unwrap();
        assert_eq!(create.task.title, "Write migration");
        assert_eq!(create.task.description, None);
        assert_eq!(create.task.sub_tasks.unwrap()[0].title, "Add tests");
        let update: TaskUpdateArgs =
            serde_json::from_str(r#"{"id":"task-1","patch":{"description":null},"expectedRev":2}"#)
                .unwrap();
        assert_eq!(update.id, "task-1");
        assert_eq!(update.expected_rev, 2);
        assert_eq!(update.patch.description, Some(None));
        let subtask: TaskAddSubtaskArgs = serde_json::from_str(
            r#"{"id":"task-1","subtask":{"title":"Add tests"},"expectedRev":2}"#,
        )
        .unwrap();
        assert_eq!(subtask.id, "task-1");
        assert_eq!(subtask.subtask.title, "Add tests");
        assert_eq!(subtask.expected_rev, 2);
        let patch: TaskSubTaskPatchArgs = serde_json::from_str(r#"{"id":"task-1","subId":"sub-1","patch":{"description":null,"status":"completed"},"expectedRev":3}"#).unwrap();
        assert_eq!(patch.id, "task-1");
        assert_eq!(patch.sub_id, "sub-1");
        assert_eq!(patch.patch.description, Some(None));
        assert_eq!(patch.patch.status, Some(TaskStatus::Completed));
    }
    fn new_task(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            description: None,
            anchor: None,
            linked_note_ids: None,
            sub_tasks: None,
            depends_on: None,
            acceptance_criteria: None,
            branch: None,
        }
    }
    #[test]
    fn new_task_rejects_generated_and_unknown_fields() {
        for (field, value) in [
            ("id", r#""caller-id""#),
            ("status", r#""running""#),
            ("createdAt", "1"),
            ("schemaVersion", "1"),
            ("rev", "1"),
            ("runs", r#"["run-1"]"#),
            ("unknown", "true"),
        ] {
            let body = format!(r#"{{"title":"task","{field}":{value}}}"#);
            assert!(
                serde_json::from_str::<NewTask>(&body).is_err(),
                "accepted {field}"
            );
        }
    }
    #[test]
    fn task_creation_generates_identity_revision_and_status() {
        let s = ProjectState::default();
        let dir = tempdir().unwrap();
        s.open(dir.path(), RecordingSink::default()).unwrap();
        let created = task_create_impl(&s, new_task("created")).unwrap();
        assert!(uuid::Uuid::parse_str(&created.id).is_ok());
        assert_eq!(created.rev, 1);
        assert!(matches!(
            created.status,
            TaskStatus::Ready | TaskStatus::Blocked
        ));
    }
    #[test]
    fn task_and_subtask_patches_reject_unrecognized_fields() {
        for json in [
            r#"{"title":"x","id":"bad"}"#,
            r#"{"title":"x","createdAt":1}"#,
        ] {
            assert!(serde_json::from_str::<SubTaskPatch>(json).is_err());
        }
        assert!(serde_json::from_str::<TaskPatch>(r#"{"unknown":true}"#).is_err());
        assert!(serde_json::from_str::<TaskPatch>(r#"{"runs":["run-1"]}"#).is_err());
        assert!(
            serde_json::from_str::<crate::types::proposal::BatchTaskItem>(
                r#"{"key":"k","title":"x","runs":["run-1"]}"#
            )
            .is_err()
        );
    }
    #[test]
    fn new_subtask_rejects_record_metadata() {
        assert!(serde_json::from_str::<NewSubTask>(r#"{"title":"s","id":"caller-id"}"#).is_err());
        assert!(serde_json::from_str::<NewSubTask>(r#"{"title":"s","createdAt":1}"#).is_err());
    }
    #[test]
    fn every_impl_requires_project_and_ui_actor_is_used() {
        let s = ProjectState::default();
        assert_eq!(
            task_list_impl(&s).unwrap_err().code,
            ServiceErrorCode::NoProject
        );
        let d = tempdir().unwrap();
        s.open(d.path(), RecordingSink::default()).unwrap();
        let task = task_create_impl(&s, new_task("t")).unwrap();
        let task = s
            .services()
            .unwrap()
            .tasks
            .set_status(&task.id, TaskStatus::Running, task.rev, Actor::System)
            .unwrap();
        assert_eq!(
            task_set_status_impl(&s, task.id.clone(), TaskStatus::NeedsReview, task.rev)
                .unwrap_err()
                .code,
            ServiceErrorCode::Forbidden
        );
        assert_eq!(
            task_complete_impl(&s, "missing".into(), 1)
                .unwrap_err()
                .code,
            ServiceErrorCode::NotFound
        );
        let ready = task_create_impl(&s, new_task("r")).unwrap();
        assert_eq!(
            task_set_status_impl(&s, ready.id.clone(), TaskStatus::Running, ready.rev + 1)
                .unwrap_err()
                .code,
            ServiceErrorCode::StaleRev
        );
    }
    #[test]
    fn absent_null_and_string_description_patch() {
        let absent: TaskPatch = serde_json::from_str("{}").unwrap();
        let null: TaskPatch = serde_json::from_str(r#"{"description":null}"#).unwrap();
        let string: TaskPatch = serde_json::from_str(r#"{"description":"x"}"#).unwrap();
        assert_eq!(absent.description, None);
        assert_eq!(null.description, Some(None));
        assert_eq!(string.description, Some(Some("x".into())));
    }
}
