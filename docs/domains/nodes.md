# Explorer nodes

## 1. Purpose and ownership

The nodes domain is the explorer's workspace tree: Rust reads the directory
filesystem and constructs initial Node records, while Angular owns the cache,
selection, expansion, and UI operations. The Angular `NodeStore` and
`FileSystemService` are the frontend writers for direct tree edits; Rust services
also read/create nodes for Tauri commands. [src-tauri/src/services/fs.rs:1]
[src/app/core/store/node.store.ts:70]
[src/app/core/services/file-system/file-system.service.ts:18]

The Rust side does not own persistent node records: directory reads create
fresh IDs, and Angular mutates in-memory state and uses Tauri/plugin-FS calls.
The project row distinguishes nodes/tabs as Angular-owned data.
[docs/CONTEXT.md:62] [src-tauri/src/types/workspace_node.rs:1]

## 2. Data shapes

| Rust | TypeScript | Notes |
|---|---|---|
| `BaseNode { id, name, path, parentId }` | `interface BaseNode { id, name, path, parentId }` | Same camelCase wire names; Rust enum flatten uses the base fields. [src-tauri/src/types/workspace_node.rs:3] [src/app/core/store/node.state.ts:1] |
| `FileNode { base, content, extension, isDirty }` | `FileNode extends BaseNode { content, extension, isDirty }` | Rust base is flattened in JSON; TypeScript extends BaseNode. [src-tauri/src/types/workspace_node.rs:12] [src/app/core/store/node.state.ts:8] |
| `FolderNode { base, isExpanded, children }` | `FolderNode extends BaseNode { children }` | Rust has `isExpanded`; TypeScript keeps expansion in separate `FolderUiState.isExpanded`. [src-tauri/src/types/workspace_node.rs:19] [src/app/core/store/node.state.ts:14] [src/app/core/store/node.state.ts:24] |
| `Node = File \| Folder` | `Node = FileNode \| FolderNode` | Rust uses an untagged enum; TypeScript distinguishes by `extension` vs `children`. [src-tauri/src/types/workspace_node.rs:27] [src/app/core/store/node.state.ts:18] |
| `LineMatch { lineNumber, text }` | No dedicated node-store type found | Search-stream result is typed in Rust; Angular receives the Tauri channel shape unverified. [src-tauri/src/types/workspace_node.rs:35] |

IDs are UUIDs; Rust generates a new UUID for every directory listing and file
lookup, so refreshes replace identity. [src-tauri/src/services/fs.rs:30]
[src-tauri/src/services/fs.rs:70] This differs from stable persistent records.

## 3. Rust

### Services
- `get_directory_content(path) -> Result<Vec<Node>, String>`: reads/filters/sorts
  a directory and returns file/folder nodes. Errors: string read/IO errors.
  [src-tauri/src/services/fs.rs:8]
- `create_fs_node(path,name,node_type,parent_id) -> Result<Node,String>`:
  creates a directory or empty file and returns a Node. Errors: existing path,
  unknown type, create/IO failures. [src-tauri/src/services/fs.rs:169]
- `WorkspaceWatcher.start/stop/subscribe`: starts/stops recursive watching,
  batches and emits filesystem events. [src-tauri/src/services/watcher.rs:52]

### Commands

| Command | JS arguments (camelCase) | Return |
|---|---|---|
| `read_directory_content` | `path` | `Result<Vec<Node>, String>` |
| `get_files` | `path` | `Result<Vec<FileNode>, String>` |
| `read_text_file` | `path` | `Result<String, String>` |
| `create_fs_node` | `path`, `name`, `nodeType`, `parentId` | `Result<Node, String>` |
| `workspace_search` | `dirPath`, `searchTerm`, `onMatch` | `Result<(), String>` |

The command implementations and error behavior are in
[fs.rs](../../src-tauri/src/commands/fs.rs); its cancellation state is injected
by Tauri and is not a JavaScript argument. Watcher command details are in
[watcher and filesystem events](./watcher-fs.md).

### Events
- `fs:changed`: payload `{ events: [{ kind, paths }], overflow }`, batched
  `create|modify|remove|rename|other` changes. [src-tauri/src/services/watcher.rs:193]
- `fs:watch-error`: `{ message }`. [src-tauri/src/services/watcher.rs:216]
No `task:...`-style node event exists for direct Rust node mutations.

## 4. Angular

### API wrapper
`FileSystemService` wraps:
- `readDirectoryContents(folderPath)`, `getFileTextContent(filePath)`,
  `createPhysicalDiskNode(path,name,nodeType,parentId)`;
- `selectAndOpenFile()`, `renamePath`, `removePath`, `copyPath`,
  `makeDirectory`, `createEmptyFile`, `saveFile`, `getNodeKind`;
- `startWorkspaceWatcher`, `stopWorkspaceWatcher`.

These invoke Tauri or plugin-FS APIs. Plain I/O failures propagate; `pathExists`
and `getNodeKind` normalize false/null, and dialogs return dialog results.
[src/app/core/services/file-system/file-system.service.ts:27]
[src/app/core/services/file-system/file-system.service.ts:107]
[src/app/core/services/file-system/file-system.service.ts:135]

### Store signals
`NodeStore` exposes state signals: `rootPath`, `rootName`, `rootNodes`, `nodes`,
`explorerUiState`, `activeNodeId`, `selectedNodeIds`, `selectionAnchorId`,
`clipboard`, `renamingNodeId`, `rootInlineCreation`, and `isWorkspaceLoading`.
[src/app/core/store/node.store.ts:27]

### Store methods
Load/refresh: `pickFolder`, `loadFolder`, `closeFolder`, `refreshExplorer`,
`fetchFolderContents`, `addStandaloneFiles`, `fetchFileContent`, `writeFile`.
Selection/UI: `toggleFolderExpansion`, `selectNode`, `selectAllSiblings`,
`clearSelection`, `revealInExplorer`, `expandFolder`, and inline form methods.
Filesystem: `submitInlineCreation`, `commitRename`, `deleteNodes`, `moveNode`,
`moveNodes`, `paste`, `createPathFromSearch`, `applyCreated`, `applyRemoved`,
`applyRenamed`, `setContent`.
[src/app/core/store/node.store.ts:75]
[src/app/core/store/node.store.ts:164]
[src/app/core/store/node.store.ts:358]
[src/app/core/store/node.store.ts:485]
[src/app/core/store/node.store.ts:746]

Errors are mostly handled by logging or returned as string messages; unknown
file IDs throw `Unknown file` in `writeFile`, and OS scan failures are logged and
left retryable. [src/app/core/store/node.store.ts:316]
[src/app/core/store/node.store.ts:332]

## 5. Main flows

1. **Open folder:** UI/editor opens project -> `NodeStore.loadFolder(path)` ->
  `FileSystemService.getRootFolder` -> `read_directory_content` -> Rust
  `get_directory_content` -> patch `rootPath/rootNodes/nodes`; no node event.
  [src/app/core/store/node.store.ts:164]
  [src/app/core/services/file-system/file-system.service.ts:120]
2. **Expand folder:** folder click -> `toggleFolderExpansion` then
  `fetchFolderContents` -> `read_directory_content(path)` -> Rust scan -> patch
  children/UI state. [src/app/core/store/node.store.ts:284]
3. **Open file:** file row -> `fetchFileContent` if needed -> Tauri
  `read_text_file` -> patch file content -> `EditorCommands.openFile` creates
  tab/editor model. [src/app/core/store/node.store.ts:316]
  [src/app/feature/explorer/node/file-node/file-node.ts:47]
4. **Save file:** editor/command -> `NodeStore.writeFile` ->
  plugin-FS `writeTextFile` -> `setContent` -> tab dirty state update.
  [src/app/core/store/node.store.ts:332]
  [src/app/feature/editor/editor.commands.ts:215]
5. **Create/rename/delete/copy/move:** explorer/store -> Tauri or plugin-FS
  wrapper -> filesystem change -> immediate `apply...` patch or watcher event
  -> `fs:changed` -> `WorkspaceWatcherService.process` -> store `apply...`.
  [src/app/core/store/node.store.ts:358]
  [src/app/core/store/node.store.ts:485]
  [src/app/core/services/file-system/workspace-watcher.service.ts:112]

## 6. Gaps

- Direct Rust node writes and node-specific events are absent; external changes
  arrive only through `fs:changed`/`fs:watch-error`. [docs/CONTEXT.md:66]
- Node IDs are random per Rust scan and external-store reconstruction; stable
  identity across refresh is unverified. [src-tauri/src/services/fs.rs:30]
- Rust `FolderNode.isExpanded` is not the Angular wire shape used by
  `NodeStore`; Angular keeps expansion separately. [src-tauri/src/types/workspace_node.rs:19]
  [src/app/core/store/node.state.ts:24]
- Search streaming and cancellation have no documented Angular wrapper type;
  only Rust channel use is confirmed. [src-tauri/src/commands/fs.rs:103]
- Delete/rename/copy/move are plugin-FS/Rust filesystem operations, not a
  unified Rust nodes service.

## 7. Logic in the wrong layer

| File:line | What it does | Where it belongs |
|---|---|---|
| `src-tauri/src/commands/fs.rs:21-89` | Directory existence/type validation and file I/O live in Tauri command functions. | Rust filesystem service; commands should validate/delegate only. |
| `src-tauri/src/commands/fs.rs:103-169` | Workspace walking, exclusion, cancellation, file scanning, and channel output live in the command boundary. | Rust filesystem/search service; command should only delegate and return. |
| `src-tauri/src/commands/watcher.rs:8-24` | Absolute-path validation and watcher lifecycle mutation live in commands. | Rust watcher service; commands should dispatch and return. |
| `src/app/feature/explorer/node/node-dnd.directive.ts:126-143` | Static drag/drop target validation and dialog sequencing duplicate move-policy checks. | `NodeStore` move/copy policy; directive should emit UI actions only. |
