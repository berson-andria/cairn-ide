# Current watch and ignore policy

Read-only inventory of the current source. A claim without a cited implementation is marked **unverified**.

## 1. Rules and definitions

- **Codemap walker:** `collect_files` uses `WalkBuilder` with `.git_ignore(true)`, `.require_git(false)`, and `.git_global(false)`, and retains files only. The walker library's default hidden filtering is relied upon; the source comment characterizes excluded names as hidden path components (for example `.git`, `.cairn`, `.ide`) and `.gitignore` matches. Exact full built-in hidden-name list is **unverified**. [src-tauri/src/services/codemap/service.rs:124-140]
- **Shared codemap/watcher ignore list (`watcher_ignore`):** reads root `.gitignore` and `.git/info/exclude` if present, then adds exactly `.venv/`, `venv/`, `__pycache__/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`; malformed builder output falls back to empty rules. Nested `.gitignore` files are not read by this helper. [src-tauri/src/services/codemap/service.rs:351-373]
- **Shared hidden-name predicate (`is_ignored`):** ignores any relative path component whose name starts with `.`, or a path matched by the helper's ignore rules. This includes `.env` and `.gitignore` regardless of their contents. [src-tauri/src/services/codemap/service.rs:376-383]
- **Watcher exception:** paths under `.git` are allowed when the path is exactly `.git/HEAD`, `.git/index`, `.git/packed-refs`, or has `.git/refs` as its first two components; other `.git` paths flow through `is_ignored`. [src-tauri/src/services/watcher.rs:233-253]
- **Watcher filter:** callback prunes each notify event's path vector with `path_allowed(...) || is_cairn_data_path(...)`; `path_allowed` rejects paths outside root, applies the `.git` exception, then shared hidden/ignore policy. The internal exception is only exactly three components `.cairn/(tasks|notes)/<name>.json`, with name not dot-prefixed and not ending `.tmp`. [src-tauri/src/services/watcher.rs:125-137,198-213,245-253]
- **Codemap `update_files`:** recomputes the shared helper, rejects outside-root paths and calls `is_ignored` itself before indexing/removing. For a path no longer existing, it removes the stored path prefix only after passing that check. [src-tauri/src/services/codemap/service.rs:85-116]
- **`read_directory_content`:** command validates existence and directory-ness, then delegates to `fs::get_directory_content`; the reader pushes every readable file or directory entry and sorts folders first/alphabetically. No hidden-name or ignore filter is present. [src-tauri/src/commands/fs.rs:20-33; src-tauri/src/services/fs.rs:10-16,34-55,58-78]
- **Global content search:** include/exclude are user globs; excludes become `!pattern`. With `only_paths`, existing files are filtered by overrides. Workspace walk uses hidden=true, `.gitignore` handling, and overrides. Exact `.gitignore` source details follow `ignore::WalkBuilder` library behavior; no hard-coded ignored-name array in this command. [src-tauri/src/commands/search.rs:59-80,123-145]
- **Filename search (`search_files`):** `WalkBuilder.hidden(true).git_ignore(true)` plus the request's `excluded_folders`; folder exclusion is case-insensitive and matches either a whole relative path prefix or any path component for a slash-free rule. Exact request values are caller-provided, not a fixed list. [src-tauri/src/commands/search.rs:189-217,242-255]
- **Angular search helper:** `isExcludedFolderPath` applies the same request-supplied exclusion list (normalized case-insensitively; slash-containing prefix or matching component). Its call sites in search UI are **unverified**. [src/app/shared/utils/excluded-folders.ts:1-23]
- **Angular node-name filtering:** no hidden-name/ignore filter was found in the examined explorer node store or Rust directory reader; the store loads returned children and indexes them. A repository-wide Angular filter elsewhere is **unverified**. [src/app/core/store/node.store.ts:269-299; src-tauri/src/services/fs.rs:10-55]
- **Codemap settings registry:** `codemap.ignorePatterns` is declared as an empty string-list setting with description “Patterns excluded from the code map,” but it is marked planned; wiring into the walker/watcher is **unverified**. [src/app/feature/setting/settings.registry.ts:291-299]
- **Git module:** `git_run` defines allowed Git subcommands (including `status`, `ls-files`, and mutating commands); this is a command allowlist, not a filesystem hidden-name list. Watch-driven status refresh listens to every emitted `fsEvents$` notification and runs `refresh()`; it adds no path filter. [src-tauri/src/commands/git.rs:21-45; src/app/feature/git/services/git.service.ts:157-164,230-262]

## 2. Notify event path and drop points

1. Notify callback retains only paths accepted by `path_allowed` or the `.cairn/tasks|notes/*.json` exception, then queues the event. `.venv` directory creation is rejected here by `.venv/`; `venv` is rejected by `venv/`; `.env` and `.gitignore` are rejected by the hidden-component test. A `.gitignore` edit event is therefore dropped at callback filtering, including before Angular can react to changed rules. [src-tauri/src/services/watcher.rs:125-137; src-tauri/src/services/codemap/service.rs:359-382]
2. Batching calls `build_batch`, which again applies `path_allowed`; accepted events are grouped/deduplicated, then emitted as `fs:changed`. For Git paths, the exception admits only the four Git metadata classes above. [src-tauri/src/services/watcher.rs:180-195,233-285]
3. `WorkspaceWatcherService` listens for `fs:changed`, immediately emits `fsEvents$` once per batch, and converts each event kind to a Tauri-like create/remove/modify/rename type before enqueueing it. Overflow emits `fsEvents$`, reloads the explorer root, and reopens the codemap. [src/app/core/services/file-system/workspace-watcher.service.ts:63-79,101-107]
4. `enqueue` applies `classifyWatchEvent` once to decide whether to queue codemap paths (`ignore` events do not); `process` classifies again. Create/remove/modify/rename proceed; malformed/other/access and metadata-only modify events classify as ignore. [src/app/core/services/file-system/workspace-watcher.service.ts:110-153; src/app/core/services/file-system/external-watcher.utils.ts:19-34]
5. Explorer create invokes `NodeStore.applyCreated`; removal invokes `applyRemoved`. No independent hidden-name test appears in these methods. A newly created folder/file may only be inserted when its parent can be resolved/loaded. [src/app/core/services/file-system/workspace-watcher.service.ts:132-153; src/app/core/store/node.store.ts:730-780,787-815]
6. Codemap path batching invokes Angular `CodeMapService.updateFiles`, then Rust `codemap_update_files`/`CodeMapService::update_files`; Rust independently rejects hidden and ignored paths. [src/app/core/services/file-system/workspace-watcher.service.ts:117-129; src/app/core/services/codemap/codemap.service.ts:75-80; src-tauri/src/commands/codemap.rs:107-116; src-tauri/src/services/codemap/service.rs:85-116]
7. Git refresh is triggered from the unfiltered `fsEvents$` batch notification (debounced 500 ms), even if an accepted event is ignored by Angular classification. It runs Git `status`; Git's own status semantics determine ignored/untracked results. [src/app/core/services/file-system/workspace-watcher.service.ts:65-79; src/app/feature/git/services/git.service.ts:163-164,247-260]

**Requested examples:** `.venv` creation drops at the notify callback path filter (`.venv/`). `venv` creation drops there (`venv/`). `.env` and `.gitignore` creation/edit paths drop there because each path contains a dot-prefixed component. For these paths no `fs:changed`, Angular explorer, Angular codemap queue, or fsEvents-driven Git refresh follows. [src-tauri/src/services/watcher.rs:125-137; src-tauri/src/services/codemap/service.rs:359-382]

## 3. Explorer reads and cache

- `read_directory_content` does not hide names; Rust enumerates and returns all readable entries. NodeStore does not apply a name filter while converting returned entries into cached child nodes. [src-tauri/src/commands/fs.rs:20-33; src-tauri/src/services/fs.rs:10-55; src/app/core/store/node.store.ts:269-299]
- A nonempty `children` array is treated as loaded and expansion uses cached children. An empty folder has `children: []`, which is also treated as not loaded (`!children?.length`); expanding it again calls `read_directory_content` again. Thus nonempty loaded folders are cached; empty folders are re-read on subsequent expansion. [src/app/core/store/node.store.ts:262-299,625-637]

## 4. Direct codemap answer

`update_files` does drop hidden and ignored paths itself; it does not rely solely on watcher filtering. It applies `is_ignored` before both indexing and deletion handling. Its ignore matcher uses root `.gitignore`, root `.git/info/exclude`, and the listed fixed patterns; nested `.gitignore` files are not read by this helper. [src-tauri/src/services/codemap/service.rs:90-116,351-382]

## 5. Rule-to-consumer table

| Rule | Where defined | Consumers affected |
|---|---|---|
| Walker hidden filtering (exact hidden-name set unverified) | `WalkBuilder` defaults plus `.git_ignore(true)` [src-tauri/src/services/codemap/service.rs:124-140] | Codemap initial workspace scan |
| Root `.gitignore`, root `.git/info/exclude` | `watcher_ignore` [src-tauri/src/services/codemap/service.rs:351-373] | Watcher path filter and codemap `update_files`; walker separately uses `.git_ignore(true)` |
| `.venv/`, `venv/`, `__pycache__/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/` | `watcher_ignore` [src-tauri/src/services/codemap/service.rs:359-373] | Watcher filter, codemap `update_files` |
| Any dot-prefixed path component | `is_ignored` [src-tauri/src/services/codemap/service.rs:376-383] | Watcher and codemap update; watcher `.git` exceptions override for selected paths |
| `.git/HEAD`, `.git/index`, `.git/packed-refs`, `.git/refs/**` allowlist | `git_path_needed` [src-tauri/src/services/watcher.rs:233-253] | Watcher and `fs:changed`; Git status refresh via `fsEvents$` |
| `.cairn/(tasks|notes)/<non-hidden-name>.json` (not `.tmp`) internal exception | `is_cairn_data_path` [src-tauri/src/services/watcher.rs:198-213] | Internal Rust listeners; excluded from regular `fs:changed` by shared hidden policy |
| Search include/exclude glob overrides | `build_overrides` [src-tauri/src/commands/search.rs:59-80] | Global content search; `only_paths` and workspace walk |
| Hidden and Git-ignored search traversal | Search `WalkBuilder` calls [src-tauri/src/commands/search.rs:133-137,203-217] | Global content search and filename search |
| Per-request `excluded_folders` | Search command `is_excluded_folder` [src-tauri/src/commands/search.rs:189-217,242-255] | Filename search |
| Angular per-request folder exclusions | `isExcludedFolderPath` [src/app/shared/utils/excluded-folders.ts:1-23] | Angular consumer(s) unverified |
| `codemap.ignorePatterns` setting (planned; runtime use unverified) | Settings registry [src/app/feature/setting/settings.registry.ts:291-299] | Intended codemap consumer; actual consumer unverified |
| Explorer name exclusions | None found in inspected reader/store [src-tauri/src/services/fs.rs:10-55; src/app/core/store/node.store.ts:269-299] | None evidenced; repository-wide other consumers unverified |
