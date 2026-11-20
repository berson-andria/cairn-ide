//! Folders -> files -> symbols, built from what the code map knows (so ignored folders never show up).

use std::collections::BTreeMap;

use crate::types::codemap::{Symbol, TreeNode};

#[derive(Default)]
struct Dir {
    dirs: BTreeMap<String, Dir>,
    /// file name -> language
    files: BTreeMap<String, String>,
}

/// `files` are `(workspace-relative path, language)`. `symbols_of` gives a file's symbols in source order.
/// Folders come first, then files, each sorted by name. Returns the workspace root folder.
pub fn build(
    root_name: &str,
    files: impl IntoIterator<Item = (String, String)>,
    symbols_of: &dyn Fn(&str) -> Vec<Symbol>,
) -> TreeNode {
    let mut root = Dir::default();
    for (path, lang) in files {
        let mut parts: Vec<&str> = path.split('/').collect();
        let Some(file_name) = parts.pop() else {
            continue;
        };
        let mut dir = &mut root;
        for part in parts {
            dir = dir.dirs.entry(part.to_string()).or_default();
        }
        dir.files.insert(file_name.to_string(), lang);
    }
    TreeNode::Folder {
        name: root_name.to_string(),
        path: String::new(),
        children: convert(&root, "", symbols_of),
    }
}

fn convert(dir: &Dir, prefix: &str, symbols_of: &dyn Fn(&str) -> Vec<Symbol>) -> Vec<TreeNode> {
    let join = |name: &str| {
        if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        }
    };
    let mut out = Vec::new();
    for (name, sub) in &dir.dirs {
        let path = join(name);
        out.push(TreeNode::Folder {
            name: name.clone(),
            children: convert(sub, &path, symbols_of),
            path,
        });
    }
    for (name, lang) in &dir.files {
        let path = join(name);
        out.push(TreeNode::File {
            name: name.clone(),
            lang: lang.clone(),
            symbols: symbols_of(&path),
            path,
        });
    }
    out
}
