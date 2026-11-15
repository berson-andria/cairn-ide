use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::services::codemap::{languages, CodeMapService};
use crate::types::codemap::{IndexProgress, IndexStats, Link, MissingLanguage, Symbol, TreeNode};

type Shared = Arc<Mutex<CodeMapService>>;

/// The workspace whose code map is open. Empty until `codemap_open` is called.
#[derive(Default)]
pub struct CodeMapState(Mutex<Option<Shared>>);

fn current(state: &State<'_, CodeMapState>) -> Result<Shared, String> {
    state
        .0
        .lock()
        .map_err(|_| "code map state is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "no workspace is open in the code map".to_string())
}

/// Locks the service and runs `f` on it.
fn with<T>(
    service: &Shared,
    f: impl FnOnce(&mut CodeMapService) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = service
        .lock()
        .map_err(|_| "code map is poisoned".to_string())?;
    f(&mut guard)
}

/// Runs blocking work (parsing, disk, network) off the async workers.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())?
}

/// Opens a workspace and indexes it (only new or changed files are parsed). Progress streams on the channel.
/// Language parsers are kept in the app-data folder, shared by every project.
#[tauri::command]
pub async fn codemap_open(
    root: String,
    on_progress: Channel<IndexProgress>,
    app: AppHandle,
    state: State<'_, CodeMapState>,
) -> Result<IndexStats, String> {
    let grammars = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("grammars");
    let (service, stats) = blocking(move || {
        languages::set_cache_dir(grammars)?;
        let mut service = CodeMapService::open(root)?;
        let stats = service.index_workspace(&|p| {
            let _ = on_progress.send(p);
        })?;
        Ok((Arc::new(Mutex::new(service)), stats))
    })
    .await?;
    *state
        .0
        .lock()
        .map_err(|_| "code map state is poisoned".to_string())? = Some(service);
    Ok(stats)
}

#[tauri::command]
pub async fn codemap_close(state: State<'_, CodeMapState>) -> Result<(), String> {
    *state
        .0
        .lock()
        .map_err(|_| "code map state is poisoned".to_string())? = None;
    Ok(())
}

/// Languages found in the workspace whose parser is not installed (nothing is downloaded by asking).
#[tauri::command]
pub async fn codemap_missing_languages(
    state: State<'_, CodeMapState>,
) -> Result<Vec<MissingLanguage>, String> {
    let service = current(&state)?;
    with(&service, |s| s.missing_languages())
}

/// Downloads the parsers for `names` (call this only after the user agreed), then parses the files waiting for them.
#[tauri::command]
pub async fn codemap_install_languages(
    names: Vec<String>,
    state: State<'_, CodeMapState>,
) -> Result<IndexStats, String> {
    let service = current(&state)?;
    blocking(move || {
        // the download happens outside the service lock, so the rest of the code map stays usable meanwhile
        languages::install(&names)?;
        with(&service, |s| s.reindex_languages(&names))
    })
    .await
}

/// Paths the file watcher reported (created, changed, removed; files or folders).
#[tauri::command]
pub async fn codemap_update_files(
    paths: Vec<String>,
    state: State<'_, CodeMapState>,
) -> Result<IndexStats, String> {
    let service = current(&state)?;
    blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        with(&service, |s| s.update_files(&paths))
    })
    .await
}

#[tauri::command]
pub async fn codemap_tree(state: State<'_, CodeMapState>) -> Result<TreeNode, String> {
    let service = current(&state)?;
    with(&service, |s| s.tree())
}

#[tauri::command]
pub async fn codemap_symbols_in_file(
    file: String,
    state: State<'_, CodeMapState>,
) -> Result<Vec<Symbol>, String> {
    let service = current(&state)?;
    with(&service, |s| s.symbols_in_file(&file))
}

#[tauri::command]
pub async fn codemap_callers(
    id: String,
    state: State<'_, CodeMapState>,
) -> Result<Vec<Link>, String> {
    let service = current(&state)?;
    with(&service, |s| s.callers_of(&id))
}

#[tauri::command]
pub async fn codemap_callees(
    id: String,
    state: State<'_, CodeMapState>,
) -> Result<Vec<Link>, String> {
    let service = current(&state)?;
    with(&service, |s| s.callees_of(&id))
}

#[tauri::command]
pub async fn codemap_search(
    query: String,
    limit: Option<usize>,
    state: State<'_, CodeMapState>,
) -> Result<Vec<Symbol>, String> {
    let service = current(&state)?;
    with(&service, |s| s.search(&query, limit.unwrap_or(50)))
}

/// The exact source text of one function, read from disk.
#[tauri::command]
pub async fn codemap_symbol_source(
    id: String,
    state: State<'_, CodeMapState>,
) -> Result<String, String> {
    let service = current(&state)?;
    blocking(move || {
        with(&service, |s| {
            let symbol = s.symbol(&id)?.ok_or("unknown symbol")?;
            s.symbol_source(&symbol)
        })
    })
    .await
}
