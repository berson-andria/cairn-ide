# Search

## 1. Purpose and ownership

Search provides workspace file-name and text-result lookup in the unified search panel. Rust owns filesystem traversal and matching and is the only side that performs the search. Angular owns the search UI, local result signals, mode selection, open-editor filtering, and replace orchestration. It does not mutate or persist search records through a store.

- Rust types: [src-tauri/src/types/search.rs](../../src-tauri/src/types/search.rs)
- Rust command implementation: [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs)
- Angular service: [src/app/feature/search/search.service.ts](../../src/app/feature/search/search.service.ts)
- Angular panel: [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts)
- Search registration: [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs:61)

## 2. Data shapes

| Rust | TypeScript | Difference |
|---|---|---|
| `LineMatch { line_number: u64, text: String }` | `LineMatch { lineNumber: number, text: string }` | Rust serializes `lineNumber` through `rename_all = "camelCase"`; same field meaning. |
| `FileSearchResult { path: String, matches: Vec<LineMatch> }` | `FileSearchResult { path: string, matches: LineMatch[] }` | Same shape. |
| `FileNameSearchResult { file_name: String, path: String }` | `FileNameSearchResult { fileName: string, path: string }` | Rust serializes `file_name` as `fileName`; same meaning. |
| `SearchOptions { include: String, exclude: String, only_paths: Option<Vec<String>>, case_sensitive: bool, whole_word: bool }` | `SearchFilters { include: string, exclude: string, onlyPaths: string[] \| null, caseSensitive?: boolean, wholeWord?: boolean }` | `onlyPaths` maps from `only_paths`; options is optional in Rust and Angular marks booleans optional, while Rust defaults both booleans and strings through `Default`. |

The Rust response types derive `Serialize` and use camelCase. The Rust input derives `Deserialize` with camelCase and default values. [src-tauri/src/types/search.rs](../../src-tauri/src/types/search.rs:1) [src/app/feature/search/search.model.ts](../../src/app/feature/search/search.model.ts:1)

## 3. Rust

### Service functions

There is no search Rust service. The command module contains the implementation helpers:

| Name | What it does | Errors |
|---|---|---|
| `split_globs` | Splits comma-separated globs while preserving commas inside braces. | None; returns strings. |
| Filter normalization | Normalizes include and exclude folder patterns. | `String` for invalid include/exclude globs. |
| `is_binary_file` | Returns true when a file cannot be opened or contains a NUL byte in the first 1024 bytes. | I/O failure is treated as binary/skip. |
| `run_search` | Builds the regex and filters, walks or limits files, scans in parallel, and groups line matches. | Workspace missing, invalid regex or filters, result returned as `String`. |
| `search_files_blocking` | Walks files and returns paths whose relative names contain the query. | `Root path does not exist` or an internal `String` error shape. |
| `is_excluded_folder` | Applies excluded-folder rules to relative paths. | No explicit error. |

Sources: [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:24) [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:45) [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:91) [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:191)

### Commands

| Name | Args in camelCase | Returns |
|---|---|---|
| `global_search` | `workspacePath: String`, `query: String`, `options: SearchOptions \| null` | `Promise<Vec<FileSearchResult>>`, plain `String` error |
| `search_files` | `rootPath: String`, `query: String`, `excludedFolders: Vec<String>` | `Promise<Vec<FileNameSearchResult>>`, plain `String` error |

Both are registered in the Tauri handler. [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:83) [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:179) [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs:61)

### Events

Search emits no Tauri events. [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:83)

## 4. Angular

### API wrapper

| Method | Signature | Calls | Errors handled |
|---|---|---|---|
| `seachWorkspaceKeyword` | `(folderPath: string, query: string, filters?: SearchFilters) => Promise<FileSearchResult[]>` | `global_search` with `{ workspacePath, query, options }` | None at wrapper level; caller catches. |
| `searchWorkspaceFile` | `(folderPath: string, keyword: string) => Promise<FileNameSearchResult[]>` | `search_files` with `{ rootPath, query }` | Catches and logs; returns `[]`. |

The misspelled `seachWorkspaceKeyword` name is copied exactly from the code. [src/app/feature/search/search.service.ts](../../src/app/feature/search/search.service.ts:12) [src/app/feature/search/search.service.ts](../../src/app/feature/search/search.service.ts:25)

### Store signals

There is no dedicated search store or search event sync. The panel directly holds `fileSearchResults`, `textSearchResults`, `taskSearchResults`, `codeSearchResults`, and `commandSearchResults` signals. It also reads `NodeStore.rootPath`, `nodes`, and `resolveFileId/revealInExplorer`, plus `TabStore.openTabs`. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:83) [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:506)

### Service/facade methods

`SearchService` is the only dedicated search API service. It has no store-facing or event-facing methods. `ReplaceService.replaceLines` is the supporting service for text replace: it updates an open Monaco model or writes the file, and returns `{ replaced, skipped, error }`. [src/app/core/services/replace.service.ts](../../src/app/core/services/replace.service.ts:39)

## 5. Flows

**File-name search:** input change -> component debounce/debounce criteria -> `SearchService.searchWorkspaceFile` -> Tauri `search_files` -> Rust walk/match -> plain `Vec<FileNameSearchResult>` -> component `fileSearchResults` signal. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:514) [src/app/feature/search/search.service.ts](../../src/app/feature/search/search.service.ts:25)

**Text search:** `/` or search mode detection -> component criteria includes open paths/filter flags -> `SearchService.seachWorkspaceKeyword` -> Tauri `global_search` -> Rust regex/walk/parallel scan -> `Vec<FileSearchResult>` -> component `textSearchResults` signal. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:302) [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:538)

**Open file:** result activation -> `NodeStore.resolveFileId`/`revealInExplorer` or `EditorCommands.openPathAtLine` -> no Rust search command remains in the action. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:405) [src/app/feature/search/result/result.ts](../../src/app/feature/search/result/result.ts:86)

**Replace text:** confirmation in component -> `ReplaceService.replaceLines` per target -> open model or disk write -> component removes replaced matches and reports skipped/problem lines. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:338) [src/app/core/services/replace.service.ts](../../src/app/core/services/replace.service.ts:39)

**Placeholder modes:** `#` tasks, `@` code, `>` commands set warnings and return empty arrays; no backend action is called. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:551)

## 6. Gaps

- `search_files` requires `excludedFolders: Vec<String>`, but `SearchService.searchWorkspaceFile` invokes it without that argument. This is unverified end to end and may make file-name search fail at argument validation. [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:179) [src/app/feature/search/search.service.ts](../../src/app/feature/search/search.service.ts:25)
- `SearchService.searchWorkspaceFile` catches every error and silently converts it to `[]`, while text search reaches a generic component catch. [src/app/feature/search/search.service.ts](../../src/app/feature/search/search.service.ts:25) [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:514)
- Task, code, and command modes are placeholders and are not implemented. [src/app/feature/search/search.ts](../../src/app/feature/search/search.ts:551)
- Search has no Rust service, event, store, or structured search error code; errors are plain strings. [src-tauri/src/commands/search.rs](../../src-tauri/src/commands/search.rs:83) [docs/CONTEXT.md](../CONTEXT.md:86)
- Search supersession uses a process-static `LATEST_SEARCH` counter and cancels superseded work cooperatively; the maximum behavior for overlapping calls is unverified.
- Search performance, result ordering, and end-to-end behavior for the live Tauri app are unverified.

## 7. Logic in the wrong layer

| Path:line | Finding |
|---|---|
| [src-tauri/src/commands/search.rs:24-81](../../src-tauri/src/commands/search.rs:24) | Glob splitting and include/exclude override construction belong in a Rust search service, not command helpers. |
| [src-tauri/src/commands/search.rs:83-176](../../src-tauri/src/commands/search.rs:83) | `global_search` mixes IPC plumbing with supersession, validation, regex compilation, walking, filtering, parallel scanning, and grouping. |
| [src-tauri/src/commands/search.rs:179-244](../../src-tauri/src/commands/search.rs:179) | `search_files` mixes IPC plumbing with validation, traversal, exclusion, normalization, and filename matching. |
| [src/app/feature/search/search.ts:338-399](../../src/app/feature/search/search.ts:338) | Bulk replacement confirmation, target construction, progress state, and result reconciliation belong in a replace/search workflow service rather than the panel component. |
