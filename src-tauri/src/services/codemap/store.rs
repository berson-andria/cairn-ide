//! The code map's data: held in memory while the app runs, saved as one JSON file
//! (`<workspace>/.praide/cache/codemap.json`). It is a rebuildable cache: a missing, damaged or
//! older-format file just means the workspace is indexed again (only summaries cost anything).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::types::codemap::{CallRef, Extracted, Symbol};

/// Bump when the saved shape changes: old files are then ignored and rebuilt.
const SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub path: String,
    pub lang: String,
    pub content_hash: String,
    pub mtime_ms: i64,
    pub size: i64,
    /// False when the file is only listed: no parser for it, or its parser is not installed yet.
    #[serde(default)]
    pub parsed: bool,
}

#[derive(Deserialize)]
struct Snapshot {
    version: u32,
    files: Vec<FileRecord>,
    symbols: Vec<Symbol>,
    #[serde(default)]
    calls: BTreeMap<String, Vec<CallRef>>,
}

#[derive(Serialize)]
struct SnapshotRef<'a> {
    version: u32,
    files: Vec<&'a FileRecord>,
    symbols: Vec<&'a Symbol>,
    calls: BTreeMap<&'a String, &'a Vec<CallRef>>,
}

pub struct Store {
    pub path: Option<PathBuf>,
    dirty: bool,
    files: HashMap<String, FileRecord>,
    symbols: HashMap<String, Symbol>,
    /// Symbol ids per file, in source order.
    by_file: HashMap<String, Vec<String>>,
    /// Calls found in each file's functions.
    calls: HashMap<String, Vec<CallRef>>,
}

impl Store {
    /// Loads `path` if it holds a valid snapshot, otherwise starts empty. Never fails on bad data.
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut store = Self::empty(Some(path.to_path_buf()));
        let snapshot = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Snapshot>(&text).ok())
            .filter(|s| s.version == SCHEMA_VERSION);
        if let Some(s) = snapshot {
            for f in s.files {
                store.files.insert(f.path.clone(), f);
            }
            store.calls = s.calls.into_iter().collect();
            for sym in s.symbols {
                store
                    .by_file
                    .entry(sym.file.clone())
                    .or_default()
                    .push(sym.id.clone());
                store.symbols.insert(sym.id.clone(), sym);
            }
        }
        Ok(store)
    }

    /// No file behind it: `save` does nothing.
    pub fn in_memory() -> Self {
        Self::empty(None)
    }

    fn empty(path: Option<PathBuf>) -> Self {
        Self {
            path,
            dirty: false,
            files: HashMap::new(),
            symbols: HashMap::new(),
            by_file: HashMap::new(),
            calls: HashMap::new(),
        }
    }

    /// Writes the snapshot if anything changed since the last save (temp file, then rename).
    pub fn save(&mut self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if !self.dirty {
            return Ok(());
        }
        if path.file_name().is_some_and(|name| name == "codemap.json")
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "cache")
            && path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .is_some_and(|name| name == ".praide")
        {
            let root = path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .expect("codemap cache has a project root");
            crate::services::storage::ensure_praide_dir(root).map_err(|e| e.to_string())?;
        }
        let mut files: Vec<&FileRecord> = self.files.values().collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let mut symbols: Vec<&Symbol> = self.symbols.values().collect();
        symbols.sort_by(|a, b| (&a.file, a.start_byte).cmp(&(&b.file, b.start_byte)));
        let calls = self.calls.iter().collect();
        let json = serde_json::to_vec(&SnapshotRef {
            version: SCHEMA_VERSION,
            files,
            symbols,
            calls,
        })
        .map_err(|e| e.to_string())?;

        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(())
    }

    pub fn file_states(&self) -> Result<HashMap<String, FileRecord>, String> {
        Ok(self.files.clone())
    }

    /// Same content, new mtime/size (file touched but not changed).
    pub fn touch_file(&mut self, rec: &FileRecord) -> Result<(), String> {
        if let Some(f) = self.files.get_mut(&rec.path) {
            f.mtime_ms = rec.mtime_ms;
            f.size = rec.size;
            self.dirty = true;
        }
        Ok(())
    }

    /// Replace everything known about one file.
    /// Summaries survive: reused as fresh when a function's hash is unchanged (even if it moved),
    /// kept as stale when the id matches but the body changed.
    pub fn replace_file(&mut self, rec: &FileRecord, parsed: &Extracted) -> Result<(), String> {
        let mut by_id: HashMap<String, (String, Option<String>)> = HashMap::new();
        let mut by_hash: HashMap<String, String> = HashMap::new();
        for id in self.by_file.remove(&rec.path).unwrap_or_default() {
            let Some(old) = self.symbols.remove(&id) else {
                continue;
            };
            let Symbol {
                id,
                body_hash,
                summary,
                summary_hash,
                ..
            } = old;
            if let Some(text) = summary {
                if summary_hash.as_deref() == Some(body_hash.as_str()) {
                    by_hash.insert(body_hash, text.clone());
                }
                by_id.insert(id, (text, summary_hash));
            }
        }

        self.files.insert(rec.path.clone(), rec.clone());
        let mut ids = Vec::with_capacity(parsed.symbols.len());
        for s in &parsed.symbols {
            let mut sym = s.clone();
            if let Some(text) = by_hash.get(&s.body_hash) {
                sym.summary = Some(text.clone());
                sym.summary_hash = Some(s.body_hash.clone());
            } else if let Some((text, hash)) = by_id.get(&s.id) {
                sym.summary = Some(text.clone());
                sym.summary_hash = hash.clone();
            }
            ids.push(sym.id.clone());
            self.symbols.insert(sym.id.clone(), sym);
        }
        self.by_file.insert(rec.path.clone(), ids);
        self.calls.insert(rec.path.clone(), parsed.calls.clone());
        self.dirty = true;
        Ok(())
    }

    pub fn remove_file(&mut self, path: &str) -> Result<usize, String> {
        let existed = self.files.remove(path).is_some();
        self.calls.remove(path);
        for id in self.by_file.remove(path).unwrap_or_default() {
            self.symbols.remove(&id);
        }
        if existed {
            self.dirty = true;
        }
        Ok(existed as usize)
    }

    /// Removes `prefix` itself and everything under `prefix/` (a deleted or renamed folder).
    pub fn remove_prefix(&mut self, prefix: &str) -> Result<usize, String> {
        let under = format!("{prefix}/");
        let doomed: Vec<String> = self
            .files
            .keys()
            .filter(|p| p.as_str() == prefix || p.starts_with(&under))
            .cloned()
            .collect();
        let mut removed = 0;
        for path in doomed {
            removed += self.remove_file(&path)?;
        }
        Ok(removed)
    }

    /// Drops every file that is not in `present`. Returns how many were removed.
    pub fn retain_files(&mut self, present: &HashSet<String>) -> Result<usize, String> {
        let doomed: Vec<String> = self
            .files
            .keys()
            .filter(|p| !present.contains(*p))
            .cloned()
            .collect();
        let mut removed = 0;
        for path in doomed {
            removed += self.remove_file(&path)?;
        }
        Ok(removed)
    }

    pub fn symbols_for_file(&self, file: &str) -> Result<Vec<Symbol>, String> {
        Ok(self
            .by_file
            .get(file)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.symbols.get(id).cloned())
                    .collect()
            })
            .unwrap_or_default())
    }

    pub fn symbol(&self, id: &str) -> Result<Option<Symbol>, String> {
        Ok(self.symbols.get(id).cloned())
    }

    pub fn all_symbols(&self) -> Result<Vec<Symbol>, String> {
        Ok(self.sorted(|_| true))
    }

    /// Case-insensitive substring match on name, qualified name and summary.
    pub fn search(&self, text: &str, limit: usize) -> Result<Vec<Symbol>, String> {
        let needle = text.to_lowercase();
        let mut found = self.sorted(|s| {
            s.name.to_lowercase().contains(&needle)
                || s.qualified_name.to_lowercase().contains(&needle)
                || s.summary
                    .as_deref()
                    .is_some_and(|t| t.to_lowercase().contains(&needle))
        });
        found.truncate(limit);
        Ok(found)
    }

    /// Functions and methods whose summary is missing or was written for older code.
    pub fn stale_symbols(&self) -> Result<Vec<Symbol>, String> {
        Ok(self.sorted(|s| s.is_summary_stale()))
    }

    /// Call `save` (or the service's `flush`) after a batch of these.
    pub fn set_summary(&mut self, id: &str, summary: &str, for_hash: &str) -> Result<(), String> {
        if let Some(s) = self.symbols.get_mut(id) {
            s.summary = Some(summary.to_string());
            s.summary_hash = Some(for_hash.to_string());
            self.dirty = true;
        }
        Ok(())
    }

    /// Calls written inside one function.
    pub fn calls_of(&self, id: &str) -> Vec<CallRef> {
        let Some(sym) = self.symbols.get(id) else {
            return Vec::new();
        };
        self.calls
            .get(&sym.file)
            .map(|calls| calls.iter().filter(|c| c.from == id).cloned().collect())
            .unwrap_or_default()
    }

    /// Every call, anywhere, to a function or method with this name (resolution decides which are real).
    pub fn calls_named(&self, name: &str) -> Vec<CallRef> {
        self.calls
            .values()
            .flatten()
            .filter(|c| c.name == name)
            .cloned()
            .collect()
    }

    /// Functions and methods with this name.
    pub fn callable_named(&self, name: &str) -> Vec<Symbol> {
        self.sorted(|s| s.kind.is_callable() && s.name == name)
    }

    pub fn symbol_count(&self) -> Result<usize, String> {
        Ok(self.symbols.len())
    }

    fn sorted(&self, keep: impl Fn(&Symbol) -> bool) -> Vec<Symbol> {
        let mut out: Vec<Symbol> = self.symbols.values().filter(|s| keep(s)).cloned().collect();
        out.sort_by(|a, b| (&a.file, a.start_byte).cmp(&(&b.file, b.start_byte)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::codemap::{extract::Extractor, languages};

    fn extractor() -> Extractor {
        languages::test_support::ensure("rust");
        Extractor::new()
    }

    fn rec(path: &str, hash: &str) -> FileRecord {
        FileRecord {
            path: path.into(),
            lang: "rust".into(),
            content_hash: hash.into(),
            mtime_ms: 1,
            size: 1,
            parsed: true,
        }
    }

    fn syms(src: &str) -> Extracted {
        extractor().extract("rust", "a.rs", src).unwrap()
    }

    #[test]
    fn round_trip_and_search() {
        let mut store = Store::in_memory();
        store
            .replace_file(&rec("a.rs", "h1"), &syms("fn alpha() {}\nstruct Beta;"))
            .unwrap();
        assert_eq!(store.symbol_count().unwrap(), 2);
        let found = store.search("ALP", 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "alpha");
        assert!(store.search("100%", 10).unwrap().is_empty());
        assert_eq!(store.symbol(&found[0].id).unwrap().unwrap(), found[0]);
    }

    #[test]
    fn summary_is_kept_when_unchanged_stale_when_edited() {
        let mut store = Store::in_memory();
        store
            .replace_file(&rec("a.rs", "h1"), &syms("fn a() {}\nfn b() {}"))
            .unwrap();
        for s in store.stale_symbols().unwrap() {
            store
                .set_summary(&s.id, &format!("does {}", s.name), &s.body_hash)
                .unwrap();
        }
        assert!(store.stale_symbols().unwrap().is_empty());

        store
            .replace_file(
                &rec("a.rs", "h2"),
                &syms("fn a() {}\nfn b() { let _x = 1; }"),
            )
            .unwrap();
        let stale = store.stale_symbols().unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].name, "b");
        assert_eq!(stale[0].summary.as_deref(), Some("does b")); // old text kept, flagged stale
    }

    #[test]
    fn summary_follows_a_function_that_moved() {
        let mut store = Store::in_memory();
        store
            .replace_file(&rec("a.rs", "h1"), &syms("fn a() {}"))
            .unwrap();
        let s = store.stale_symbols().unwrap().remove(0);
        store.set_summary(&s.id, "does a", &s.body_hash).unwrap();

        store
            .replace_file(&rec("a.rs", "h2"), &syms("mod m { fn a() {} }"))
            .unwrap();
        assert!(store.stale_symbols().unwrap().is_empty());
        assert_eq!(
            store.all_symbols().unwrap()[0].summary.as_deref(),
            Some("does a")
        );
    }

    #[test]
    fn removing_files_and_folders() {
        let mut store = Store::in_memory();
        for p in ["src/a.rs", "src/sub/b.rs", "srcx/c.rs"] {
            let s = extractor().extract("rust", p, "fn f() {}").unwrap();
            store.replace_file(&rec(p, "h"), &s).unwrap();
        }
        store.remove_prefix("src").unwrap();
        let left: Vec<_> = store.file_states().unwrap().into_keys().collect();
        assert_eq!(left, vec!["srcx/c.rs".to_string()]);
        assert_eq!(store.symbol_count().unwrap(), 1);
    }

    #[test]
    fn saves_and_reloads_including_summaries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".praide/cache/codemap.json");
        let mut store = Store::open(&path).unwrap();
        store
            .replace_file(&rec("a.rs", "h1"), &syms("fn a() {}\nfn b() {}"))
            .unwrap();
        let a = store.search("a", 1).unwrap().remove(0);
        store.set_summary(&a.id, "does a", &a.body_hash).unwrap();
        store.save().unwrap();

        let again = Store::open(&path).unwrap();
        assert_eq!(again.calls_named("nothing"), vec![]);
        assert_eq!(again.all_symbols().unwrap(), store.all_symbols().unwrap());
        assert_eq!(again.symbols_for_file("a.rs").unwrap().len(), 2);
        assert_eq!(again.file_states().unwrap()["a.rs"].content_hash, "h1");
        assert_eq!(again.stale_symbols().unwrap().len(), 1); // only b still needs a summary
    }

    #[test]
    fn damaged_or_old_files_start_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codemap.json");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(Store::open(&path).unwrap().symbol_count().unwrap(), 0);
        fs::write(&path, r#"{"version":999,"files":[],"symbols":[]}"#).unwrap();
        assert_eq!(Store::open(&path).unwrap().symbol_count().unwrap(), 0);
    }

    #[test]
    fn unchanged_store_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codemap.json");
        let mut store = Store::open(&path).unwrap();
        store.save().unwrap();
        assert!(!path.exists()); // nothing changed yet
        store
            .replace_file(&rec("a.rs", "h"), &syms("fn a() {}"))
            .unwrap();
        store.save().unwrap();
        assert!(path.exists());
    }
}
