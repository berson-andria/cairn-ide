//! The code map's public API: open a workspace, keep it indexed, query it.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use super::extract::Extractor;
use super::graph;
use super::languages;
use super::store::{FileRecord, Store};
use super::tree;
use crate::types::codemap::{
    Extracted, IndexProgress, IndexStats, Link, MissingLanguage, Symbol, TreeNode,
};

/// Source files bigger than this are generated or minified: listed, but not parsed.
const MAX_PARSE_BYTES: u64 = 1_000_000;
/// `lang` of a file the map can list but has no way to read.
const OTHER: &str = "other";

pub struct CodeMapService {
    root: PathBuf,
    store: Store,
}

impl CodeMapService {
    /// Opens a workspace and creates or loads the code map cache. Does not index yet.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, String> {
        let root = root.as_ref().to_path_buf();
        let cache_path = root.join(".cairn/cache/codemap.json");
        let store = Store::open(&cache_path)?;
        Ok(Self { root, store })
    }

    /// Indexes the workspace: lists every project file (ignored folders and `.gitignore` excluded),
    /// parses the new or changed ones that have a grammar, and updates the store.
    pub fn index_workspace(
        &mut self,
        on_progress: &dyn Fn(IndexProgress),
    ) -> Result<IndexStats, String> {
        let files = self.collect_files();
        let total = files.len();
        let mut stats = IndexStats {
            scanned: total,
            ..Default::default()
        };

        let known = self.store.file_states()?;
        let mut present = HashSet::new();
        let mut extractor = Extractor::new();

        for (i, rel_path) in files.iter().enumerate() {
            if i % 25 == 0 {
                on_progress(IndexProgress { done: i, total });
            }
            let rel = rel_path.to_string_lossy().replace('\\', "/");
            present.insert(rel.clone());
            let full = self.root.join(rel_path);
            self.index_file(&rel, &full, known.get(&rel), &mut extractor, &mut stats)?;
        }

        // Remove files no longer present
        stats.removed = self.store.retain_files(&present)?;
        stats.symbols = self.store.symbol_count()?;
        self.store.save()?;

        on_progress(IndexProgress { done: total, total });
        Ok(stats)
    }

    /// Updates the code map after file changes (created, modified, or deleted; files or whole folders).
    pub fn update_files(&mut self, paths: &[PathBuf]) -> Result<IndexStats, String> {
        let mut stats = IndexStats::default();
        let mut extractor = Extractor::new();
        let known = self.store.file_states()?;
        let gitignore = self.gitignore();

        for path in paths {
            let full = if path.is_absolute() {
                path.clone()
            } else {
                self.root.join(path)
            };
            // outside the workspace, or ignored: not ours
            let Ok(rel_path) = full.strip_prefix(&self.root) else {
                continue;
            };
            if is_ignored(&gitignore, rel_path, full.is_dir()) {
                continue;
            }
            let rel = rel_path.to_string_lossy().replace('\\', "/");
            stats.scanned += 1;

            if !full.exists() {
                // deleted file, or a deleted / renamed folder
                stats.removed += self.store.remove_prefix(&rel)?;
                continue;
            }
            if !full.is_file() {
                continue;
            }
            self.index_file(&rel, &full, known.get(&rel), &mut extractor, &mut stats)?;
        }

        stats.symbols = self.store.symbol_count()?;
        self.store.save()?;
        Ok(stats)
    }

    /// Every file the walk finds, as paths relative to the root. Languages do not matter here.
    /// What is left out: hidden files and folders (`.git`, `.cairn`, `.ide`...) and whatever `.gitignore` lists.
    fn collect_files(&self) -> Vec<PathBuf> {
        ignore::WalkBuilder::new(&self.root)
            .git_ignore(true)
            .require_git(false) // honor .gitignore even where there is no .git folder
            .git_global(false) // a user's global ignore file differs per machine, the map should not
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .filter_map(|e| {
                e.path()
                    .strip_prefix(&self.root)
                    .ok()
                    .map(Path::to_path_buf)
            })
            .collect()
    }

    /// Brings one file up to date in the store. Never fails because of the file itself
    /// (unreadable, not UTF-8...): such files are counted as skipped.
    fn index_file(
        &mut self,
        rel: &str,
        full: &Path,
        known: Option<&FileRecord>,
        extractor: &mut Extractor,
        stats: &mut IndexStats,
    ) -> Result<(), String> {
        let Ok((mtime_ms, size)) = get_file_info(full) else {
            stats.skipped += 1;
            return Ok(());
        };
        // Same mtime and size as last time: not even read. Unless the file was only listed because its parser
        // was missing, and that parser has been installed since.
        let waiting_for_parser =
            |k: &FileRecord| !k.parsed && k.lang != OTHER && languages::is_installed(&k.lang);
        if known.is_some_and(|k| k.mtime_ms == mtime_ms && k.size == size && !waiting_for_parser(k))
        {
            stats.unchanged += 1;
            return Ok(());
        }

        // No parser to use: list the file, never read it. A known language whose parser is not installed is
        // remembered (lang set, parsed false) so `missing_languages` can offer to install it.
        let lang = languages::detect(full).filter(|_| size as u64 <= MAX_PARSE_BYTES);
        let Some(lang) = lang.filter(|l| languages::is_installed(l)) else {
            let rec = FileRecord {
                path: rel.to_string(),
                lang: lang.unwrap_or(OTHER).to_string(),
                content_hash: String::new(),
                mtime_ms,
                size,
                parsed: false,
            };
            self.store.replace_file(&rec, &Extracted::default())?;
            stats.parsed += 1;
            return Ok(());
        };

        let Ok(source) = fs::read_to_string(full) else {
            stats.skipped += 1;
            return Ok(());
        };
        let rec = FileRecord {
            path: rel.to_string(),
            lang: lang.to_string(),
            content_hash: blake3::hash(source.as_bytes()).to_hex().to_string(),
            mtime_ms,
            size,
            parsed: true,
        };

        // touched, but the text is the same
        if known.is_some_and(|k| k.content_hash == rec.content_hash) {
            self.store.touch_file(&rec)?;
            stats.unchanged += 1;
            return Ok(());
        }

        match extractor.extract(lang, rel, &source) {
            Ok(parsed) => {
                self.store.replace_file(&rec, &parsed)?;
                stats.parsed += 1;
            }
            Err(_) => stats.skipped += 1,
        }
        Ok(())
    }

    /// Languages found in the workspace whose parser is not installed, most files first.
    pub fn missing_languages(&self) -> Result<Vec<MissingLanguage>, String> {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for file in self.store.file_states()?.into_values() {
            if !file.parsed && file.lang != OTHER && !languages::is_installed(&file.lang) {
                *counts.entry(file.lang).or_default() += 1;
            }
        }
        let mut missing: Vec<MissingLanguage> = counts
            .into_iter()
            .map(|(name, files)| MissingLanguage { name, files })
            .collect();
        missing.sort_by(|a, b| b.files.cmp(&a.files).then_with(|| a.name.cmp(&b.name)));
        Ok(missing)
    }

    /// Parses the files that were waiting for these languages. Their parsers must already be installed.
    pub fn reindex_languages(&mut self, names: &[String]) -> Result<IndexStats, String> {
        let paths: Vec<PathBuf> = self
            .store
            .file_states()?
            .into_values()
            .filter(|f| !f.parsed && names.contains(&f.lang))
            .map(|f| self.root.join(&f.path))
            .collect();
        self.update_files(&paths)
    }

    /// The entire code map as a tree (files and symbols organized hierarchically).
    pub fn tree(&self) -> Result<TreeNode, String> {
        let file_states = self.store.file_states()?;
        let files: Vec<(String, String)> = file_states
            .into_iter()
            .map(|(path, rec)| (path, rec.lang))
            .collect();

        let root_name = self
            .root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace")
            .to_string();

        Ok(tree::build(&root_name, files, &|file| {
            self.store.symbols_for_file(file).unwrap_or_default()
        }))
    }

    /// All symbols (functions, methods, types...) defined in a file.
    pub fn symbols_in_file(&self, file: &str) -> Result<Vec<Symbol>, String> {
        self.store.symbols_for_file(file)
    }

    pub fn callees_of(&self, id: &str) -> Result<Vec<Link>, String> {
        let Some(caller) = self.store.symbol(id)? else {
            return Ok(Vec::new());
        };
        let mut links = Vec::new();

        for call in self.store.calls_of(id) {
            let named = self.store.callable_named(&call.name);
            let resolved = graph::resolve(&caller, &call, &named);
            let exact = resolved.len() == 1;
            for target in resolved {
                links.push(Link {
                    symbol: target.clone(),
                    exact,
                });
            }
        }

        Ok(links)
    }

    /// All function calls to a function or method (its callers).
    pub fn callers_of(&self, id: &str) -> Result<Vec<Link>, String> {
        let target = self.store.symbol(id)?.ok_or("unknown symbol")?;
        if !target.kind.is_callable() {
            return Ok(Vec::new());
        }
        // Resolve against every function with this name, not only the target:
        // that is what tells `exact` (one candidate) from "could be any of several".
        let named = self.store.callable_named(&target.name);
        let mut links: Vec<Link> = Vec::new();

        for call in self.store.calls_named(&target.name) {
            let Some(caller) = self.store.symbol(&call.from)? else {
                continue;
            };
            let found = graph::resolve(&caller, &call, &named);
            if !found.iter().any(|s| s.id == target.id) {
                continue;
            }
            let exact = found.len() == 1;
            // one entry per caller, exact if any of its calls was unambiguous
            match links.iter_mut().find(|l| l.symbol.id == caller.id) {
                Some(existing) => existing.exact |= exact,
                None => links.push(Link {
                    symbol: caller,
                    exact,
                }),
            }
        }

        Ok(links)
    }

    /// Search for symbols by name or in summary.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Symbol>, String> {
        self.store.search(query, limit)
    }

    /// Get a symbol by its ID.
    pub fn symbol(&self, id: &str) -> Result<Option<Symbol>, String> {
        self.store.symbol(id)
    }

    /// Read the full source text of a symbol from disk.
    pub fn symbol_source(&self, symbol: &Symbol) -> Result<String, String> {
        let full_path = self.root.join(&symbol.file);
        let source = fs::read_to_string(&full_path)
            .map_err(|e| format!("failed to read {}: {}", symbol.file, e))?;
        let start = symbol.start_byte;
        let end = symbol.end_byte;
        if end <= source.len() {
            Ok(source[start..end].to_string())
        } else {
            Err(format!(
                "symbol range [{}, {}) out of bounds for file with {} bytes",
                start,
                end,
                source.len()
            ))
        }
    }
}

/// The workspace's ignore rules (`.gitignore` and `.git/info/exclude` at the root), read fresh on each call.
/// Used for watcher paths, which do not go through the walker. Nested `.gitignore` files are not read here.
impl CodeMapService {
    fn gitignore(&self) -> Gitignore {
        let mut builder = GitignoreBuilder::new(&self.root);
        let _ = builder.add(self.root.join(".gitignore")); // a missing file is fine
        let _ = builder.add(self.root.join(".git/info/exclude"));
        builder.build().unwrap_or_else(|_| Gitignore::empty())
    }
}

/// Same rules as the walk: hidden (a `.something` part anywhere in the path) or matched by the ignore rules.
fn is_ignored(gitignore: &Gitignore, rel: &Path, is_dir: bool) -> bool {
    rel.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        || gitignore
            .matched_path_or_any_parents(rel, is_dir)
            .is_ignore()
}

/// Get file metadata (mtime in ms, size in bytes).
fn get_file_info(path: &Path) -> Result<(i64, i64), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("failed to stat: {}", e))?;
    let mtime = metadata
        .modified()
        .map_err(|e| format!("failed to get mtime: {}", e))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("time error: {}", e))?
        .as_millis() as i64;
    Ok((mtime, metadata.len() as i64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, rel: &str, text: &str) -> PathBuf {
        let p = dir.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, text).unwrap();
        p
    }

    fn open(dir: &tempfile::TempDir) -> CodeMapService {
        languages::test_support::ensure("rust");
        CodeMapService::open(dir.path()).unwrap()
    }

    fn find(svc: &CodeMapService, qualified: &str) -> String {
        svc.store
            .search(qualified, 50)
            .unwrap()
            .into_iter()
            .find(|s| s.qualified_name == qualified)
            .unwrap()
            .id
    }

    #[test]
    fn lists_every_file_and_skips_ignored_folders() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "a.rs", "fn a() {}\nfn b() {}");
        write(&dir, "src/c.rs", "struct C;");
        write(&dir, "app.ts", "export function f() {}");
        write(&dir, "styles/main.scss", "a { b: c }");
        write(&dir, "node_modules/x/y.rs", "fn nope() {}");
        write(&dir, "target/gen.rs", "fn nope() {}");
        write(&dir, "dist/out.js", "nope");
        write(&dir, "ignored.rs", "fn nope() {}");
        write(&dir, ".hidden/h.rs", "fn nope() {}");
        write(
            &dir,
            ".gitignore",
            "node_modules/\ntarget/\ndist/\nignored.rs\n",
        );
        // no .git folder on purpose: .gitignore must work anyway

        let mut svc = open(&dir);
        let stats = svc.index_workspace(&|_| {}).unwrap();
        assert_eq!((stats.scanned, stats.symbols), (4, 3));
        assert!(svc.search("nope", 10).unwrap().is_empty());

        let TreeNode::Folder { children, .. } = svc.tree().unwrap() else {
            panic!()
        };
        let shape: Vec<String> = children
            .iter()
            .map(|n| match n {
                TreeNode::Folder { path, .. } => format!("dir:{path}"),
                TreeNode::File {
                    path,
                    lang,
                    symbols,
                    ..
                } => {
                    format!("file:{path}:{lang}:{}", symbols.len())
                }
            })
            .collect();
        assert_eq!(
            shape,
            [
                "dir:src",
                "dir:styles",
                "file:a.rs:rust:2",
                "file:app.ts:other:0"
            ]
        );
    }

    #[test]
    fn second_run_parses_nothing_and_edits_are_noticed() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir, "a.rs", "fn a() {}");
        write(&dir, "notes.md", "# hi");
        let mut svc = open(&dir);
        svc.index_workspace(&|_| {}).unwrap();
        let again = svc.index_workspace(&|_| {}).unwrap();
        assert_eq!((again.parsed, again.unchanged), (0, 2));

        fs::write(&a, "fn a() {}\nfn b() {}").unwrap();
        let stats = svc.update_files(&[a]).unwrap();
        assert_eq!((stats.parsed, stats.symbols), (1, 2));
    }

    #[test]
    fn update_files_handles_delete_folder_delete_and_foreign_paths() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, ".gitignore", "target/\nbuild/\n*.log\n");
        let a = write(&dir, "a.rs", "fn a() {}");
        write(&dir, "pkg/x.rs", "fn x() {}");
        write(&dir, "pkg/readme.md", "hi");
        let mut svc = open(&dir);
        svc.index_workspace(&|_| {}).unwrap();

        fs::remove_file(&a).unwrap();
        assert_eq!(svc.update_files(&[a]).unwrap().removed, 1);

        fs::remove_dir_all(dir.path().join("pkg")).unwrap();
        let s = svc.update_files(&[dir.path().join("pkg")]).unwrap();
        assert_eq!((s.removed, s.symbols), (2, 0));

        let s = svc
            .update_files(&[
                PathBuf::from("/tmp/elsewhere.rs"),
                dir.path().join("target/z.rs"),
            ])
            .unwrap();
        assert_eq!(s.scanned, 0);
    }

    #[test]
    fn an_unreadable_file_does_not_abort_the_index() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "good.rs", "fn good() {}");
        fs::write(dir.path().join("bad.rs"), [0xff, 0xfe, 0x00, 0x80]).unwrap(); // not UTF-8
        let mut svc = open(&dir);
        let stats = svc.index_workspace(&|_| {}).unwrap();
        assert_eq!((stats.skipped, stats.symbols), (1, 1));
    }

    #[test]
    fn callers_are_not_exact_when_the_name_is_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir,
            "a.rs",
            "impl A { fn run(&self) {} }\nimpl B { fn run(&self) {} }\nfn go(x: A) { x.run(); }\nfn solo() { A::run(); }",
        );
        let mut svc = open(&dir);
        svc.index_workspace(&|_| {}).unwrap();
        let callers = svc.callers_of(&find(&svc, "B::run")).unwrap();
        let shape: Vec<_> = callers
            .iter()
            .map(|l| (l.symbol.name.as_str(), l.exact))
            .collect();
        assert_eq!(shape, [("go", false)]);

        let callers = svc.callers_of(&find(&svc, "A::run")).unwrap();
        let mut shape: Vec<_> = callers
            .iter()
            .map(|l| (l.symbol.name.as_str(), l.exact))
            .collect();
        shape.sort();
        assert_eq!(shape, [("go", false), ("solo", true)]);
    }

    #[test]
    fn watcher_paths_follow_the_same_ignore_rules() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, ".gitignore", "target/\nbuild/\n*.log\n");
        write(&dir, "a.rs", "fn a() {}");
        let mut svc = open(&dir);
        svc.index_workspace(&|_| {}).unwrap();

        let paths = [
            write(&dir, "target/debug/gen.rs", "fn g() {}"),
            write(&dir, "build/out.rs", "fn o() {}"),
            write(&dir, "run.log", "text"),
            write(&dir, ".hidden/h.rs", "fn h() {}"),
            write(&dir, ".gitignore", "target/\nbuild/\n*.log\n"),
        ];
        let stats = svc.update_files(&paths).unwrap();
        assert_eq!((stats.scanned, stats.parsed, stats.symbols), (0, 0, 1));

        // a normal new file still goes through
        let ok = write(&dir, "src/new.rs", "fn n() {}");
        assert_eq!(svc.update_files(&[ok]).unwrap().parsed, 1);
    }

    #[test]
    fn a_language_without_its_parser_is_listed_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "main.zig", "pub fn main() void {}");
        write(&dir, "a.rs", "fn a() {}");
        let mut svc = open(&dir);
        svc.index_workspace(&|_| {}).unwrap();

        let missing = svc.missing_languages().unwrap();
        assert_eq!(
            missing,
            vec![MissingLanguage {
                name: "zig".into(),
                files: 1
            }]
        );
        let TreeNode::Folder { children, .. } = svc.tree().unwrap() else {
            panic!()
        };
        let shape: Vec<String> = children
            .iter()
            .map(|n| match n {
                TreeNode::File {
                    path,
                    lang,
                    symbols,
                    ..
                } => format!("{path}:{lang}:{}", symbols.len()),
                TreeNode::Folder { path, .. } => format!("dir:{path}"),
            })
            .collect();
        assert_eq!(shape, ["a.rs:rust:1", "main.zig:zig:0"]);

        // still reported on the next run, and nothing is downloaded or parsed
        assert_eq!(svc.index_workspace(&|_| {}).unwrap().parsed, 0);
        assert_eq!(svc.missing_languages().unwrap().len(), 1);
    }

    #[test]
    fn files_waiting_for_a_parser_are_parsed_once_it_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(&dir, "a.rs", "fn a() {}\nfn b() {}");
        let mut svc = open(&dir);
        // as if the file had been indexed before the rust parser existed
        let (mtime_ms, size) = get_file_info(&a).unwrap();
        let waiting = FileRecord {
            path: "a.rs".into(),
            lang: "rust".into(),
            content_hash: String::new(),
            mtime_ms,
            size,
            parsed: false,
        };
        svc.store
            .replace_file(&waiting, &Extracted::default())
            .unwrap();
        assert_eq!(svc.store.symbol_count().unwrap(), 0);

        // the parser is installed, so it is not "missing"; the file is picked up although mtime and size are unchanged
        assert!(svc.missing_languages().unwrap().is_empty());
        let stats = svc.reindex_languages(&["rust".to_string()]).unwrap();
        assert_eq!((stats.parsed, stats.symbols), (1, 2));
        assert_eq!(
            svc.reindex_languages(&["rust".to_string()]).unwrap().parsed,
            0
        ); // nothing left waiting

        // a plain index run does the same
        let mut again = open(&dir);
        again
            .store
            .replace_file(&waiting, &Extracted::default())
            .unwrap();
        assert_eq!(again.index_workspace(&|_| {}).unwrap().symbols, 2);
    }

    #[test]
    fn only_extractable_languages_can_be_installed() {
        assert!(languages::install(&["cobol".to_string()]).is_err());
    }
}
