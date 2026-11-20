use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::Manager;

mod commands;
mod services;
mod types;

/// True when this process was started by git or ssh as their askpass program (see commands/askpass.rs).
pub fn is_askpass_helper() -> bool {
    commands::askpass::is_helper()
}

/// Answers one git / ssh question through the running app, then exits. No window, no Tauri.
pub fn run_askpass_helper() -> ExitCode {
    commands::askpass::run_helper()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(commands::fs::SearchCancellation(Arc::new(AtomicBool::new(
            false,
        ))))
        .manage(commands::lsp::LspState::default())
        .manage(commands::pty::PtyState::default())
        .manage(commands::codemap::CodeMapState::default())
        .manage(services::watcher::WorkspaceWatcher::default())
        .manage(services::project::ProjectState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir().ok();
            app.manage(services::runs::RunManager::with_resource_dir(resource_dir));
            app.state::<services::watcher::WorkspaceWatcher>()
                .subscribe(move |root, paths| {
                    handle
                        .state::<services::project::ProjectState>()
                        .reload_changed(&root, &paths);
                });
            // Local server that git / ssh questions (password, passphrase, host key) are sent to.
            app.manage(commands::askpass::Askpass::start(app.handle().clone())?);
            Ok(())
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Trace)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_directory_content,
            commands::fs::get_files,
            commands::fs::read_text_file,
            commands::fs::create_fs_node,
            commands::fs::workspace_search,
            commands::search::global_search,
            commands::search::search_files,
            commands::git::git_run,
            commands::askpass::askpass_answer,
            commands::lsp::lsp_start,
            commands::lsp::lsp_send,
            commands::lsp::lsp_stop,
            commands::secrets::secret_set,
            commands::secrets::secret_get,
            commands::secrets::secret_delete,
            commands::models::model_test_local,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::codemap::codemap_open,
            commands::watcher::watch_start,
            commands::watcher::watch_stop,
            commands::project::project_open,
            commands::project::project_close,
            commands::proposals::proposal_list,
            commands::proposals::proposal_accept,
            commands::proposals::proposal_mark_seen,
            commands::proposals::proposal_reject,
            commands::proposals::proposal_delete,
            commands::runs::run_start,
            commands::runs::run_cancel,
            commands::runs::run_get,
            commands::runs::run_list,
            commands::runs::run_log,
            commands::runs::workflow_list,
            commands::runs::workflow_inspect,
            commands::runs::workflow_trust,
            commands::tasks::task_list,
            commands::tasks::task_get,
            commands::tasks::task_create,
            commands::tasks::task_update,
            commands::tasks::task_delete,
            commands::tasks::task_set_status,
            commands::tasks::task_start,
            commands::tasks::task_complete,
            commands::tasks::task_set_dependency,
            commands::tasks::task_set_anchor,
            commands::tasks::task_link_note,
            commands::tasks::task_unlink_note,
            commands::tasks::task_get_dependent_tasks,
            commands::tasks::task_can_start,
            commands::tasks::task_set_acceptance_criteria,
            commands::tasks::task_set_branch,
            commands::tasks::task_add_subtask,
            commands::tasks::task_update_subtask,
            commands::tasks::task_delete_subtask,
            commands::notes::note_list,
            commands::notes::note_get,
            commands::notes::note_create,
            commands::notes::note_update,
            commands::notes::note_delete,
            commands::notes::note_set_anchors,
            commands::notes::note_set_anchor,
            commands::notes::note_add_anchor,
            commands::notes::note_remove_anchor,
            commands::notes::note_set_status,
            commands::notes::note_toggle_status,
            commands::codemap::codemap_close,
            commands::codemap::codemap_update_files,
            commands::codemap::codemap_tree,
            commands::codemap::codemap_symbols_in_file,
            commands::codemap::codemap_callers,
            commands::codemap::codemap_callees,
            commands::codemap::codemap_search,
            commands::codemap::codemap_symbol_source,
            commands::codemap::codemap_install_languages,
            commands::codemap::codemap_missing_languages,
            commands::diagnostics::set_log_level
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Err(error) = handle.state::<services::runs::RunManager>().run_cancel() {
                tauri_plugin_log::log::error!(
                    "Could not stop active workflow on app exit: {error}"
                );
            }
        }
    });
}
