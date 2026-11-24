# Explorer

## 1. Purpose and ownership

The explorer lists and mutates workspace files and folders, tracks expanded/selected
state, and reacts to external filesystem changes. Rust owns directory reads, node
creation, and the native watcher; Angular owns selection, expansion, inline creation,
and editor/cache state. The rule is violated for several mutations: Angular currently
uses `@tauri-apps/plugin-fs` directly for rename, delete, copy, mkdir, and save
([file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts:29),
[file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts:45)).

## 2. Data shapes

| Rust | Angular | Difference |
|---|---|---|
| `BaseNode { id, name, path, parentId }` | `BaseNode { id, name, path, parentId }` | Names and camelCase match. |
| `FileNode { base flatten, content, extension, isDirty }` | `FileNode { id,name,path,parentId, content, extension, isDirty }` | Shape matches the flat wire form; Rust can carry `isDirty`, but TS declares it with no explicit Rust round-trip use. |
| `FolderNode { base flatten, isExpanded, children }` | `FolderNode { id,name,path,parentId, children }` | Rust `isExpanded` is not in TS `FolderNode`; Angular keeps expansion in `FolderUiState` instead (`workspace_node.rs:24`, `node.state.ts:14`, `node.state.ts:20`). |
| `Node = File \| Folder` with serde untagged | `Node = FileNode \| FolderNode` | Discriminated structurally in TS by `extension` or `children` (`workspace_node.rs:34`, `node.state.ts:18`). |

The Rust and TS shapes are in
[workspace_node.rs](../../src-tauri/src/types/workspace_node.rs:1) and
[node.state.ts](../../src/app/core/store/node.state.ts:1).

## 3. Rust

### Services

- `get_directory_content(path)`: reads a directory, hides tree-private entries,
  creates UUID-backed file/folder nodes, and sorts folders first. Errors are
  `String` ([fs.rs](../../src-tauri/src/services/fs.rs:8)).
- Node creation rejects an existing target, creates a folder or empty file, and
  returns a node; unknown types and I/O errors are `String`
  ([fs.rs](../../src-tauri/src/services/fs.rs:169)).
- `WorkspaceWatcher::subscribe/start/stop`: subscribes or starts/stops the native
  watcher ([watcher.rs](../../src-tauri/src/services/watcher.rs:84)).
- `run_watch/emit_batch/emit_error`: filters, batches, and emits filesystem events;
  internal `.cairn/tasks|notes` events are also delivered to Rust listeners
  ([watcher.rs](../../src-tauri/src/services/watcher.rs:103),
  [watcher.rs](../../src-tauri/src/services/watcher.rs:172),
  [watcher.rs](../../src-tauri/src/services/watcher.rs:216)).

### Commands

Tauri command arguments, results, and errors: see
[explorer nodes](./nodes.md).

### Events

- `fs:changed`: `WatchBatch { events: [{ kind: create|modify|remove|rename|other,
  paths }], overflow }` ([watcher.rs](../../src-tauri/src/services/watcher.rs:195)).
- `fs:watch-error`: `{ message }` ([watcher.rs](../../src-tauri/src/services/watcher.rs:218)).

## 4. Angular

### API wrapper

`FileSystemService` wraps the watcher, directory, file-read, and node-creation
commands through `TauriBridgeService`
([file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts:19),
[file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts:147)).
It also directly calls plugin-fs methods for rename, remove, copy, mkdir, file
creation, and save ([file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts:29)).
Its methods rethrow or return `null` only where the implementation catches stat/picker
results; there is no shared structured error type.

### Store signals

`NodeStore` exposes `rootPath`, `rootName`, `rootNodes`, `nodes`,
`explorerUiState`, `activeNodeId`, `renamingNodeId`, `selectionAnchorId`,
`selectedNodeIds`, `clipboard`, and `isWorkspaceLoading`
([node.store.ts](../../src/app/core/store/node.store.ts:30)).

### Store/facade methods

- `loadFolder(path)`, `refreshExplorer()`, `_loadFolder(id)`, `fetchFileContent(id)`,
  `writeFile(id, content)`: load, rescan, and read/write file state
  ([node.store.ts](../../src/app/core/store/node.store.ts:164),
  [node.store.ts](../../src/app/core/store/node.store.ts:285),
  [node.store.ts](../../src/app/core/store/node.store.ts:316),
  [node.store.ts](../../src/app/core/store/node.store.ts:332)).
- `submitInlineCreation`, `commitRename`, `deleteNodes`, `moveNode/moveNodes`,
  `paste`, `applyCreated`, `applyRemoved`, `applyRenamed`: mutate tree state after
  plugin-fs or Tauri operations ([node.store.ts](../../src/app/core/store/node.store.ts:358),
  [node.store.ts](../../src/app/core/store/node.store.ts:485)).
- `WorkspaceWatcherService.start/stop/process` listens for `fs:changed` and
  `fs:watch-error`, refreshes the tree, and starts/stops native watching
  ([workspace-watcher.service.ts](../../src/app/core/services/file-system/workspace-watcher.service.ts:32),
  [workspace-watcher.service.ts](../../src/app/core/services/file-system/workspace-watcher.service.ts:63)).

## 5. Flows

- **Open folder:** app action -> `NodeStore.loadFolder(path)` -> `getRootFolder`
  -> Rust directory read -> patch NodeStore. Watcher start -> native watcher -> `fs:changed` ->
  `WorkspaceWatcherService` -> `applyCreated/Removed/Renamed/Modified`.
- **Expand folder:** folder click -> `toggleFolder()` -> `toggleFolderExpansion`
  -> `_loadFolder` -> `readDirectoryContents` -> Rust directory read ->
  Rust scan -> patch `nodes`/folder `children`.
- **Open file:** file click -> `fetchFileContent(id)` -> Rust file read ->
  patch file `content` -> `EditorCommands.openFile`.
- **Create/rename/delete/move/copy:** component/store action -> `NodeStore`
  mutation method -> plugin-fs or the Rust node-creation command -> immediate `patchState`
  (`create`) / `applyRenamed/Removed/Created` -> watcher may repeat but state is
  reconciled. No Rust mutation event is emitted for plugin-fs operations.
- **External change:** native notify -> `fs:changed` -> Angular listener ->
  queue -> `applyCreated/Removed/Renamed/onModify` -> `patchState`; external
  file content is read through the Rust file-read command and conflict/reload logic runs.

## 6. Gaps

- Explorer mutation ownership is incomplete: save/rename/delete/copy/mkdir use
  Angular plugin-fs directly, not Rust services or Tauri commands.
- Workspace search walks and searches files inside the Tauri command boundary;
  it does not call an explicit Rust service function ([fs.rs](../../src-tauri/src/commands/fs.rs:120)).
- Rust `FolderNode.isExpanded` has no TS field; Angular's separate UI state is the
  only expansion source. This is intentionally a UI-state split, not established as
  complete in Rust.
- `FileNode.isDirty` exists on both sides, but Angular `isDirty` is declared and
  Rust `isDirty` is produced; whether it is synchronized with TabStore is unverified.
- External-edit conflict handling, own-save suppression, and watcher batching are
  implemented in Angular because Rust emits generic filesystem events.
- End-to-end native search streaming, Unix watcher behavior, and release behavior
  are unverified.

## 7. Logic in the wrong layer

| File:line | What it does | Where it belongs |
|---|---|---|
| `src-tauri/src/commands/fs.rs:103-169` | Workspace search performs walking, exclusion, cancellation, file opens, line scanning, and result channel output in the command boundary. | Rust filesystem/search service; command only validates args and delegates. |
| `src/app/feature/explorer/node/node-dnd.directive.ts:126-143` | Drag/drop descendants prevent and duplicate move-target validation in the directive. | `NodeStore` move/copy policy; directive should only collect UI events. |
