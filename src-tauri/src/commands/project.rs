use crate::services::{
    project::{ProjectState, TauriEventSink},
    runs::RunManager,
    service_error::ServiceError,
    session_history::{self, HistorySnapshot},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub new_window: bool,
}

#[tauri::command]
pub fn launch_args() -> LaunchArgs {
    let mut args = std::env::args_os().skip(1);
    let mut folder = None;
    let mut new_window = false;
    while let Some(arg) = args.next() {
        if arg == "--new-window" {
            new_window = true;
        } else if arg == "--folder" {
            folder = args
                .next()
                .map(|value| value.to_string_lossy().into_owned());
        }
    }
    LaunchArgs { folder, new_window }
}

#[tauri::command]
pub fn window_new(folder: Option<String>) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg("--new-window")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(folder) = folder {
        command.args(["--folder", &folder]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_open(
    path: String,
    app: AppHandle,
    state: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<String, ServiceError> {
    runs.cancel_for_project_change("project closed")?;
    let opened = project_open_impl(&state, path, TauriEventSink(app.clone()))?;
    let data_dir = app.path().app_data_dir().map_err(|error| {
        ServiceError::new(
            crate::services::service_error::ServiceErrorCode::Io,
            error.to_string(),
        )
    })?;
    session_history::record_open(&data_dir, &PathBuf::from(&opened)).map_err(|error| {
        ServiceError::new(
            crate::services::service_error::ServiceErrorCode::Io,
            error.to_string(),
        )
    })?;
    Ok(opened)
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
    app: AppHandle,
    state: State<'_, ProjectState>,
    runs: State<'_, RunManager>,
) -> Result<(), ServiceError> {
    runs.cancel_for_project_change("project closed")?;
    let root = state.root_path()?;
    project_close_impl(&state)?;
    if let Some(root) = root {
        let data_dir = app.path().app_data_dir().map_err(|error| {
            ServiceError::new(
                crate::services::service_error::ServiceErrorCode::Io,
                error.to_string(),
            )
        })?;
        session_history::clear_last_project(&data_dir, &root).map_err(|error| {
            ServiceError::new(
                crate::services::service_error::ServiceErrorCode::Io,
                error.to_string(),
            )
        })?;
    }
    Ok(())
}
pub fn project_close_impl(state: &ProjectState) -> Result<(), ServiceError> {
    state.close()
}

#[tauri::command]
pub fn project_history(app: AppHandle) -> Result<HistorySnapshot, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(session_history::snapshot(&data_dir))
}

#[tauri::command]
pub fn project_history_remove(path: String, app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    session_history::remove_project(&data_dir, &path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn project_history_clear(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    session_history::clear_projects(&data_dir).map_err(|error| error.to_string())
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
