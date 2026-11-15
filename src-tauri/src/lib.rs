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
    tauri::Builder::default()
        .manage(commands::fs::SearchCancellation(Arc::new(AtomicBool::new(
            false,
        ))))
        .manage(commands::lsp::LspState::default())
        .manage(commands::pty::PtyState::default())
        .manage(commands::codemap::CodeMapState::default())
        .setup(|app| {
            // Local server that git / ssh questions (password, passphrase, host key) are sent to.
            app.manage(commands::askpass::Askpass::start(app.handle().clone())?);
            Ok(())
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
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
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::codemap::codemap_open,
            commands::codemap::codemap_close,
            commands::codemap::codemap_update_files,
            commands::codemap::codemap_tree,
            commands::codemap::codemap_symbols_in_file,
            commands::codemap::codemap_callers,
            commands::codemap::codemap_callees,
            commands::codemap::codemap_search,
            commands::codemap::codemap_symbol_source,
            commands::codemap::codemap_install_languages,
            commands::codemap::codemap_missing_languages
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
