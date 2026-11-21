# Tabs and editor

## 1. Purpose and ownership

The editor domain owns the active/main Monaco view, open-tab metadata, tab
dirty state, Monaco models, and diff-side models. Angular owns this data:
`TabStore` owns tabs and focus history, `EditorService` owns live Monaco models,
and `EditorCommands` coordinates tabs with the explorer and saves
([tab.store.ts](../../src/app/core/store/tab.store.ts):38,
[editor.service.ts](../../src/app/feature/editor/services/editor.service.ts):41,
[editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):29).
Rust owns workspace-node and filesystem reads/writes only; there is no Rust
tab, editor, or Monaco state (MAP row:
[MAP.md](../MAP.md):470).

## 2. Data shapes

| Rust type | Angular type | Difference |
|---|---|---|
| `BaseNode { id, name, path, parent_id }` | `BaseNode { id, name, path, parentId }` | Rust emits camelCase by serde; TS uses `parentId` ([workspace_node.rs](../../src-tauri/src/types/workspace_node.rs):3). |
| `FileNode { base flattened, content, extension, is_dirty }` | `FileNode { ...BaseNode, content, extension, isDirty }` | `isDirty -> isDirty`; folder differs below ([workspace_node.rs](../../src-tauri/src/types/workspace_node.rs):13, [node.state.ts](../../src/app/core/store/node.state.ts):8). |
| `FolderNode { base flattened, is_expanded, children }` | `FolderNode { ...BaseNode, children }` | Rust has `isExpanded`; TS stores folder expansion in `FolderUiState` ([workspace_node.rs](../../src-tauri/src/types/workspace_node.rs):21, [node.state.ts](../../src/app/core/store/node.state.ts):20). |
| - | `Tab { id, type, title?, data? }` / `TabState { openedTabs, focusHistory, diffTabs, dirty }` | No Rust tab shape ([tab.store.ts](../../src/app/core/store/tab.store.ts):5). |
| - | `DiffSide`, `DiffRequest`, `DiffTab` | Angular-only diff-model metadata ([diff-tab.ts](../../src/app/feature/editor/features/diff-tab.ts):3). |

`Node` is Rust untagged `FileNode | FolderNode`; Angular is the same union shape
([workspace_node.rs](../../src-tauri/src/types/workspace_node.rs):30,
[node.state.ts](../../src/app/core/store/node.state.ts):13).

## 3. Rust

**Services**

- `get_directory_content(path: &Path)`: scans one directory, filters hidden
  entries, builds/sorts nodes, and writes no file content ([fs.rs](../../src-tauri/src/services/fs.rs):8). Errors are `Result<Vec<Node>, String>`.
- `create_fs_node(path, name, node_type, parent_id)`: creates a file/folder node
  and returns `Node`; rejects existing paths ([fs.rs](../../src-tauri/src/services/fs.rs):169). Errors are `String`.

**Commands**

- `read_directory_content(path: String) -> Result<Vec<Node>, String>` ([fs.rs](../../src-tauri/src/commands/fs.rs):21).
- `get_files(path: Vec<String>) -> Result<Vec<FileNode>, String>` ([fs.rs](../../src-tauri/src/commands/fs.rs):36).
- `read_text_file(path: String) -> Result<String, String>` ([fs.rs](../../src-tauri/src/commands/fs.rs):80).
- `create_fs_node(path, name, node_type, parent_id) -> Result<Node, String>` ([fs.rs](../../src-tauri/src/commands/fs.rs):93).

Args are camelCase in TypeScript wrappers; Rust IPC uses `nodeType` and
`parentId` in `invoke` args ([file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts):162).

**Events:** none emitted by the editor-specific Rust commands; filesystem
changes are watcher events owned by the watcher domain.

## 4. Angular

- `FileSystemService`: `readDirectoryContents`, `getFileTextContent`,
  `saveFile`, `selectAndOpenFile`, `createPhysicalDiskNode`; `saveFile` uses
  `writeTextFile` directly, not an editor Rust command
  ([file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts):147).
- `NodeStore`: tab-related calls include `fetchFileContent`, `writeFile`,
  `resolveFileId`, `loadFolder`, `pickFolder`, `addStandaloneFiles`, and
  `createPathFromSearch`; read/write failures are console-logged and writes throw
  from `writeFile` ([node.store.ts](../../src/app/core/store/node.store.ts):316,
  [node.store.ts](../../src/app/core/store/node.store.ts):331).
- `TabStore` signals: `activeTab`, `activeTabId`, `activeTabType`, `openTabs`,
  `dirtyIds`, `dirtyCount`; methods open/focus/close/reorder tabs
  ([tab.store.ts](../../src/app/core/store/tab.store.ts):46).
- `EditorCommands`: `openFile`, `openPath`, `openPathAtLine`,
  `saveFile(id): Promise<boolean>`, `saveAll`, `closeTabs`, `openProject`,
  `closeFolder`, `refreshExplorer`; save failures return `false`, while node
  read/write methods generally log and surface no structured error
  ([editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):143,
  [editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):215).
- `EditorService` owns `isReady`, `modelsVersion`, `contentVersion`,
  mounting, model acquisition/release, dirty tracking, and save-state methods.
- `ModelSourceService` maps working files and Git sides to Monaco models and
  refreshes live HEAD/index snapshots ([model-source.service.ts](../../src/app/feature/editor/services/model-source.service.ts):31).

## 5. Main flows

- **Open file:** UI -> `EditorCommands.openFile` -> `NodeStore.fetchFileContent`
  if needed -> `FileSystemService.getFileTextContent` -> Rust
  `read_text_file` -> NodeStore patches `content` -> `TabStore.openFile` -> code
  component effects -> `ModelSourceService.acquireFile` -> `EditorService.acquireModel`
  ([editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):143,
  [file-system.service.ts](../../src/app/core/services/file-system/file-system.service.ts):153).
- **Save file:** Ctrl+S/component callback -> `EditorCommands.saveFile` ->
  optional `EditorService.formatModel` -> `NodeStore.writeFile` ->
  `FileSystemService.saveFile` -> `writeTextFile` -> `EditorService.markSaved`
  ([editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):215).
- **Close tab:** close UI -> `EditorCommands.closeTabs` -> dirty/owner checks ->
  save/discard dialog -> `TabStore.closeMany` -> active node/selection updates
  ([editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):256).
- **Open project:** UI -> `EditorCommands.openProject` -> close dirty tabs ->
  `NodeStore.loadFolder` -> `FileSystemService.getRootFolder`/directory Rust
  commands -> NodeStore patch -> project restore reopens files
  ([editor.commands.ts](../../src/app/feature/editor/editor.commands.ts):294).
- **Open diff:** Git/UI -> `TabStore.openDiff` -> diff component
  -> `ModelSourceService.acquire` -> working-file or Git read -> Monaco models
  -> diff handle; no Rust editor event/store listener is involved
  ([tab.store.ts](../../src/app/core/store/tab.store.ts):126,
  [diff-editor.component.ts](../../src/app/feature/editor/features/diff-editor.component.ts):216).

## 6. Gaps

- Rust tab/editor state does not exist; persistence is unverified.
- File saves bypass Tauri `read_text_file`/filesystem commands via plugin
  `writeTextFile`, so save errors are plugin/Tauri behavior, unverified here.
- External-edit reload for editor models is unverified in this scope.
- The `Open file` diff button is a disabled/commented placeholder
  ([diff-editor.component.ts](../../src/app/feature/editor/features/diff-editor.component.ts):43).
- `EditorService.loading` retries only failed dynamic imports; retry/unload
  behavior beyond that is unverified.

## 7. Logic in the wrong layer

| File:line | What it does | Where it belongs |
|---|---|---|
| `src/app/feature/editor/features/diff-editor.component.ts:216` | Manages diff-model acquisition, stale-load races, missing-model errors, and held-side release in the component. | `ModelSourceService` should own source resolution/race-safe acquisition and held-model lifecycle; component should only mount and render the resulting handle. |
