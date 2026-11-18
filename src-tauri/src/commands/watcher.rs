use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::services::watcher::WorkspaceWatcher;

#[tauri::command]
pub async fn watch_start(
    path: String,
    app: AppHandle,
    watcher: State<'_, WorkspaceWatcher>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("workspace watcher path must be absolute".into());
    }
    watcher.start(path, app);
    Ok(())
}

#[tauri::command]
pub async fn watch_stop(watcher: State<'_, WorkspaceWatcher>) -> Result<(), String> {
    watcher.stop();
    Ok(())
}
