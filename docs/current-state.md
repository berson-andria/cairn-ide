# Current state (discovery only)

All statements below are limited to the requested source areas; citations use repository-relative `path:line`.

## 1. State ownership

| State | Owner file | Type | Mutation | Readers |
|---|---|---|---|---|
| Workspace nodes/explorer | `src/app/core/store/node.store.ts:30-47,70-73` | `NodeState`; node shapes in `src/app/core/store/node.state.ts:1-43` | Store methods patch signals; filesystem service supplies disk operations (`node.store.ts:152-183,315-331`). | Explorer components and editor commands; see `src/app/feature/explorer/tree.ts:...` (symbol `ExplorerTree`, exact line unverified). |
| Tabs/diff tabs/focus/dirty state | `src/app/core/store/tab.store.ts` (symbol `TabStore`) | Signal store (exact fields unverified) | TabStore methods; called from editor commands and app commands (`editor.commands.ts:153-154,272-276`; `app-commands.ts:83`). | Editor components/services (specific full reader list unverified). |
| Tasks | `src/app/feature/tasks/task.service.ts:39-54` | `TaskItem[]` signal plus selected-task signal/computed | `add/edit/delete` and task-specific methods in TaskService (`task.service.ts:86-109,115-133,138-188`). | Task list/view/new-task and notes/task anchor picker (`task-list.ts` symbol `TaskList`; `task-view.ts:16-33`; `new-task.ts:14,30`; `picker.service.ts:15-25`). |
| Notes | `src/app/feature/notes/note.service.ts:35-45` | `NoteItem[]` signal | `add/edit/delete` and anchor/status methods in NoteService (`note.service.ts:51-117`). | Note list/view, task view, anchor picker (`note-list.ts` symbol `NoteList`; `note-view.ts:24`; `task-view.ts:17,30-33`; `picker.service.ts:15-25`). |
| Current editor/active file | `TabStore.activeTabId` (field in `src/app/core/store/tab.store.ts`; exact line unverified); NodeStore `activeNodeId` (`node.state.ts:37`) | Active tab ID and active node ID; live editor models are a `Map<string, ModelEntry>` (`editor.service.ts:38-59`) | `EditorCommands` coordinates opening/closing and an effect synchronizes active tab to active node (`editor.commands.ts:35-43,151-154,272-276`). | Editor components/services; exact component call sites not exhaustively cited. |

`task.store.ts`, `note.store.ts`, and `setting.store.ts` are intentionally empty placeholders; task/note state resides in their services. (Empty files: `src/app/core/store/task.store.ts`, `note.store.ts`, `setting.store.ts`.)

### Project workspace state

- `WorkspaceStateService` persists expanded folder paths and supported open tabs to `.cairn/cache/workspace.json`; writes are debounced and use a temporary file followed by rename, with an immediate flush before window close or project switch. The snapshot contains no node IDs, selection, dirty flags, file content, or unsaved editor text.
- Restore runs after the workspace tree and the WorkSync task/note caches are loaded. Paths are resolved against the opened project; missing folders, files, tasks, notes, malformed entries, and unsupported schema versions are skipped.
- Task/note tabs use their record IDs. Code tabs use project-relative file paths. Diff tabs serialize their side descriptors with relative paths and rebuild worktree file IDs. Chat tabs are skipped because chat records are session-local; Review tabs currently have no stable review identifier or tab-opening implementation.
- Rust's watcher excludes `.cairn/cache` paths from `fs:changed` batches (`src-tauri/src/services/watcher.rs`, `explorer_passes` and its tests).
- This project snapshot is separate from `persistence.model.ts` and the existing `.ide/workspace.json` NodeState snapshot. The architecture decision that Rust alone reads/writes project data therefore does not describe this workspace-state file; it is Angular-owned as specified for this feature.

## 2. Tasks and notes

### Exact TypeScript shapes

```ts
// src/app/feature/tasks/task.service.ts:3-34
export type TaskStatus = 'ready' | 'running' | 'blocked' | 'completed';
export interface TaskAnchor {
  kind: 'file' | 'function' | 'ast'; path: string; label?: string; lineNumber?: number;
}
export interface SubTask {
  id: string; title: string; description?: string; status: TaskStatus;
  createdAt: number; updatedAt?: number;
}
export interface TaskItem {
  id: string; title: string; description?: string; anchor?: TaskAnchor;
  linkedNoteIds?: string[]; subTasks?: SubTask[]; dependsOn?: string;
  status: TaskStatus; createdAt: number; updatedAt?: number;
  acceptanceCriteria?: string; branch?: string;
}
```

```ts
// src/app/feature/notes/note.service.ts:3-30
export interface TaskAnchor { kind: 'task'; id: string; label: string; title: string; }
export interface AstAnchor { kind: 'ast'; id?: string; label: string; path: string; lost?: boolean; }
export type NoteAnchor = TaskAnchor | AstAnchor;
export type NoteStatus = 'open' | 'completed';
export interface NoteItem {
  id: string; content: string; type?: string; status: NoteStatus;
  anchors: NoteAnchor[]; createdAt: number; updatedAt?: number;
}
```

### Storage, methods, and component mutations

- Both services use in-memory Angular signals initialized to empty arrays. No `persistence.model.ts` reference occurs in either service; that model persists only IDE data and a selected subset of `NodeState` (`task.service.ts:39-43`; `note.service.ts:35-45`; `persistence.model.ts:4-32`).
- `TaskService` public methods (all in `src/app/feature/tasks/task.service.ts`): `select(id)` changes selection (52-54); `get(id)` reads (79-81); `add(data)` creates prepended task and UUID (86-110); `edit(id, updates)` patches task and timestamp, may block it on dependency change (115-133); `delete(id)` removes task and resets selected ID if needed (138-142); `setStatus(id,status)` edits and unblocks dependents on completion (147-154); `setAnchor(id,anchor)` changes anchor (159-161); `addLinkedNote(id,noteId)` appends unique linked note ID (163-167); `setDependency(id,dependsOn)` edits dependency/status (172-188); `addSubTask(taskId,subTask)` creates UUID subtask (193-216); `updateSubTask(taskId,subTaskId,updates)` patches subtask (221-234); `deleteSubTask(taskId,subTaskId)` removes subtask (239-245); `getDependentTasks(taskId)` reads dependents (250-252); `canStart(id)` checks readiness (257-265); `start(id)` sets running if allowed (270-274); `complete(id)` sets completed (279-281); `setAcceptanceCriteria(id,criteria)` edits criteria (286-288); `setBranch(id,branch)` edits branch (293-295). Private helpers compute initial status and unblock dependents (300-324).
- TaskService callers: `NewTask.createTask` calls `add` and `select` (`new-task.ts:49-68`); `TaskView` edits, starts, sets anchor, links notes (symbols/methods `updateTitle`, `startTask`, `task-view.ts:35-42,57-68`); task row calls delete (`task.ts` symbol `Task`, method `deleteTask`, exact line 22); remaining `TaskService` callers are the listed components and the `NoteService`-backed anchor picker. Per-method exhaustive caller mapping beyond these is unverified.
- `NoteService` public methods: `get(id)` read (47-49); `add(data)` prepends note, timestamp ID (51-67); `edit(id,updates)` replaces matching note and timestamp (69-73); `delete(id)` removes it (75-77); `setAnchors(id,anchors)` replaces anchors (79-81); `setAnchor(id,anchor)` clears/replaces one or many (83-91); `addAnchor(id,anchor)` appends (93-97); `removeAnchor(id,index)` removes by index (99-106); `setStatus(id,status)` edits status (108-110); `toggleStatus(id)` flips open/completed (112-117). Computed `openNotes`, `completedNotes`, and `inboxNotes` are declared at 41-45.
- NoteService callers: `NoteList` creates/selects (`note-list.ts` symbol `NoteList`, methods `add`/`create`, source lines unverified); `NoteView` edits content/type, appends anchors, deletes (`note-view.ts:77,84,119-139`); `Note` component deletes (`note.ts:288`); `TaskView` links note anchors (`task-view.ts:57-68`).
- Direct backing-state mutation by components: none found in scoped task/note TypeScript. Components call service methods. `NewTask` does mutate its own draft-only `subtasks` signal directly (`new-task.ts:20-41`), then passes values to `TaskService.add` (`49-65`); this is not mutation of persisted task state.
- Existing fields: task status, file/function/AST anchor with path/label/line, subtasks, linked note IDs, dependencies, acceptance criteria, branch; note status, task/AST anchors (including optional `lost`), and timestamps are present (`task.service.ts:3-34`; `note.service.ts:3-30`). Task and subtask IDs use `crypto.randomUUID()`; note IDs use `String(Date.now())`, which can collide for same-millisecond adds (`task.service.ts:97,205`; `note.service.ts:57-63`).

## 3. Command flow

- Keydown listener canonicalizes the key, picks a matching `when` context, then executes the registered command via `CommandService` (`keybinding.service.ts` symbols `init`, `setBindings`, `onKeyDown`, `pick`; exact lines unverified). `CommandService.execute` dispatches by ID to the registered handler and catches/logs errors (`command.service.ts` symbol `CommandService`, method `execute`; exact lines unverified). Default key assignments are unverified because the keybinding JSON lives under prohibited `src/assets`.
- Command IDs registered in scoped `app-commands.ts`: `file.save`, `file.saveAll`, `file.openFile`, `file.openFolder`, `tab.close`, `tab.next`, `tab.previous`, `view.toggleBottomPanel`, `search.file`, `explorer.selectAll`, `explorer.copy`, `explorer.cut`, `explorer.delete`, `explorer.rename`, `explorer.paste`, `git.toggleBlame` (`app-commands.ts` symbol `registerAppCommands`; registration lines mostly 20-77). The Git command handler belongs to excluded Git scope and is not analyzed here.
- File open path: explorer file activation calls `EditorCommands.openFile` (`explorer/tree.ts` symbol `ExplorerTree`, `file-node.ts:53-66`); command opens/loads file, calls `TabStore.openFile`, and sets active node (`editor.commands.ts:151-162`). File-save commands route through `EditorCommands.saveFile`, which reads editor content, writes via `NodeStore`, and marks the editor saved (`editor.commands.ts` symbols `saveFile`, `saveAll`; `app-commands.ts` registrations `file.save`/`file.saveAll`). Explorer CRUD IDs invoke NodeStore methods directly in app command handlers (`app-commands.ts` registrations); explorer actions can also call store methods from components (full inventory unverified).
- Direct store mutations outside owning store: EditorCommands calls NodeStore setters and TabStore `openFile`, `setDirty`, `closeMany` (`editor.commands.ts:40-43,81-82,153-154,193,272-276`). `registerAppCommands` reads/mutates TabStore for save/tab navigation and NodeStore for explorer commands (`app-commands.ts` symbol). `ReplaceService` sets dirty state directly (`src/app/core/services/replace.service.ts:91`; discovered as a call site, though that service is outside the requested read scope). Store state itself is still patched within the stores.
- Explorer CRUD uses NodeStore methods `selectAllSiblings`, `copySelection`, `cutSelection`, `deleteNodes`, `startRename`, `paste` (`app-commands.ts` registrations). The exact individual command-to-method mapping is in that file.

## 4. Tauri boundary

- Slice 3 adds `ProjectState` and a shared task/note service bundle in Rust; project paths are canonicalized on open and services are replaced when another project opens (`src-tauri/src/services/project.rs`). Tauri commands expose the task/note service API and broadcast the task/note/project events (`src-tauri/src/commands/{project,tasks,notes}.rs`). The exact client contract is in `docs/codemaps/project-apis.md#tasks-notes`.

- `TauriBridgeService.invokeCommand<T>(cmd,args)` forwards to Tauri `invoke<T>`; folder/file pickers use the dialog plugin (`tauri-bridge.service.ts:8-34`).
- Registered Rust commands (`src-tauri/src/lib.rs:44-77`): **fs** `read_directory_content`, `get_files`, `read_text_file`, `create_fs_node`, `workspace_search` (`commands/fs.rs:21-106`); **search** `global_search`, `search_files`; **git** `git_run`; **askpass** `askpass_answer`; **lsp** `lsp_start`, `lsp_send`, `lsp_stop`; **secrets** `secret_set`, `secret_get`, `secret_delete`; **models** `model_test_local`; **pty** `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`; **codemap** `codemap_open`, `codemap_close`, `codemap_update_files`, `codemap_tree`, `codemap_symbols_in_file`, `codemap_callers`, `codemap_callees`, `codemap_search`, `codemap_symbol_source`, `codemap_install_languages`, `codemap_missing_languages` (`commands/codemap.rs:47-166`); **diagnostics** `set_log_level`. Purpose for commands outside the permitted Rust files: unverified.
- Rust events/channels verified here: `workspace_search` streams `FileSearchResult` over a Tauri `Channel`; `codemap_open` sends `IndexProgress` on a `Channel` (`commands/fs.rs:103-106`; `commands/codemap.rs:47-75`). No Angular event listener/channel consumer found in the scoped bridge or codemap service; whether other excluded Angular code consumes channels is unverified. Bridge itself exposes only invoke and dialog picker methods (`tauri-bridge.service.ts:8-34`).
- Error convention in inspected fs/codemap commands is `Result<_, String>`; error strings are human-readable and mostly lowercase phrases. Exact convention across all uninspected command modules is unverified (`commands/fs.rs` symbols; `commands/codemap.rs:47-166`).
- Workspace root is passed into `codemap_open` from Angular as a path; Rust stores it in CodeMap state/service and resolves workspace-relative paths (`codemap.service.ts` symbol `open`; `commands/codemap.rs` symbol `codemap_open`; exact root-handling lines unverified). Filesystem commands accept explicit paths (`commands/fs.rs:21-36,80-106`).

### Workspace watcher

- Rust owns one active recursive `notify` watcher through `WorkspaceWatcher`; `watch_start` and `watch_stop` are registered Tauri commands. Registration runs on a dedicated OS thread. The callback applies the codemap ignore rules before queueing paths; a worker batches and deduplicates events for 100 ms and emits `fs:changed`, or an overflow batch above 2000 paths. Errors emit `fs:watch-error`.
- Angular `WorkspaceWatcherService` subscribes before invoking `watch_start`. It maps batches to the existing explorer/external-file handling path, publishes `fsEvents$` for git status refreshes, and does a full explorer/codemap refresh on overflow.
- The watcher passes `.git/HEAD`, `.git/index`, `.git/packed-refs`, and `.git/refs/**` for git status and drops other `.git` internals.

## 5. Existing Rust codemap

- Extracts named functions, methods, structs, enums, traits, signatures/spans, per-symbol body hashes, and call references; source extraction uses tree-sitter (`types/codemap.rs:41-67,93-125`; `services/codemap/extract.rs` symbol `Extractor`).
- Persists JSON at `<workspace>/.cairn/cache/codemap.json`; versioned store tracks files, symbols, calls and summary hashes (`services/codemap/store.rs` symbols `Store::open`, `Store::save`; tested location `store.rs:414-430`). Invalid/old JSON opens empty (`store.rs:433-441`).
- Indexing compares file metadata/content hashes, skips unchanged files, reparses changed files, prunes removed/ignored paths, and saves dirty store (`services/codemap/service.rs` symbols `index_workspace`, `update_files`; exact operational line ranges unverified). Symbol body hashes are blake3; summary staleness is `summary_hash != body_hash` for callable symbols (`types/codemap.rs:63-72`).
- Graph resolves callers/callees by call name and syntax kind; bare calls prefer same-file functions, path calls use qualifier/scope, `self` prefers same-type methods, and receiver method calls can remain ambiguous (`services/codemap/graph.rs:11-57`). `Link.exact` flags ambiguity (`types/codemap.rs:127-133`).
- Angular-facing queries: tree, symbols per file, callers, callees, search, symbol source, open/update, language installation/status (`commands/codemap.rs:47-166`). Angular service invokes `codemap_*` methods (`core/services/codemap/codemap.service.ts`, symbol `CodeMapService`; exact lines unverified).
- Production extraction currently enables Rust only; Zig is enabled in test configuration. Parsers are downloaded on demand after consent into app-data cache (`services/codemap/languages.rs:1-18,31-62`).

## 6. Blockers and surprises

- Tasks/notes are caches backed by Rust services (`task.service.ts`; `note.service.ts`). The older `persistence.model.ts` concerns IDE/workspace state, while project UI state is persisted separately by `WorkspaceStateService`.
- Notes use millisecond timestamp IDs while tasks use UUIDs (`note.service.ts:57-63`; `task.service.ts:97,205`); a Rust/JSON-RPC repository should account for ID uniqueness and wire-format compatibility.
- The task anchor model includes `function`/`ast`, but creation UI currently attaches only `kind: 'file'`; notes have AST/task anchors and `lost` marker (`task.service.ts:5-10`; `new-task.ts:44-47`; `note.service.ts:3-18`).
- The three named stores are empty placeholders, not current blockers; actual task/note state is service-owned. The empty task/note/setting store paths are listed above.
- NodeStore contains tree state and mirrors workspace root nodes in `rootNodes` and `nodes`; file node content and dirty state also intersect with editor model state (`node.state.ts:8-12,27-43`; `node.store.ts:30-47`; `editor.service.ts:38-59`). This is a synchronization boundary to preserve when moving persistence.
- Task and note models each define a different `TaskAnchor` interface (task file anchor vs note-to-task anchor), so avoid conflating their similarly named types (`task.service.ts:5-10`; `note.service.ts:3-8`).
- No circular import was confirmed in the inspected task/note service/component paths. Broader circular dependencies are unverified. `EditorCommands` is the explicit coordination layer between node store, tab store and editor service (`editor.commands.ts:18-23`).
- JSON-RPC/Python SDK interface is not present in the read scope; blockers beyond the current Tauri invoke boundary are unverified. Tauri bridge uses string command IDs and generic JSON-like argument records (`tauri-bridge.service.ts:8-11`).

## Files to read first

1. `src/app/feature/tasks/task.service.ts`
2. `src/app/feature/notes/note.service.ts`
3. `src/app/feature/tasks/task-view/task-view.ts`
4. `src/app/feature/notes/note-view/note-view.ts`
5. `src/app/shared/models/persistence.model.ts`
6. `src/app/core/store/node.store.ts`
7. `src/app/core/store/tab.store.ts`
8. `src/app/feature/editor/editor.commands.ts`
9. `src-tauri/src/commands/codemap.rs`
10. `src-tauri/src/services/codemap/service.rs`

## Slice 4 implementation update

- `TaskStore` and `NoteStore` now hold read-only id-keyed cache signals, load errors, and loaded state. `WorkSyncService` subscribes once during app initialization, opens/closes the project from `NodeStore.rootPath`, clears caches on root changes, and refreshes both lists on project reload. `WorkApiService` wraps the documented task/note/project commands and normalizes invoke rejections.
- `TaskService` and `NoteService` are now facades over those stores and the Tauri API. The task and note list/view, new-task form, and note-to-task promotion/link/delete flows now call async facade mutations; anchor picker and chat read through facade computed views.
- Contract gap: the API types describe `TaskPatch` with title and description only, but the pre-slice task editor also changed all task fields through `edit`. Dedicated commands cover most persisted fields, while there is no API command to mutate a task's `linkedNoteIds` as an array (the link/unlink commands are available) or task/subtask shapes beyond documented commands. Subtask completion UI is also unsupported by the command policy's `SubTaskPatch` status semantics and needs_review/failed transitions.

## Session history and startup

- Rust stores `last-session.json` in Tauri app data. A successful `project_open` canonicalizes and records the folder, moves it to the front of a ten-entry history, and atomically merges under an inter-process history lock. Corrupt or unsupported history reads as empty; folder-missing flags are computed for the UI.
- The app initializer opens a launch `--folder` argument first, otherwise the saved last project unless `--new-window` was supplied. Missing/unreadable startup folders leave the workspace empty. The Recent menu and empty-workspace view support reopen, open in a new process, remove, and clear.
- `window_new` starts the current executable as a separate process. On Windows it uses `DETACHED_PROCESS`; on Unix it spawns with standard streams detached. No `tauri-plugin-single-instance` dependency or registration is present.
- Same-project exclusion across processes is not implemented: `ProjectState`, the watcher, codemap, and run manager are process-local, so two processes can currently run workflows against the same project concurrently.
