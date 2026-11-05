use crate::types::workspace_node::{BaseNode, FileNode, FolderNode, Node};

use std::fs::{create_dir_all, read_dir, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_log::log::info;
use uuid::Uuid;

pub fn get_directory_content(path: &Path) -> Result<Vec<Node>, String> {
    let mut nodes = Vec::new();
    let entries = read_dir(path).map_err(|e| format!("Failed to read directory details: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            let item_path = entry.path();

            // Get clean system string representations of the file name and path
            let item_name = item_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();

            let item_path_str = item_path.to_string_lossy().into_owned();

            let base = BaseNode {
                id: Uuid::new_v4().to_string(), // Instant, high-speed tracking identifier generation
                name: item_name,
                path: item_path_str,
                parent_id: None,
            };

            if item_path.is_dir() {
                nodes.push(Node::Folder(FolderNode {
                    base,
                    is_expanded: false,
                    children: Some(Vec::new()), // Starts empty, will be loaded later when expanded
                }));
            } else if item_path.is_file() {
                // Safely slice out the native system dot extensions (.ts, .rs, etc)
                let extension = item_path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();

                nodes.push(Node::File(FileNode {
                    base,
                    content: String::new(), // Do not send contents across IPC until user opens file!
                    extension,
                    is_dirty: false,
                }));
            }
        }
    }

    // 5. Sort nodes so folders naturally show up on top alphabetically before individual files
    nodes.sort_by(|a, b| {
        let is_a_folder = matches!(a, Node::Folder(_));
        let is_b_folder = matches!(b, Node::Folder(_));

        if is_a_folder != is_b_folder {
            is_b_folder.cmp(&is_a_folder)
        } else {
            let name_a = match a {
                Node::File(f) => &f.base.name,
                Node::Folder(f) => &f.base.name,
            };
            let name_b = match b {
                Node::File(f) => &f.base.name,
                Node::Folder(f) => &f.base.name,
            };
            name_a.cmp(name_b)
        }
    });

    Ok(nodes)
}

pub async fn create_fs_node(
    path: String,
    name: String,
    node_type: String,
    parent_id: Option<String>,
) -> Result<Node, String> {
    let target_path = Path::new(&path);

    if target_path.exists() {
        return Err(format!(
            "A system item already exists at this path: {}",
            path
        ));
    }

    let node_id = Uuid::new_v4().to_string();

    let base = BaseNode {
        id: node_id,
        name: name.clone(),
        path: path.clone(),
        parent_id,
    };

    // 2. Perform the physical disk write sequence based on the target type layout
    if node_type == "folder" {
        create_dir_all(target_path)
            .map_err(|e| format!("Failed to create folder directory structure: {}", e))?;

        Ok(Node::Folder(FolderNode {
            base,
            is_expanded: false,
            children: Some(Vec::new()), // Fresh empty subdirectory layer
        }))
    } else if node_type == "file" {
        // Create an empty physical file on disk
        File::create(target_path)
            .map_err(|e| format!("Failed to initialize empty file buffer context: {}", e))?;

        // Safely extract dot extension strings (.ts, .json, etc)
        let extension = target_path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();

        Ok(Node::File(FileNode {
            base,
            content: String::new(), // Starts as blank text layout buffer
            extension,
            is_dirty: false,
        }))
    } else {
        Err(format!("Unknown node type declaration: {}", node_type))
    }
}
