# Tabs and editor

## 1. Purpose and ownership

Tabs and Monaco editor state belong to Angular, not Rust: the tab store owns open-tab metadata, focus, diff metadata, and dirty IDs, while `EditorService` owns live Monaco models and `EditorCommands` coordinates tabs, nodes, saves, and project switches. Persistence is also Angular-owned in `WorkspaceStateService`, writing `.praide/cache/workspace.json`. [src/app/core/store/tab.store.ts:40] [src/app/feature/editor/services/editor.service.ts:50] [src/app/feature/editor/editor.commands.ts:20] [src/app/core/services/workspace-state.service.ts:15]

No Rust tab/editor Rust type, service, Tauri command, or event is listed for this row in `docs/MAP.md:472`; the Rust side for these data shapes is therefore unverified by this domain review.

## 2. Data shapes

| Rust | TypeScript | Notes |
|---|---|---|
| None found | `Tab<T>`: `id`, `type`, `title?`, `data?` | Angular-only tab record. [src/app/core/store/tab.store.ts:6] |
| None found | `TabContentType`: `CodeEditor \| DiffEditor \| Task \| Review \| Note \| Chat` | Exact wire/storage union. [src/app/core/store/tab.store.ts:4] |
| None found | `TabState`: `openedTabs`, `focusHistory`, `diffTabs`, `dirty` | Angular signal-store state. [src/app/core/store/tab.store.ts:10] |
| None found | `DiffSide`: `empty`, `worktree`, `index`, `head`, or `commit` | Diff request metadata; only worktree side has `fileId`. [src/app/feature/editor/features/diff-tab.ts:1] |
| None found | `DiffRequest`: `original`, `modified` | Diff sides. [src/app/feature/editor/features/diff-tab.ts:10] |
| None found | `DiffTab`: `id`, `title`, `request` | Diff-specific metadata held in `TabStore.diffTabs`. [src/app/feature/editor/features/diff-tab.ts:15] |
| None found | `WorkspaceStateFile`: `schemaVersion`, `expandedFolders`, `tabs`, `focus` | Persisted cache shape, schema `1`. [src/app/shared/models/workspace-state.model.ts:1] |
| None found | `PersistedWorkspaceTab`: `type`, `ref` | Persistence reference: relative path, diff JSON, or task/note id. [src/app/shared/models/workspace-state.model.ts:4] |

Differences: persisted tabs omit live `title`, `data`, and diff object fields and serialize a type-specific `ref`; restore reconstructs live objects through `TabStore` methods. [src/app/shared/models/workspace-state.model.ts:52] [src/app/core/services/workspace-state.service.ts:183]

## 3. Rust

### Services
No Rust service is present for tabs or editor state in the tabs row.

### Commands
No Rust/Tauri command is present for tabs or editor state.

### Events
No Rust event is emitted for tab/editor state. Persistence changes are local Angular state; external Rust filesystem changes affect nodes and editor cleanup separately. [src/app/core/store/tab.store.ts:40] [src/app/core/services/file-system/workspace-watcher.service.ts:181]

## 4. Angular

### API wrapper
There is no API wrapper for tab data. No Tauri call is made by `TabStore` or `EditorCommands` for opening, closing, activating, or persisting tabs.

### TabStore signals
`activeTab`, `activeTabId`, `activeTabType`, `openTabs`/`openTabIds`, `dirtyIds`, and `dirtyCount` are computed signals. `openedTabs`, `focusHistory`, `diffTabs`, and `dirty` are state signals. [src/app/core/store/tab.store.ts:46]

### Store/facade methods
- `openTab(Tab)`, `openFile(id,title?)`, `openDiff(request,title?)`, `openTask(...)`, `openNote(...)`, `openReview(...)`, `openChat(...)`: merge or add and focus a tab; no error handling. [src/app/core/store/tab.store.ts:75] [src/app/core/store/tab.store.ts:124]
- `activate(id)`, `activateTab(Tab)`, `closeTab(id)`, `closeMany(ids)`, `closeAll()`, `closeOthers(id)`, `closeTabsToRight(id)`, `reorder(from,to)`, `cycleTab(direction)`, `nextTab()`, `previousTab()`: mutate tab/focus order and return active id where stated. [src/app/core/store/tab.store.ts:193] [src/app/core/store/tab.store.ts:221] [src/app/core/store/tab.store.ts:261] [src/app/core/store/tab.store.ts:287]
- `setDirty(id,dirty)`, `updateTab(id,updates)`, `getTab(id)`, `isOpen(id)`, `isDirty(id)`, `isDiffTab(id)`, `getTabsByType(type)`: state lookup/update helpers. [src/app/core/store/tab.store.ts:63] [src/app/core/store/tab.store.ts:203]
- `EditorCommands.openFile/openPath/openPathAtLine`, `saveFile/saveAll`, `closeTab/closeTabs`: coordinate NodeStore, TabStore, EditorService, dialogs, and workspace state; save and close return booleans or void; write failures are handled locally. [src/app/feature/editor/editor.commands.ts:154] [src/app/feature/editor/editor.commands.ts:218] [src/app/feature/editor/editor.commands.ts:252]
- `EditorService` mounts Monaco, acquires/releases/replaces models, tracks dirty state and exposes content/reveal/format operations. It has no tab persistence or Rust API; load failure is rethrown and the next call retries. [src/app/feature/editor/services/editor.service.ts:99] [src/app/feature/editor/services/editor.service.ts:132] [src/app/feature/editor/services/editor.service.ts:199]
- `ModelSourceService.acquire/acquireFile/release` resolves live working or git-side models and refreshes HEAD/index snapshots. Resolution methods return `null` for missing nodes/models; git read failures are not normalized here. [src/app/feature/editor/services/model-source.service.ts:26] [src/app/feature/editor/services/model-source.service.ts:43]
- `GitDiffService.open(openChange)` resolves side paths and calls `TabStore.openDiff`; returns a string error or `null`. [src/app/feature/git/services/git-diff.service.ts:24] [src/app/feature/git/services/git-diff.service.ts:46]
- `WorkspaceStateService.prepareProjectSwitch/restoreProject/flush` and the close handler serialize, restore, and flush Angular tab state as `.praide/cache/workspace.json`; read/restore errors are reported or logged. [src/app/core/services/workspace-state.service.ts:46] [src/app/core/services/workspace-state.service.ts:112]

## 5. Main flows

1. **Open file:** UI/explorer or search -> `EditorCommands.openFile/openPath` -> load NodeStore content -> `TabStore.openFile` -> Monaco component reacts to `activeTabId` -> `ModelSourceService.acquireFile` -> `EditorService.acquireModel`; no Rust tab event. [src/app/feature/editor/editor.commands.ts:154] [src/app/feature/editor/features/code-editor.component.ts:82]
2. **Open diff:** Git UI -> `GitDiffService.open` -> resolve absolute sides -> `TabStore.openDiff` -> diff component sees `activeDiffTab` -> `ModelSourceService.acquire` -> `EditorService`/git reads; no Rust tab event. [src/app/feature/git/services/git-diff.service.ts:24] [src/app/feature/editor/features/diff-editor.component.ts:177]
3. **Save:** Monaco Ctrl+S or command -> `EditorCommands.saveFile` -> format/model content -> NodeStore `writeFile` -> `EditorService.markSaved` -> dirty callbacks update `TabStore`; save failure returns `false`. [src/app/feature/editor/editor.commands.ts:218] [src/app/feature/editor/services/editor.service.ts:277]
4. **Close:** tab UI/command -> `EditorCommands.closeTabs` -> prompt for dirty owned files -> save/discard or cancel -> `TabStore.closeMany` -> NodeStore/selection update; no Rust event. [src/app/feature/editor/editor.commands.ts:252] [src/app/layout/panels/main/main.ts:302]
5. **Persist/restore:** tab state changes -> `WorkspaceStateService` effect serializes workspace cache after 500 ms; close/prepare flushes it -> project restore resolves tabs and calls `setRestoredTabs`; no Rust event. [src/app/core/services/workspace-state.service.ts:46] [src/app/core/services/workspace-state.service.ts:112]

## 6. Gaps

- The tab/domain row has no Rust implementation; this may mean tabs are intentionally frontend-only or the split is unverified.
- `Review` and `Chat` tab types are skipped by workspace restore; restore reports them as skipped types. [src/app/shared/models/workspace-state.model.ts:84] [src/app/core/services/workspace-state.service.ts:205]
- There is no tab `*:changed` event and no Tauri persistence API; persistence is plugin-FS-only.
- `DiffEditor` is not mounted until at least one diff tab exists, while code/diff panes are selected by store type. [src/app/feature/editor/editor.html:10]
- Undo/redo, per-tab restoration content, and tab lifecycle persistence outside `.praide/cache/workspace.json` are unverified.

## 7. Logic in the wrong layer

| File:line | What it does | Where it belongs |
|---|---|---|
| `src/app/feature/editor/features/diff-editor.component.ts:216` | Manages diff-model acquisition, stale-load races, missing-model errors, and held-side release in the component. | `ModelSourceService` should own source resolution/race-safe acquisition and held-model lifecycle; the component should mount/render only. |
| `src/app/core/services/command/app-commands.ts:79` | Reimplements tab wrapping/cycling instead of using the existing `TabStore.cycleTab`/`nextTab` methods. | `TabStore`; command registration should call store methods only. |

