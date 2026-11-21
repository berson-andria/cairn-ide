# Code map implementation

## 1. Purpose and ownership

Rust owns the project index and its rebuildable cache at
`.cairn/cache/codemap.json`; `CodeMapService::open` binds the workspace root,
and `Store` loads/saves the cache
(`src-tauri/src/services/codemap/service.rs:24-37`,
`src-tauri/src/services/codemap/store.rs:1-4`). Writes use a temporary file
and rename (`src-tauri/src/services/codemap/store.rs:99-144`). Angular's
`CodeMapService` is an invoke client, not a second index writer
(`src/app/core/services/codemap/codemap.service.ts:57-112`).
Its language-dismissal preference is local UI state in `localStorage`
(`src/app/core/services/codemap/codemap.service.ts:143-159`). The project
task/note/proposal/run contracts are documented separately in
[tasks and notes](./tasks-notes.md).

## 2. Data shapes

| Rust | Angular / wire shape | Difference |
|---|---|---|
| `Symbol` (`src-tauri/src/types/codemap.rs:44`) | `CodeSymbol` (`src/app/core/services/codemap/codemap.service.ts:9`) | Same camelCase fields. Rust `Option` fields serialize as `null`; TypeScript uses nullable fields. `SymbolKind` matches the same five string values (`src-tauri/src/types/codemap.rs:5`, `src/app/core/services/codemap/codemap.service.ts:7`). |
| `Link` (`src-tauri/src/types/codemap.rs:130`) | `CodeLink` (`src/app/core/services/codemap/codemap.service.ts:27`) | Same `{ symbol, exact }` shape. |
| `TreeNode` (`src-tauri/src/types/codemap.rs:142`) | `CodeMapNode` (`src/app/core/services/codemap/codemap.service.ts:32`) | Same `type: 'folder' | 'file'` tagged union and fields. |
| `IndexProgress` (`src-tauri/src/types/codemap.rs:77`) | `IndexProgress` (`src/app/core/services/codemap/codemap.service.ts:36`) | Same `done`, `total`. |
| `IndexStats` (`src-tauri/src/types/codemap.rs:84`) | `IndexStats` (`src/app/core/services/codemap/codemap.service.ts:41`) | Same six numeric counts. |
| `MissingLanguage` (`src-tauri/src/types/codemap.rs:159`) | `MissingLanguage` (`src/app/core/services/codemap/codemap.service.ts:49`) | Same `name`, `files`. |
| `CallKind`, `CallRef`, `Extracted` (`src-tauri/src/types/codemap.rs:96-125`) and `FileRecord` (`src-tauri/src/services/codemap/store.rs:18`) | None | Rust extraction/cache internals; not returned by the Angular API. |

`search` takes a required `usize` in Rust, but its Tauri argument and Angular
argument are optional; the command supplies the default limit of 50
(`src-tauri/src/services/codemap/service.rs:322-325`,
`src-tauri/src/commands/codemap.rs:155-163`,
`src/app/core/services/codemap/codemap.service.ts:99-101`).

## 3. Rust

### Service functions

Every listed service operation returns `Result<_, String>`; store and file
errors are strings. Per-file read/parse failures are counted as skipped rather
than failing the whole index
(`src-tauri/src/services/codemap/service.rs:145-213`).

| Function | What it does | Errors / behavior |
|---|---|---|
| `CodeMapService::open` (`src-tauri/src/services/codemap/service.rs:31`) | Opens or initializes the root's cache. | Cache path is `.cairn/cache/codemap.json`; corrupt or old snapshots load empty (`src-tauri/src/services/codemap/store.rs:59-78`). |
| `index_workspace` (`src-tauri/src/services/codemap/service.rs:40`) | Walks project files, indexes changed files, removes missing entries, saves, and reports progress. | Store errors return as `String`; unreadable files are skipped. |
| `update_files` (`src-tauri/src/services/codemap/service.rs:86`) | Incrementally indexes changed paths and removes deleted file/folder prefixes. | Paths outside the root or ignored paths are skipped; store errors return as `String`. |
| `missing_languages` (`src-tauri/src/services/codemap/service.rs:215`) | Counts files whose supported parser is absent, most files first. | Store errors return as `String`. |
| `reindex_languages` (`src-tauri/src/services/codemap/service.rs:231`) | Re-indexes files waiting for the supplied installed parsers. | Delegates to `update_files`; errors return as `String`. |
| `tree` (`src-tauri/src/services/codemap/service.rs:243`) | Builds the folder/file/symbol tree from the store. | Store errors return as `String`. |
| `symbols_in_file` (`src-tauri/src/services/codemap/service.rs:263`) | Returns a file's symbols. | Store errors return as `String`. |
| `callees_of` (`src-tauri/src/services/codemap/service.rs:267`) | Resolves calls made by a symbol; an unknown caller returns an empty list. | Store errors return as `String`. |
| `callers_of` (`src-tauri/src/services/codemap/service.rs:289`) | Resolves callers of a function or method. | Unknown symbol returns `"unknown symbol"`; non-callable symbols return an empty list. |
| `search` (`src-tauri/src/services/codemap/service.rs:322`) | Searches symbol name, qualified name, and summary. | Store errors return as `String`. |
| `symbol` (`src-tauri/src/services/codemap/service.rs:327`) | Looks up a symbol by id. | Unknown id is `Ok(None)`. |
| `symbol_source` (`src-tauri/src/services/codemap/service.rs:332`) | Reads the symbol's current file and slices its stored byte range. | File read and out-of-bounds errors return as `String`. |

Tree-sitter extraction emits Rust functions, methods, structs, enums, traits,
signatures, spans, body hashes, and call references
(`src-tauri/src/services/codemap/extract.rs:34-57,80-123,229-258`).
The call graph resolves by name and syntax kind; `exact` is false when more
than one candidate remains (`src-tauri/src/services/codemap/graph.rs:12-70`,
`src-tauri/src/types/codemap.rs:130-136`).

### Commands

All commands return `Result<_, String>`; command names below are registered in
`src-tauri/src/lib.rs:76,129-139`. Injected `state` and `app` are not JS args.

| Command | JS args (camelCase) | Returns |
|---|---|---|
| `codemap_open` (`src-tauri/src/commands/codemap.rs:47`) | `root`, `onProgress` | `IndexStats` |
| `codemap_close` (`src-tauri/src/commands/codemap.rs:75`) | — | `void` |
| `codemap_missing_languages` (`src-tauri/src/commands/codemap.rs:85`) | — | `MissingLanguage[]` |
| `codemap_install_languages` (`src-tauri/src/commands/codemap.rs:94`) | `names` | `IndexStats` |
| `codemap_update_files` (`src-tauri/src/commands/codemap.rs:109`) | `paths` | `IndexStats` |
| `codemap_tree` (`src-tauri/src/commands/codemap.rs:122`) | — | `TreeNode` |
| `codemap_symbols_in_file` (`src-tauri/src/commands/codemap.rs:128`) | `file` | `Symbol[]` |
| `codemap_callers` (`src-tauri/src/commands/codemap.rs:137`) | `id` | `Link[]` |
| `codemap_callees` (`src-tauri/src/commands/codemap.rs:146`) | `id` | `Link[]` |
| `codemap_search` (`src-tauri/src/commands/codemap.rs:155`) | `query`, optional `limit` | `Symbol[]` |
| `codemap_symbol_source` (`src-tauri/src/commands/codemap.rs:166`) | `id` | `string` |

### Events

No Tauri broadcast events are emitted by these commands. `codemap_open`
streams `{ done, total }` through the Tauri `Channel<IndexProgress>` supplied
as `onProgress` (`src-tauri/src/commands/codemap.rs:47-73`).

## 4. Angular

### API wrapper and facade

`CodeMapService` has no signal-backed cache. Each method calls its matching
Tauri command and returns the command result
(`src/app/core/services/codemap/codemap.service.ts:57-112`).

| Method signature | Command | Errors handled |
|---|---|---|
| `open(root: string, onProgress?: (p: IndexProgress) => void): Promise<IndexStats>` | `codemap_open`; checks missing languages after success. | Open errors reject; missing-language check errors are logged and suppressed. |
| `close(): Promise<void>` | `codemap_close` | Invoke errors reject. |
| `updateFiles(paths: string[]): Promise<IndexStats>` | `codemap_update_files`; checks missing languages if files parsed. | Update errors reject; missing-language check errors are logged and suppressed. |
| `tree(): Promise<CodeMapNode>` | `codemap_tree` | Invoke errors reject. |
| `symbolsInFile(file: string): Promise<CodeSymbol[]>` | `codemap_symbols_in_file` | Invoke errors reject. |
| `callers(id: string): Promise<CodeLink[]>` | `codemap_callers` | Invoke errors reject. |
| `callees(id: string): Promise<CodeLink[]>` | `codemap_callees` | Invoke errors reject. |
| `search(query: string, limit?: number): Promise<CodeSymbol[]>` | `codemap_search` | Invoke errors reject. |
| `symbolSource(id: string): Promise<string>` | `codemap_symbol_source` | Invoke errors reject. |
| `missingLanguage(): Promise<MissingLanguage[]>` | `codemap_missing_languages` | Invoke errors reject; automatic checks log and suppress failures. |
| `installLanguages(names: string[]): Promise<IndexStats>` | `codemap_install_languages` | Invoke errors reject; the dialog catches install errors and displays them. |

There is no Angular CodeMap store or store signal (`docs/MAP.md:450`).
`MissingLanguageDialog` has local signals only for its form state
(`src/app/core/services/codemap/missing-language-dialog.ts:60-78`).

## 5. Flows

- **Open/index:** `CodeMapService.open` → `codemap_open` → configure the
  app-data grammar cache, open `CodeMapService`, index the workspace, save the
  snapshot, return `IndexStats`; progress is sent on the channel. The Angular
  wrapper then checks for missing parsers and may open the dialog
  (`src/app/core/services/codemap/codemap.service.ts:62-68,115-140`,
  `src-tauri/src/commands/codemap.rs:47-73`,
  `src-tauri/src/services/codemap/service.rs:31-84`).
- **File changes:** `CodeMapService.updateFiles(paths)` → `codemap_update_files`
  → normalize paths → `CodeMapService::update_files` → update/save cache and
  return `IndexStats` (`src/app/core/services/codemap/codemap.service.ts:76-80`,
  `src-tauri/src/commands/codemap.rs:109-120`,
  `src-tauri/src/services/codemap/service.rs:86-124`).
- **Queries:** each facade method → matching `codemap_*` command → matching
  Rust query method → immediate result to Angular; there is no event/store
  synchronization (`src/app/core/services/codemap/codemap.service.ts:83-105`,
  `src-tauri/src/commands/codemap.rs:122-178`).
- **Install parser:** the dialog calls `installLanguages(names)` after user
  action → `codemap_install_languages` downloads the requested parsers and
  re-indexes waiting files → updated stats return to the dialog
  (`src/app/core/services/codemap/missing-language-dialog.ts:79-99`,
  `src/app/core/services/codemap/codemap.service.ts:111`,
  `src-tauri/src/commands/codemap.rs:94-107`).

## 6. Gaps and unverified behavior

- Production extraction is Rust-only; Zig is enabled only in tests
  (`src-tauri/src/services/codemap/languages.rs:11-15`). Other files can
  appear in the tree without parsed symbols; files above 1 MB are not parsed
  (`src-tauri/src/services/codemap/service.rs:20,169-180`).
- Initial indexing uses `WalkBuilder` git-ignore handling, while incremental
  updates use a helper that reads only root `.gitignore`, root
  `.git/info/exclude`, and fixed patterns; nested-ignore parity is not
  established (`src-tauri/src/services/codemap/service.rs:126-140,354-383`).
- `Symbol.summary` is searchable, and `Store::set_summary` can write it, but
  no `CodeMapService`, Tauri command, or Angular method exposes that write
  (`src-tauri/src/types/codemap.rs:44-74`,
  `src-tauri/src/services/codemap/store.rs:289-296`,
  `src-tauri/src/commands/codemap.rs:47-178`,
  `src/app/core/services/codemap/codemap.service.ts:57-112`).
- Caller/callee matching is syntactic and name-based, not compiler resolution;
  ambiguous results are returned with `exact: false`
  (`src-tauri/src/services/codemap/graph.rs:12-70`,
  `src-tauri/src/types/codemap.rs:130-136`).
- `CodeMapService` also opens the missing-language dialog and reads/writes its
  dismissal preference, coupling the API wrapper to UI/local-storage behavior
  (`src/app/core/services/codemap/codemap.service.ts:115-159`).

## 7. Logic in the wrong layer

| File:line | Finding | Belongs in |
|---|---|---|
| `src-tauri/src/commands/codemap.rs:94-106` | The command sequences parser installation and re-indexing as one code-map use case. | A `CodeMapService` operation; keep the command as argument/result plumbing. |
| `src-tauri/src/commands/codemap.rs:155-163` | The IPC command owns the default search limit (`50`). | `CodeMapService::search` or a service input default, so the policy is not transport-specific. |

No component-level service logic was found in the scoped missing-language
dialog; it handles user interaction and delegates installation
(`src/app/core/services/codemap/missing-language-dialog.ts:79-99`).
