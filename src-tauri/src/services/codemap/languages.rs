//! Which languages the code map can read, and how their parsers get onto this machine.
//! Parsers come from `tree-sitter-language-pack`. Nothing is bundled: a parser is downloaded only after
//! the user agrees, into the app-data folder, and is then shared by every project.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tree_sitter_language_pack as pack;

/// Languages we have an extractor for (see `extract.rs`). A language is added here and given a branch there.
const EXTRACTABLE: &[&str] = if cfg!(test) {
    &["rust", "zig"]
} else {
    &["rust"]
};

pub fn can_extract(lang: &str) -> bool {
    EXTRACTABLE.contains(&lang)
}

/// The language of a file, if the map can read it. Says nothing about whether its parser is installed.
pub fn detect(path: &Path) -> Option<&'static str> {
    pack::detect_language(path.to_str()?).filter(|l| can_extract(l))
}

/// Offline check: is this language's parser already on disk?
pub fn is_installed(lang: &str) -> bool {
    pack::has_parser(lang)
}

/// Where downloaded parsers live. The first call wins, so call it before anything else.
pub fn set_cache_dir(dir: PathBuf) -> Result<(), String> {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.get().is_some() {
        return Ok(());
    }
    pack::configure(&pack::PackConfig {
        cache_dir: Some(dir),
        languages: None,
        groups: None,
    })
    .map_err(|e| e.to_string())?;
    let _ = DONE.set(());
    Ok(())
}

/// Downloads parsers (network). Only languages we can extract are accepted.
pub fn install(names: &[String]) -> Result<usize, String> {
    if let Some(bad) = names.iter().find(|n| !can_extract(n)) {
        return Err(format!("unsupported language: {bad}"));
    }
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    pack::download(&names).map_err(|e| e.to_string())
}

/// Loads an installed parser. It never downloads: the pack's own `get_language` would do that silently.
pub fn load(lang: &str) -> Result<tree_sitter::Language, String> {
    if !is_installed(lang) {
        return Err(format!("the {lang} parser is not installed"));
    }
    pack::get_language(lang).map_err(|e| e.to_string())
}

#[cfg(test)]
pub mod test_support {
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    /// Makes `lang` available to a test: downloaded once into a temp folder (network needed the first time only).
    pub fn ensure(lang: &str) {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        super::set_cache_dir(std::env::temp_dir().join("praide-test-grammars")).unwrap();
        if !super::is_installed(lang) {
            super::install(&[lang.to_string()])
                .expect("the first run downloads the parser and needs network access");
        }
    }
}
