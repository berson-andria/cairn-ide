use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    services::fs,
    types::workspace_node::{BaseNode, FileNode, FileSearchResult, LineMatch, Node},
};
use std::{
    fs::{create_dir_all, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{ipc::Channel, State};

pub struct SearchCancellation(pub Arc<AtomicBool>);

#[tauri::command]
pub async fn read_directory_content(path: String) -> Result<Vec<Node>, String> {
    let target_path = PathBuf::from(&path);
    if !target_path.exists() {
        return Err(format!(
            "The path '{}' does not exist on this machine.",
            path
        ));
    }
    if !target_path.is_dir() {
        return Err(format!("Provided path is not a folder: {}", path));
    }
    fs::get_directory_content(&target_path)
}

#[tauri::command]
pub async fn get_files(path: Vec<String>) -> Result<Vec<FileNode>, String> {
    let mut file_nodes = Vec::new();
    for file_path in path {
        let target_path = PathBuf::from(&file_path);
        if !target_path.exists() {
            return Err(format!(
                "The path '{}' does not exist on this machine.",
                file_path
            ));
        }
        if target_path.is_dir() {
            return Err(format!("Provided path is not a file: {}", file_path));
        }

        let item_name = target_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();

        let item_path_str = target_path.to_string_lossy().into_owned();

        let base = BaseNode {
            id: Uuid::new_v4().to_string(), // Instant, high-speed tracking identifier generation
            name: item_name,
            path: item_path_str,
            parent_id: None,
        };
        let extension = target_path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        file_nodes.push(FileNode {
            base: base,
            content: String::from(""),
            extension: extension,
            is_dirty: false,
        });
    }
    Ok(file_nodes)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut content = String::new();

    reader
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;

    Ok(content)
}

#[tauri::command]
pub async fn create_fs_node(
    path: String,
    name: String,
    node_type: String,
    parent_id: Option<String>,
) -> Result<Node, String> {
    fs::create_fs_node(path, name, node_type, parent_id).await
}

#[tauri::command]
pub fn workspace_search(
    dir_path: String,
    search_term: String,
    on_match: Channel<FileSearchResult>, // Tauri v2 Channel for streaming
    cancel_state: State<'_, SearchCancellation>,
) -> Result<(), String> {
    cancel_state.0.store(true, Ordering::SeqCst);

    let current_cancel = Arc::new(AtomicBool::new(false));

    let cancel_flag = current_cancel.clone();

    // Reset global cancellation mechanism so we don't accidentally stop ourselves
    cancel_state.0.store(false, Ordering::SeqCst);
    let master_cancel = cancel_state.0.clone();

    // Spawn the block-heavy file crawling work onto a separate async worker thread pool
    tauri::async_runtime::spawn_blocking(move || {
        let walker = WalkDir::new(&dir_path).into_iter();

        for entry in walker.filter_map(|e| e.ok()) {
            // Check BOTH cancellation indicators on every file step
            if master_cancel.load(Ordering::SeqCst) || cancel_flag.load(Ordering::SeqCst) {
                break; // Gracefully abort immediately
            }

            let path = entry.path();

            // Skip massive modules/folders
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name == "node_modules" || name == ".git" || name == "target" {
                        continue;
                    }
                }
            }

            if path.is_file() {
                if let Ok(file) = File::open(path) {
                    let reader = BufReader::new(file);
                    let mut file_matches = Vec::new();
                    let mut is_valid_text = true;

                    for (index, line_result) in reader.lines().enumerate() {
                        match line_result {
                            Ok(line) => {
                                if line.contains(&search_term) {
                                    file_matches.push(LineMatch {
                                        line_number: index + 1,
                                        text: line.trim().to_string(),
                                    });
                                }
                            }
                            Err(_) => {
                                is_valid_text = false;
                                break;
                            }
                        }
                    }

                    // If matches were found, send them IMMEDIATELY via the channel
                    if is_valid_text && !file_matches.is_empty() {
                        let result = FileSearchResult {
                            path: path.to_string_lossy().into_owned(),
                            matches: file_matches,
                        };
                        // Send single file result to frontend stream listener
                        let _ = on_match.send(result);
                    }
                }
            }
        }
    });

    Ok(())
}
