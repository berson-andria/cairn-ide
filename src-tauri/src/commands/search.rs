use grep_regex::RegexMatcherBuilder;
use grep_searcher::Searcher;
use ignore::overrides::{Override, OverrideBuilder};
use rayon::prelude::*;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::search::{FileNameSearchResult, FileSearchResult, FileSearchSink, SearchOptions};

fn is_binary_file(path: &Path) -> bool {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return true,
    };

    let mut buffer = [0; 1024];
    match file.read(&mut buffer) {
        Ok(bytes_read) => buffer[..bytes_read].iter().any(|&b| b == 0),
        Err(_) => true,
    }
}

/// Id of the newest search. Typing fires a new search before the previous one finished; the old one
/// notices it was superseded and stops instead of grinding through the whole workspace.
static LATEST_SEARCH: AtomicU64 = AtomicU64::new(0);

/// "*.{ts,js}, src/**" -> ["*.{ts,js}", "src/**"]. Commas inside braces belong to the glob, not the list.
fn split_globs(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for ch in input.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if depth == 0 => parts.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    parts.push(current);

    parts
        .into_iter()
        .map(|p| p.trim().replace('\\', "/"))
        .map(|p| p.trim_start_matches("./").to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Include globs whitelist; exclude globs are the same syntax with a leading `!` (gitignore rules).
/// A glob without a slash matches at any depth, so "node_modules" or "*.log" work as people expect.
fn build_overrides(root: &Path, include: &str, exclude: &str) -> Result<Override, String> {
    let mut builder = OverrideBuilder::new(root);

    for pattern in split_globs(include) {
        builder
            .add(&pattern)
            .map_err(|e| format!("Invalid include pattern \"{pattern}\": {e}"))?;
        // "src" or "src/" should mean the folder AND everything in it (this also lets hidden
        // folders such as ".github" be entered).
        let folder = format!("{}/**", pattern.trim_end_matches('/'));
        builder
            .add(&folder)
            .map_err(|e| format!("Invalid include pattern \"{pattern}\": {e}"))?;
    }
    for pattern in split_globs(exclude) {
        builder
            .add(&format!("!{pattern}"))
            .map_err(|e| format!("Invalid exclude pattern \"{pattern}\": {e}"))?;
    }
    builder.build().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn global_search(
    workspace_path: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<Vec<FileSearchResult>, String> {
    let search_id = LATEST_SEARCH.fetch_add(1, Ordering::SeqCst) + 1;
    // The walk and the regex scan are blocking work: keep them off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || {
        run_search(
            search_id,
            workspace_path,
            query,
            options.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_search(
    search_id: u64,
    workspace_path: String,
    query: String,
    options: SearchOptions,
) -> Result<Vec<FileSearchResult>, String> {
    let root = Path::new(&workspace_path);
    if !root.exists() {
        return Err("Workspace path does not exist".into());
    }

    // Compiled once. (It used to be rebuilt for every single file.) A bad pattern is reported
    // to the panel instead of silently producing zero results.

    let mut builder = RegexMatcherBuilder::new();
    builder.case_insensitive(!options.case_sensitive);
    builder.word(options.whole_word);
    let matcher = builder
        .build(&query)
        .map_err(|e| format!("Invalid regular expression: {e}"))?;
    let overrides = build_overrides(root, &options.include, &options.exclude)?;

    let files: Vec<PathBuf> = match &options.only_paths {
        // Open editors: no walk needed. The include/exclude globs still apply.
        Some(paths) => paths
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.is_file() && !overrides.matched(p, false).is_ignore())
            .collect(),
        None => {
            let walker = ignore::WalkBuilder::new(root)
                .hidden(true)
                .git_ignore(true)
                .overrides(overrides)
                .build();

            let mut found = Vec::new();
            for entry in walker.flatten() {
                if LATEST_SEARCH.load(Ordering::Relaxed) != search_id {
                    return Ok(Vec::new()); // superseded by a newer search
                }
                if entry.file_type().map_or(false, |ft| ft.is_file()) {
                    found.push(entry.into_path());
                }
            }
            found
        }
    };

    let grouped_results: Vec<FileSearchResult> = files
        .par_iter()
        .filter(|_| LATEST_SEARCH.load(Ordering::Relaxed) == search_id)
        .filter(|file_path| !is_binary_file(file_path))
        .filter_map(|file_path| {
            let mut searcher = Searcher::new();
            let mut line_matches = Vec::new();

            let sink = FileSearchSink {
                matches: &mut line_matches,
            };
            let _ = searcher.search_path(&matcher, file_path, sink);

            if !line_matches.is_empty() {
                Some(FileSearchResult {
                    path: file_path.to_string_lossy().to_string(),
                    matches: line_matches,
                })
            } else {
                None
            }
        })
        .collect();

    Ok(grouped_results)
}
#[tauri::command]
pub fn search_files(root_path: &str, query: &str) -> Result<Vec<FileNameSearchResult>, String> {
    let base_path = Path::new(root_path);
    if !base_path.exists() {
        return Err("Root path does not exist".to_string());
    }

    let normalized_query = query.to_lowercase().replace('\\', "/");
    let mut matching_files: Vec<FileNameSearchResult> = Vec::new();

    let walker = ignore::WalkBuilder::new(base_path)
        .hidden(true)
        .git_ignore(true)
        .build();

    for entry in walker.flatten() {
        if entry.file_type().map_or(false, |ft| ft.is_file()) {
            let full_path = entry.path();

            if let Ok(relative_path) = full_path.strip_prefix(base_path) {
                let relative_str = relative_path
                    .to_string_lossy()
                    .to_lowercase()
                    .replace('\\', "/");

                if relative_str.contains(&normalized_query) {
                    matching_files.push(FileNameSearchResult {
                        file_name: entry.file_name().to_string_lossy().to_string(),
                        path: full_path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }

    Ok(matching_files)
}
