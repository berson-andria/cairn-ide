use crate::services::{
    project::{ProjectState, TauriEventSink},
    runs::RunManager,
    service_error::ServiceError,
};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn project_open(
    path: String,
    app: AppHandle,
    state: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<String, ServiceError> {
    runs.cancel_for_project_change("project closed")?;
    project_open_impl(&state, path, TauriEventSink(app))
}
pub fn project_open_impl(
    state: &ProjectState,
    path: String,
    sink: impl crate::services::service_error::EventSink + 'static,
) -> Result<String, ServiceError> {
    state
        .open(path, sink)
        .map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn project_close(
    state: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<(), ServiceError> {
    runs.cancel_for_project_change("project closed")?;
    project_close_impl(&state)
}
pub fn project_close_impl(state: &ProjectState) -> Result<(), ServiceError> {
    state.close()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{
        project::ProjectState,
        service_error::{RecordingSink, ServiceErrorCode},
    };
    use crate::types::task::TaskItem;
    use tempfile::tempdir;
    #[test]
    fn invalid_project_paths_are_validation() {
        let state = ProjectState::default();
        let d = tempdir().unwrap();
        assert_eq!(
            project_open_impl(
                &state,
                d.path().join("missing").to_string_lossy().into_owned(),
                RecordingSink::default()
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::Validation
        );
        let f = d.path().join("file");
        std::fs::write(&f, "").unwrap();
        assert_eq!(
            project_open_impl(
                &state,
                f.to_string_lossy().into_owned(),
                RecordingSink::default()
            )
            .unwrap_err()
            .code,
            ServiceErrorCode::Validation
        );
    }
    #[test]
    fn open_switches_project_and_writes_only_new_root() {
        let state = ProjectState::default();
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        project_open_impl(
            &state,
            a.path().to_string_lossy().into_owned(),
            RecordingSink::default(),
        )
        .unwrap();
        let old = state
            .services()
            .unwrap()
            .tasks
            .create(TaskItem::new("old"))
            .unwrap();
        project_open_impl(
            &state,
            b.path().to_string_lossy().into_owned(),
            RecordingSink::default(),
        )
        .unwrap();
        state
            .services()
            .unwrap()
            .tasks
            .create(TaskItem::new("new"))
            .unwrap();
        assert!(a
            .path()
            .join(format!(".cairn/tasks/{}.json", old.id))
            .exists());
        assert_eq!(
            std::fs::read_dir(b.path().join(".cairn/tasks"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn project_open_returns_plain_canonical_path() {
        let state = ProjectState::default();
        let dir = tempdir().unwrap();
        let returned = project_open_impl(
            &state,
            dir.path().to_string_lossy().into_owned(),
            RecordingSink::default(),
        )
        .unwrap();
        assert_eq!(returned, state.services().unwrap().root.to_string_lossy());
        assert!(!returned.starts_with(r"\\?\"));
    }
}
