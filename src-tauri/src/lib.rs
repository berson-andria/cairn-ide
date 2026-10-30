use std::sync::atomic::AtomicBool;
use std::sync::Arc;

mod commands;
mod services;
mod types;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::fs::SearchCancellation(Arc::new(AtomicBool::new(
            false,
        ))))
        .manage(commands::lsp::LspState::default())
        .manage(commands::pty::PtyState::default())
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
            commands::lsp::lsp_start,
            commands::lsp::lsp_send,
            commands::lsp::lsp_stop,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
