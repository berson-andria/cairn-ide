# Workspace

## 1. Purpose and ownership

A workspace is the currently open project directory plus Angular UI and
workspace-state caches. Rust owns the project root, task/run/project data, and
session history; Angular owns window/UI state and persists tabs, folders, and
diff state under the workspace. Rust is the reader/writer of project data
(`docs/CONTEXT.md:62-67`); the workspace row identifies the Rust and Angular
files (`docs/MAP.md:439`).

Session history is app data, not project data: Rust writes
`<app-data>/last-session.json`; Angular reads it through the API
(`src-tauri/src/services/session_history.rs:9-12`,
`src-tauri/src/services/session_history.rs:61-68`,
`src/app/core/services/project-history.service.ts:9-16`).

## 2. Data shapes

| Rust | TypeScript | Difference |
|---|---|---|
| `LaunchArgs { folder: Option<String>, new_window: bool }` camelCased by serde | `LaunchArgs { folder?: string, newWindow: boolean }` | Missing Rust `folder` becomes absent; field names differ until JSON camelCase. |
| `ProjectEntry { path, name, last_opened_at }` | `ProjectHistoryEntry { path, name, lastOpenedAt, missing }` | Rust JSON camelCases `last_opened_at`; snapshot adds `missing`. |
| `SessionHistory { schema_version, last_project, projects }` | `ProjectHistorySnapshot { lastProject, projects }` | Angular sees only snapshot fields, not persisted schema version. |
| `WorkspaceStateFile { schemaVersion, expandedFolders, tabs, focus }` | same-name TypeScript model | Rust does not own this file; it is a cache/state file under `.cairn/cache/workspace.json` (`src/app/core/services/workspace-state.service.ts:12-16`, `src/app/shared/models/workspace-state.model.ts:1-20`). |

Line and field claims are from
`src-tauri/src/commands/project.rs:9-36`,
`src-tauri/src/services/session_history.rs:13-38`,
and `src/app/core/services/tauri/work-api.service.ts:38-53`.

## 3. Rust

### Services

| Service/function | Does | Errors |
|---|---|---|
| `ProjectState::open` | Validate and canonicalize directory, install task/note/proposal services, recover interrupted work. | `Validation`, `Io` (`src-tauri/src/services/project.rs:133-180`). |
| `ProjectState::close` | Clear the held project state. | `Io` (`src-tauri/src/services/project.rs:228-234`). |
| `ProjectState::root_path/services` | Read current root or require an open project. | `Io`, `NoProject` (`src-tauri/src/services/project.rs:213-227`). |
| `session_history::record_open` | Record canonical path, timestamp, name, merge concurrent writes, and cap history. | `io::Result` (`src-tauri/src/services/session_history.rs:101-119`). |
| `session_history::snapshot/remove_project/clear_projects/clear_last_project` | Build missing-aware snapshot or mutate history. | `io::Result` (`src-tauri/src/services/session_history.rs:76-99`, `src-tauri/src/services/session_history.rs:121-139`). |

### Commands

| Command | JS args | Returns |
|---|---|---|
| `project_open` | `path` | canonical root string |
| `project_close` | — | `void` |
| `launch_args` | — | `{ folder?, newWindow }` |
| `window_new` | `folder?` | `void` |
| `project_history` | — | `ProjectHistorySnapshot` |
| `project_history_remove` | `path` | `void` |
| `project_history_clear` | — | `void` |

Registered in `src-tauri/src/lib.rs:79-85`; implementations and args are in
`src-tauri/src/commands/project.rs:23-142`.

### Events

The project switch emits no dedicated `project:opened` event. Domain services
emit normal reload/update events; workspace close/open is coordinated through
the Angular event subscription and refresh (`src/app/core/services/tauri/work-sync.service.ts:50-68`,
`src/app/core/services/tauri/work-sync.service.ts:93-115`).

## 4. Angular

`WorkApiService.projectOpen/projectClose/launchArgs/windowNew/projectHistory*`
wrap the seven project commands and normalize object vs string rejections
(`src/app/core/services/tauri/work-api.service.ts:41-53`,
`src/app/core/services/tauri/work-api.service.ts:72-91`).

Stores/signals:

- `ProjectHistoryService.history()` exposes the snapshot.
- `NodeStore` owns `rootPath`, folder nodes, loading state
  (`src/app/core/store/node.store.ts:161-184`).
- `TabStore` owns open tabs and restore/focus state
  (`src/app/core/services/workspace-state.service.ts:25-31`,
  `src/app/core/services/workspace-state.service.ts:91-125`).
- `TaskStore` and `NoteStore` are caches cleared/refilled during workspace open
  (`src/app/core/services/tauri/work-sync.service.ts:85-115`).

| Facade | Signature | Calls/errors |
|---|---|---|
| `ProjectStartupService.initialize` | `Promise<void>` | Launch/history APIs, path existence, startup folder selection; handled by `handleApiError` (`src/app/core/services/project-startup.service.ts:23-48`). |
| `ProjectHistoryService.refresh/remove/clear/openInNewWindow` | `Promise<void>` | History commands; handled via `handleApiError` (`src/app/core/services/project-history.service.ts:14-44`). |
| `WorkspaceStateService.prepareProjectSwitch/restoreProject/close flush` | async methods | Angular Tauri FS APIs; reports save/restore errors and does not call Rust project commands itself (`src/app/core/services/workspace-state.service.ts:67-103`, `src/app/core/services/workspace-state.service.ts:226-238`). |
| `WorkSyncService.waitForProjectLoaded/open/refresh` | async methods | Closes/opens project and refreshes task/note/proposal/run/workflow caches (`src/app/core/services/tauri/work-sync.service.ts:71-115`). |

## 5. Flows

**Startup:** app calls `ProjectStartupService.initialize`; it fetches
`launch_args` and `project_history` together, chooses explicit folder, otherwise
last project unless `newWindow`, checks existence, loads the node folder, then
waits/restores workspace state (`src/app/core/services/project-startup.service.ts:23-48`,
`src/app/shared/models/project-startup.model.ts:3-12`). The exact path is:
UI/init -> API -> Rust commands -> `ProjectState` -> refresh.

**Subscribe/open/refresh:** `WorkSyncService` subscribes to work events in its
constructor, observes `NodeStore.rootPath`, then clears caches and awaits event
subscription. It calls `project_close` for no path or `project_open(path)` for a
folder, refreshes history, awaits task/note refresh, and starts proposal/run/
workflow refreshes concurrently (`src/app/core/services/tauri/work-sync.service.ts:50-68`,
`src/app/core/services/tauri/work-sync.service.ts:85-115`).

**Open via UI:** component/service calls `EditorCommands.openProject`;
save current state, close tabs, load folder, restore workspace state
(`src/app/feature/editor/editor.commands.ts:294-310`). Node root change triggers
`WorkSyncService` to subscribe/close/open/refresh.

**Close:** UI saves/restores state first, closes tabs, then `NodeStore.closeFolder`;
root change calls `project_close`, which cancels active runs and clears the last
project marker (`src/app/feature/editor/editor.commands.ts:312-320`,
`src-tauri/src/commands/project.rs:95-121`).

**History:** open success calls `session_history::record_open`, history refresh
reads app-data snapshot; remove/clear mutate and refresh
(`src-tauri/src/commands/project.rs:63-72`,
`src-tauri/src/commands/project.rs:124-142`,
`src/app/core/services/project-history.service.ts:14-35`).

## 6. Gaps

- The Rust `ProjectState` does not emit `project:reloaded` on open/close;
  Angular coordinates refresh (`src-tauri/src/services/project.rs:133-180`,
  `src/app/core/services/tauri/work-sync.service.ts:93-115`).
- `project_open`/close history behavior and run cancellation are in command
  implementations rather than a separate project service
  (`src-tauri/src/commands/project.rs:63-121`).
- Listed missing folders remain in history with `missing: true`; they are not
  deleted automatically and can be opened only after existence is restored
  (`src-tauri/src/services/session_history.rs:90-99`,
  `src/app/shared/models/project-startup.model.ts:3-12`).
- History is capped at 10 newest entries and is stored in
  `<app-data>/last-session.json` with a `<app-data>/last-session.lock`
  (`src-tauri/src/services/session_history.rs:9-12`,
  `src-tauri/src/services/session_history.rs:42-54`,
  `src-tauri/src/services/session_history.rs:119-139`).
- Corrupt or schema-v2 history is treated as empty; behavior of concurrent
  stale writes is lock/merge-based and tested
  (`src-tauri/src/services/session_history.rs:61-74`,
  `src-tauri/src/services/session_history.rs:147-156`,
  `src-tauri/src/services/session_history.rs:215-260`).
- `launch_args` reads process args `--folder` and `--new-window`; it returns
  `{ folder, newWindow }`, and `ProjectStartupService` is its caller
  (`src-tauri/src/commands/project.rs:23-36`,
  `src/app/core/services/project-startup.service.ts:23-27`).

## 7. Logic in the wrong layer

| Path:line | Finding |
|---|---|
| `src-tauri/src/commands/project.rs:63` | `project_open` performs run cancellation and session-history I/O instead of delegating project, run, and history services. |
| `src-tauri/src/commands/project.rs:95` | `project_close` performs run cancellation and app-data history mutation instead of delegating project, run, and history services. |
