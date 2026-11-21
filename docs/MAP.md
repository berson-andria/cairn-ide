# Cairn module map

Last updated: 2026-11-21

<!-- TREE:START -->
```text
.
├── docs/
│   ├── archive/
│   │   ├── proposal-api.md
│   │   ├── run-api.md
│   │   ├── task-note-api.md
│   │   └── watch-policy.md
│   ├── domains/
│   │   ├── codemap.md
│   │   ├── editor.md
│   │   ├── explorer.md
│   │   ├── git.md
│   │   ├── lsp.md
│   │   ├── model.md
│   │   ├── nodes.md
│   │   ├── project-apis.md
│   │   ├── search.md
│   │   ├── settings.md
│   │   ├── tabs.md
│   │   ├── terminal.md
│   │   └── workspace.md
│   ├── CONTEXT.md
│   ├── MAP.md
│   ├── architecture.md
│   ├── current-state.md
│   ├── frontend-services.md
│   ├── slice-2-port-notes.md
│   ├── ui-contract.md
│   └── watch-policy-current.md
├── scripts/
│   ├── docs-check.mjs
│   └── docs-tree.mjs
├── sdk/
│   └── python/
│       ├── cairn/
│       │   ├── __pycache__/
│       │   │   └── __init__.cpython-312.pyc
│       │   └── __init__.py
│       └── examples/
│           ├── hello.py
│           ├── propose.py
│           ├── propose_split.py
│           └── steps.py
├── src/
│   ├── app/
│   │   ├── core/
│   │   │   ├── services/
│   │   │   │   ├── codemap/
│   │   │   │   │   ├── codemap.service.ts
│   │   │   │   │   └── missing-language-dialog.ts
│   │   │   │   ├── command/
│   │   │   │   │   ├── app-commands.ts
│   │   │   │   │   ├── command.service.ts
│   │   │   │   │   ├── keybinding.model.ts
│   │   │   │   │   └── keybinding.service.ts
│   │   │   │   ├── dialog/
│   │   │   │   │   ├── dialog.service.ts
│   │   │   │   │   └── dialog.ts
│   │   │   │   ├── file-system/
│   │   │   │   │   ├── external-watcher.utils.ts
│   │   │   │   │   ├── file-system.service.ts
│   │   │   │   │   ├── fs-events.ts
│   │   │   │   │   └── workspace-watcher.service.ts
│   │   │   │   ├── lsp/
│   │   │   │   │   ├── lsp-bridge.service.ts
│   │   │   │   │   ├── lsp-client.ts
│   │   │   │   │   ├── lsp-convert.ts
│   │   │   │   │   ├── lsp-manager.service.ts
│   │   │   │   │   ├── lsp-monitor.service.ts
│   │   │   │   │   └── lsp-servers.ts
│   │   │   │   ├── notification/
│   │   │   │   │   ├── notification-list.ts
│   │   │   │   │   └── notification.service.ts
│   │   │   │   ├── proposals/
│   │   │   │   │   ├── proposal-notifier.service.ts
│   │   │   │   │   └── proposal.service.ts
│   │   │   │   ├── runs/
│   │   │   │   │   ├── run.service.ts
│   │   │   │   │   └── workflow.service.ts
│   │   │   │   ├── tauri/
│   │   │   │   │   ├── api-error.ts
│   │   │   │   │   ├── tauri-boot.service.ts
│   │   │   │   │   ├── tauri-bridge.service.ts
│   │   │   │   │   ├── work-api.service.ts
│   │   │   │   │   ├── work-events.ts
│   │   │   │   │   └── work-sync.service.ts
│   │   │   │   ├── close-handler.service.ts
│   │   │   │   ├── diagnostics.service.ts
│   │   │   │   ├── layout.service.ts
│   │   │   │   ├── message.service.ts
│   │   │   │   ├── monitoring.service.ts
│   │   │   │   ├── persistance.service.ts
│   │   │   │   ├── project-history.service.ts
│   │   │   │   ├── project-startup.service.ts
│   │   │   │   ├── replace.service.ts
│   │   │   │   ├── settings-runtime.service.ts
│   │   │   │   └── workspace-state.service.ts
│   │   │   └── store/
│   │   │       ├── node.state.ts
│   │   │       ├── node.store.ts
│   │   │       ├── note.store.ts
│   │   │       ├── proposal.store.ts
│   │   │       ├── run.store.ts
│   │   │       ├── setting.store.ts
│   │   │       ├── tab.store.ts
│   │   │       └── task.store.ts
│   │   ├── feature/
│   │   │   ├── chat/
│   │   │   │   ├── component/
│   │   │   │   │   ├── history/
│   │   │   │   │   │   ├── chat-history.html
│   │   │   │   │   │   ├── chat-history.scss
│   │   │   │   │   │   └── chat-history.ts
│   │   │   │   │   ├── history-item/
│   │   │   │   │   │   ├── chat-history-item.html
│   │   │   │   │   │   ├── chat-history-item.scss
│   │   │   │   │   │   └── chat-history-item.ts
│   │   │   │   │   ├── message/
│   │   │   │   │   │   ├── message.html
│   │   │   │   │   │   ├── message.scss
│   │   │   │   │   │   └── message.ts
│   │   │   │   │   └── message-input/
│   │   │   │   │       ├── message-input.html
│   │   │   │   │       ├── message-input.scss
│   │   │   │   │       └── message-input.ts
│   │   │   │   ├── chat.html
│   │   │   │   ├── chat.model.ts
│   │   │   │   ├── chat.scss
│   │   │   │   ├── chat.service.ts
│   │   │   │   └── chat.ts
│   │   │   ├── editor/
│   │   │   │   ├── features/
│   │   │   │   │   ├── DiffRequest.ts
│   │   │   │   │   ├── code-editor.component.ts
│   │   │   │   │   ├── diff-editor.component.ts
│   │   │   │   │   └── diff-tab.ts
│   │   │   │   ├── services/
│   │   │   │   │   ├── editor.service.ts
│   │   │   │   │   └── model-source.service.ts
│   │   │   │   ├── setup/
│   │   │   │   │   ├── workers/
│   │   │   │   │   │   ├── css.worker.ts
│   │   │   │   │   │   ├── editor.worker.ts
│   │   │   │   │   │   ├── html.worker.ts
│   │   │   │   │   │   ├── json.worker.ts
│   │   │   │   │   │   └── ts.worker.ts
│   │   │   │   │   ├── monaco-enhance.ts
│   │   │   │   │   ├── monaco-environment.ts
│   │   │   │   │   ├── monaco-languages.ts
│   │   │   │   │   └── monaco-theme.ts
│   │   │   │   ├── editor-extensions.ts
│   │   │   │   ├── editor-handles.ts
│   │   │   │   ├── editor.commands.ts
│   │   │   │   ├── editor.html
│   │   │   │   ├── editor.scss
│   │   │   │   └── editor.ts
│   │   │   ├── explorer/
│   │   │   │   ├── node/
│   │   │   │   │   ├── file-node/
│   │   │   │   │   │   ├── file-node.html
│   │   │   │   │   │   └── file-node.ts
│   │   │   │   │   ├── folder-node/
│   │   │   │   │   │   ├── folder-node.html
│   │   │   │   │   │   ├── folder-node.scss
│   │   │   │   │   │   └── folder-node.ts
│   │   │   │   │   ├── new-node/
│   │   │   │   │   │   └── new-node.ts
│   │   │   │   │   ├── rename-node/
│   │   │   │   │   │   └── rename-node.ts
│   │   │   │   │   ├── node-dnd.directive.ts
│   │   │   │   │   └── node.scss
│   │   │   │   ├── empty-explorer.ts
│   │   │   │   ├── tree.html
│   │   │   │   ├── tree.scss
│   │   │   │   └── tree.ts
│   │   │   ├── git/
│   │   │   │   ├── client/
│   │   │   │   │   ├── branch.pipeline.ts
│   │   │   │   │   ├── changes.pipeline.ts
│   │   │   │   │   ├── commit.pipeline.ts
│   │   │   │   │   ├── context.ts
│   │   │   │   │   ├── recovery.ts
│   │   │   │   │   ├── remote.pipeline.ts
│   │   │   │   │   ├── shared.ts
│   │   │   │   │   └── stash.pipeline.ts
│   │   │   │   ├── features/
│   │   │   │   │   ├── blame/
│   │   │   │   │   │   ├── blame.controller.ts
│   │   │   │   │   │   ├── git-blame.provider.ts
│   │   │   │   │   │   └── git-blame.utils.ts
│   │   │   │   │   ├── branch/
│   │   │   │   │   │   ├── branch.html
│   │   │   │   │   │   ├── branch.scss
│   │   │   │   │   │   └── branch.ts
│   │   │   │   │   ├── changes/
│   │   │   │   │   │   ├── git-changes.html
│   │   │   │   │   │   ├── git-changes.scss
│   │   │   │   │   │   └── git-changes.ts
│   │   │   │   │   ├── dialogs/
│   │   │   │   │   │   ├── choice-dialog.ts
│   │   │   │   │   │   ├── dialog-data.ts
│   │   │   │   │   │   ├── dialog-shared.ts
│   │   │   │   │   │   ├── form-dialog.ts
│   │   │   │   │   │   ├── identity-dialog.ts
│   │   │   │   │   │   └── picker-dialog.ts
│   │   │   │   │   ├── graph/
│   │   │   │   │   │   ├── graph.html
│   │   │   │   │   │   ├── graph.layout.ts
│   │   │   │   │   │   ├── graph.scss
│   │   │   │   │   │   └── graph.ts
│   │   │   │   │   ├── no-git/
│   │   │   │   │   │   ├── no-git-folder.ts
│   │   │   │   │   │   └── no-repository.ts
│   │   │   │   │   └── stash/
│   │   │   │   │       └── stash.ts
│   │   │   │   ├── parser/
│   │   │   │   │   ├── blame.parser.ts
│   │   │   │   │   ├── branch.parser.ts
│   │   │   │   │   ├── git-types.ts
│   │   │   │   │   ├── log.parser.ts
│   │   │   │   │   └── status.parser.ts
│   │   │   │   ├── services/
│   │   │   │   │   ├── git-askpass.service.ts
│   │   │   │   │   ├── git-blame.service.ts
│   │   │   │   │   ├── git-client.service.ts
│   │   │   │   │   ├── git-dialog.service.ts
│   │   │   │   │   ├── git-diff.service.ts
│   │   │   │   │   └── git.service.ts
│   │   │   │   ├── ui/
│   │   │   │   │   ├── git-dialogs.ts
│   │   │   │   │   └── git-ui.ts
│   │   │   │   ├── GIT_SERVICE.md
│   │   │   │   └── git.node.md
│   │   │   ├── notes/
│   │   │   │   ├── note/
│   │   │   │   │   └── note.ts
│   │   │   │   ├── note-list/
│   │   │   │   │   ├── note-list.html
│   │   │   │   │   ├── note-list.scss
│   │   │   │   │   └── note-list.ts
│   │   │   │   ├── note-view/
│   │   │   │   │   ├── note-view.html
│   │   │   │   │   ├── note-view.scss
│   │   │   │   │   └── note-view.ts
│   │   │   │   └── note.service.ts
│   │   │   ├── output/
│   │   │   │   ├── output.service.ts
│   │   │   │   └── output.ts
│   │   │   ├── problems/
│   │   │   │   └── problems.ts
│   │   │   ├── review/
│   │   │   │   └── review-list.ts
│   │   │   ├── run/
│   │   │   │   ├── run.html
│   │   │   │   ├── run.scss
│   │   │   │   └── run.ts
│   │   │   ├── search/
│   │   │   │   ├── result/
│   │   │   │   │   ├── result.html
│   │   │   │   │   ├── result.scss
│   │   │   │   │   └── result.ts
│   │   │   │   ├── search.html
│   │   │   │   ├── search.model.ts
│   │   │   │   ├── search.scss
│   │   │   │   ├── search.service.ts
│   │   │   │   └── search.ts
│   │   │   ├── setting/
│   │   │   │   ├── model-setting/
│   │   │   │   │   ├── model-entry.model.ts
│   │   │   │   │   ├── models-settings.html
│   │   │   │   │   ├── models-settings.scss
│   │   │   │   │   └── models-settings.ts
│   │   │   │   ├── settings.html
│   │   │   │   ├── settings.registry.ts
│   │   │   │   ├── settings.scss
│   │   │   │   ├── settings.service.ts
│   │   │   │   └── settings.ts
│   │   │   ├── tasks/
│   │   │   │   ├── new/
│   │   │   │   │   ├── new-task.html
│   │   │   │   │   ├── new-task.scss
│   │   │   │   │   └── new-task.ts
│   │   │   │   ├── task/
│   │   │   │   │   ├── task.html
│   │   │   │   │   ├── task.scss
│   │   │   │   │   └── task.ts
│   │   │   │   ├── task-list/
│   │   │   │   │   └── task-list.ts
│   │   │   │   ├── task-view/
│   │   │   │   │   ├── task-view.html
│   │   │   │   │   ├── task-view.scss
│   │   │   │   │   └── task-view.ts
│   │   │   │   ├── empty-task-list.ts
│   │   │   │   └── task.service.ts
│   │   │   └── terminal/
│   │   │       ├── terminal.service.ts
│   │   │       └── terminal.ts
│   │   ├── layout/
│   │   │   ├── app-shell/
│   │   │   │   ├── app-shell.html
│   │   │   │   ├── app-shell.scss
│   │   │   │   └── app-shell.ts
│   │   │   └── panels/
│   │   │       ├── bottom-panel/
│   │   │       │   ├── bottom-panel.html
│   │   │       │   ├── bottom-panel.scss
│   │   │       │   └── bottom-panel.ts
│   │   │       ├── left-panel/
│   │   │       │   ├── left-panel.html
│   │   │       │   ├── left-panel.scss
│   │   │       │   └── left-panel.ts
│   │   │       └── main/
│   │   │           ├── empty-workspace.ts
│   │   │           ├── main-panel.html
│   │   │           ├── main-panel.scss
│   │   │           ├── main.ts
│   │   │           └── no-folder.ts
│   │   ├── shared/
│   │   │   ├── components/
│   │   │   │   ├── anchor-picker/
│   │   │   │   │   ├── picker.html
│   │   │   │   │   ├── picker.model.ts
│   │   │   │   │   ├── picker.scss
│   │   │   │   │   ├── picker.service.ts
│   │   │   │   │   └── picker.ts
│   │   │   │   ├── attach-file/
│   │   │   │   │   ├── attach-file.html
│   │   │   │   │   ├── attach-file.scss
│   │   │   │   │   └── attach-file.ts
│   │   │   │   ├── markdown-editor/
│   │   │   │   │   ├── markdown-editor.html
│   │   │   │   │   ├── markdown-editor.scss
│   │   │   │   │   └── markdown-editor.ts
│   │   │   │   ├── resize-handle/
│   │   │   │   │   ├── resize-handle.scss
│   │   │   │   │   └── resize-handle.ts
│   │   │   │   ├── file-icon.ts
│   │   │   │   └── link-file.ts
│   │   │   ├── directives/
│   │   │   │   ├── auto-expand.ts
│   │   │   │   ├── badge.directive.ts
│   │   │   │   ├── menu.directive.ts
│   │   │   │   └── tooltip-title.ts
│   │   │   ├── models/
│   │   │   │   ├── agent.model.ts
│   │   │   │   ├── pagination.model.ts
│   │   │   │   ├── persistence.model.ts
│   │   │   │   ├── project-startup.model.ts
│   │   │   │   └── workspace-state.model.ts
│   │   │   ├── pipe/
│   │   │   │   ├── highlight.pipe.ts
│   │   │   │   ├── replace-preview.pipe.ts
│   │   │   │   ├── search-snippet.pipe.ts
│   │   │   │   └── text-window.pipe.ts
│   │   │   └── utils/
│   │   │       ├── editor.utils.ts
│   │   │       ├── excluded-folders.ts
│   │   │       ├── icon-sprite.ts
│   │   │       ├── icon-theme.ts
│   │   │       ├── node.utils.ts
│   │   │       ├── replace.utils.ts
│   │   │       └── utils.ts
│   │   └── app.config.ts
│   ├── index.html
│   ├── main.ts
│   ├── styles.scss
│   └── token.scss
├── src-tauri/
│   ├── capabilities/
│   │   └── default.json
│   ├── src/
│   │   ├── commands/
│   │   │   ├── askpass.rs
│   │   │   ├── codemap.rs
│   │   │   ├── diagnostics.rs
│   │   │   ├── fs.rs
│   │   │   ├── git.rs
│   │   │   ├── lsp.rs
│   │   │   ├── mod.rs
│   │   │   ├── models.rs
│   │   │   ├── notes.rs
│   │   │   ├── project.rs
│   │   │   ├── proposals.rs
│   │   │   ├── pty.rs
│   │   │   ├── runs.rs
│   │   │   ├── search.rs
│   │   │   ├── secrets.rs
│   │   │   ├── tasks.rs
│   │   │   └── watcher.rs
│   │   ├── services/
│   │   │   ├── codemap/
│   │   │   │   ├── extract.rs
│   │   │   │   ├── graph.rs
│   │   │   │   ├── languages.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── service.rs
│   │   │   │   ├── store.rs
│   │   │   │   └── tree.rs
│   │   │   ├── runs/
│   │   │   │   ├── mod.rs
│   │   │   │   ├── rpc.rs
│   │   │   │   └── workflows.rs
│   │   │   ├── storage/
│   │   │   │   └── mod.rs
│   │   │   ├── fs.rs
│   │   │   ├── mod.rs
│   │   │   ├── note_service.rs
│   │   │   ├── project.rs
│   │   │   ├── proposal_service.rs
│   │   │   ├── service_error.rs
│   │   │   ├── session_history.rs
│   │   │   ├── task_service.rs
│   │   │   └── watcher.rs
│   │   ├── types/
│   │   │   ├── codemap.rs
│   │   │   ├── mod.rs
│   │   │   ├── note.rs
│   │   │   ├── proposal.rs
│   │   │   ├── search.rs
│   │   │   ├── task.rs
│   │   │   └── workspace_node.rs
│   │   ├── lib.rs
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tests/
│   ├── frontend-services.test.ts
│   ├── project-startup.test.ts
│   └── workspace-state.test.ts
├── .gitignore
├── .prettierrc
├── AGENTS.md
├── angular.json
├── package.json
├── tsconfig.app.json
├── tsconfig.json
└── tsconfig.worker.json
```
<!-- TREE:END -->

## Module index

Paths are relative to the repository root. Shared `work-api.service.ts` and
`file-system.service.ts` entries appear in each domain they serve.

| Domain | Rust types | Rust service | Rust commands | Angular api | Angular store | Angular service | Doc |
|---|---|---|---|---|---|---|---|
| Project | - | `src-tauri/src/services/project.rs`<br>`src-tauri/src/services/session_history.rs` | `src-tauri/src/commands/project.rs` | `src/app/core/services/tauri/work-api.service.ts` | - | `src/app/core/services/project-history.service.ts`<br>`src/app/core/services/project-startup.service.ts`<br>`src/app/core/services/workspace-state.service.ts` | `docs/domains/workspace.md` |
| Tasks | `src-tauri/src/types/task.rs` | `src-tauri/src/services/task_service.rs` | `src-tauri/src/commands/tasks.rs` | `src/app/core/services/tauri/work-api.service.ts` | `src/app/core/store/task.store.ts` | `src/app/feature/tasks/task.service.ts` | `docs/domains/project-apis.md#tasks-notes` |
| Notes | `src-tauri/src/types/note.rs` | `src-tauri/src/services/note_service.rs` | `src-tauri/src/commands/notes.rs` | `src/app/core/services/tauri/work-api.service.ts` | `src/app/core/store/note.store.ts` | `src/app/feature/notes/note.service.ts`<br>`src/app/shared/components/anchor-picker/picker.service.ts` | `docs/domains/project-apis.md#tasks-notes` |
| Proposals | `src-tauri/src/types/proposal.rs` | `src-tauri/src/services/proposal_service.rs` | `src-tauri/src/commands/proposals.rs` | `src/app/core/services/tauri/work-api.service.ts` | `src/app/core/store/proposal.store.ts` | `src/app/core/services/proposals/proposal-notifier.service.ts`<br>`src/app/core/services/proposals/proposal.service.ts` | `docs/domains/project-apis.md#proposals` |
| Runs and workflows | - | `src-tauri/src/services/runs/mod.rs`<br>`src-tauri/src/services/runs/rpc.rs`<br>`src-tauri/src/services/runs/workflows.rs` | `src-tauri/src/commands/runs.rs` | `src/app/core/services/tauri/work-api.service.ts` | `src/app/core/store/run.store.ts` | `src/app/core/services/runs/run.service.ts`<br>`src/app/core/services/runs/workflow.service.ts` | `docs/domains/project-apis.md#runs` |
| Watcher and fs | - | `src-tauri/src/services/watcher.rs` | `src-tauri/src/commands/watcher.rs` | `src/app/core/services/file-system/file-system.service.ts` | - | `src/app/core/services/file-system/workspace-watcher.service.ts` | `docs/domains/project-apis.md#watcher-fs` |
| Codemap | `src-tauri/src/types/codemap.rs` | `src-tauri/src/services/codemap/extract.rs`<br>`src-tauri/src/services/codemap/graph.rs`<br>`src-tauri/src/services/codemap/languages.rs`<br>`src-tauri/src/services/codemap/mod.rs`<br>`src-tauri/src/services/codemap/service.rs`<br>`src-tauri/src/services/codemap/store.rs`<br>`src-tauri/src/services/codemap/tree.rs` | `src-tauri/src/commands/codemap.rs` | `src/app/core/services/codemap/codemap.service.ts` | - | - | `docs/domains/codemap.md` |
| Settings and models | - | - | `src-tauri/src/commands/models.rs`<br>`src-tauri/src/commands/diagnostics.rs` | - | `src/app/core/store/setting.store.ts` (empty, unused) | `src/app/feature/setting/settings.service.ts`<br>`src/app/core/services/settings-runtime.service.ts` | `docs/domains/settings.md` |
| Secrets | - | - | `src-tauri/src/commands/secrets.rs` | - | - | `src/app/feature/setting/model-setting/models-settings.ts` | `docs/domains/settings.md` |
| Git | - | - | `src-tauri/src/commands/askpass.rs`<br>`src-tauri/src/commands/git.rs` | `src/app/feature/git/services/git-client.service.ts` | - | `src/app/feature/git/services/git-askpass.service.ts`<br>`src/app/feature/git/services/git-blame.service.ts`<br>`src/app/feature/git/services/git-dialog.service.ts`<br>`src/app/feature/git/services/git-diff.service.ts`<br>`src/app/feature/git/services/git.service.ts` | `docs/domains/git.md` |
| LSP | - | - | `src-tauri/src/commands/lsp.rs` | `src/app/core/services/lsp/lsp-bridge.service.ts` | `src/app/core/services/lsp/lsp-monitor.service.ts` | `src/app/core/services/lsp/lsp-manager.service.ts`<br>`src/app/core/services/lsp/lsp-client.ts` | `docs/domains/lsp.md` |
| Terminal | - | - | `src-tauri/src/commands/pty.rs` | `src/app/feature/terminal/terminal.service.ts` | - | - | `docs/domains/terminal.md` |
| Search | `src-tauri/src/types/search.rs` | - | `src-tauri/src/commands/search.rs` | `src/app/feature/search/search.service.ts` | - | - | `docs/domains/search.md` |
| Explorer and nodes | `src-tauri/src/types/workspace_node.rs` | `src-tauri/src/services/fs.rs` | `src-tauri/src/commands/fs.rs` | `src/app/core/services/file-system/file-system.service.ts` | `src/app/core/store/node.store.ts` | - | `docs/domains/explorer.md`<br>`docs/domains/nodes.md` |
| Tabs and editor | - | - | - | - | `src/app/core/store/tab.store.ts` | `src/app/feature/editor/editor.commands.ts`<br>`src/app/feature/editor/services/editor.service.ts`<br>`src/app/feature/editor/services/model-source.service.ts` | `docs/domains/tabs.md`<br>`docs/domains/editor.md` |
| Diagnostics | - | - | `src-tauri/src/commands/diagnostics.rs` | `src/app/core/services/diagnostics.service.ts` | - | - | `docs/domains/model.md` |
| Anything else | - | - | - | `src/app/core/services/tauri/tauri-bridge.service.ts` | - | `src/app/core/services/close-handler.service.ts`<br>`src/app/core/services/command/command.service.ts`<br>`src/app/core/services/command/keybinding.service.ts`<br>`src/app/core/services/dialog/dialog.service.ts`<br>`src/app/core/services/layout.service.ts`<br>`src/app/core/services/message.service.ts`<br>`src/app/core/services/monitoring.service.ts`<br>`src/app/core/services/notification/notification.service.ts`<br>`src/app/core/services/persistance.service.ts`<br>`src/app/core/services/replace.service.ts`<br>`src/app/core/services/tauri/tauri-boot.service.ts`<br>`src/app/core/services/tauri/work-sync.service.ts`<br>`src/app/feature/chat/chat.service.ts`<br>`src/app/feature/output/output.service.ts` | - |
| Uncategorized | `src-tauri/src/types/mod.rs` | `src-tauri/src/services/mod.rs`<br>`src-tauri/src/services/service_error.rs`<br>`src-tauri/src/services/storage/mod.rs` | `src-tauri/src/commands/mod.rs` | - | - | - | - |

## Logic in the wrong layer

| File:line | What it does | Where it belongs |
|---|---|---|
| `src/app/feature/tasks/task.service.ts:109` | Computes task availability from status and dependency data, duplicating Rust's `task_can_start` command. | Rust task service; Angular should consume the Rust result. |
| `src/app/feature/tasks/task.service.ts:129` | Computes `canStart` from status and dependency data instead of consuming Rust's task eligibility result. | Rust task service; Angular should consume the Rust result. |
| `src-tauri/src/commands/project.rs:63` | `project_open` cancels runs and records app-data history in the command boundary. | Project/run/history services, with the command reduced to argument/result plumbing. |
| `src-tauri/src/commands/project.rs:95` | `project_close` cancels runs and clears the last-project marker in app data. | Project/run/history services, with the command reduced to argument/result plumbing. |
| `src/app/feature/editor/features/diff-editor.component.ts:216` | Manages diff-model acquisition, stale-load races, missing-model errors, and held-side release in the component. | `ModelSourceService` should own source resolution/race-safe acquisition and held-model lifecycle; the component should only mount and render. |
| `src/app/core/services/command/app-commands.ts:79` | Reimplements tab wrapping/cycling instead of using the existing `TabStore.cycleTab`/`nextTab` methods. | `TabStore`; command registration should call store methods only. |
| `src-tauri/src/commands/codemap.rs:94-106` | `codemap_install_languages` sequences parser installation and code-map re-indexing. | A `CodeMapService` operation, leaving the command as argument/result plumbing. |
| `src-tauri/src/commands/fs.rs:103-169` | `workspace_search` performs walking, exclusion, cancellation, file scanning, and channel output in the command boundary. | Rust filesystem/search service; command should only validate args and delegate. |
| `src-tauri/src/commands/fs.rs:21-89` | Directory existence/type validation and file I/O live in Tauri command functions. | Rust filesystem service; commands should validate/delegate only. |
| `src-tauri/src/commands/watcher.rs:8-24` | Absolute-path validation and watcher lifecycle mutation live in commands. | Rust watcher service; commands should dispatch and return. |
| `src/app/feature/explorer/node/node-dnd.directive.ts:126-143` | Drag/drop target validation is duplicated in static directive helpers. | `NodeStore` move/copy policy; the directive should collect UI events only. |
| `src-tauri/src/commands/git.rs:67-208` | Git allowlist validation, timeout handling, pipe draining, and child-process polling live in command modules. | A Rust Git process/service module, leaving the command as argument/result plumbing. |
| `src-tauri/src/commands/askpass.rs:38-127` | Askpass listener, pending-request registry, timeout, and event emission live in the command module. | A Rust Git/askpass service, leaving the command as argument/result plumbing. |
| `src-tauri/src/commands/pty.rs:53-146` | `pty_spawn` mixes argument plumbing with PTY creation, shell setup, session registration, output pumping, and exit waiting. | A Rust terminal/PTY service should own the lifecycle; commands should dispatch and return. |
| `src-tauri/src/commands/pty.rs:151-178` | `pty_write` and `pty_resize` directly find and mutate live PTY state. | State lookup and PTY I/O belong in a Rust terminal/PTY service. |
| `src-tauri/src/commands/pty.rs:182-192` | `pty_kill` directly removes a session and invokes the child killer. | Kill/session cleanup belongs in a Rust terminal/PTY service. |
| `src/app/feature/git/features/changes/git-changes.ts:160-168` | The changes component sequences commit-and-push/sync workflows. | `GitClient` pipelines should own workflow sequencing. |
| `src/app/feature/git/client/branch.pipeline.ts:43-77` | Stash-switch-restore/migrate recovery sequencing lives in a client pipeline. | `GitService` or a dedicated Git operation service should own the operation sequence. |
| `src/app/feature/git/client/commit.pipeline.ts:18-74` | Commit preflight, staged/unstaged decisions, and recovery sequencing live in UI pipeline logic. | `GitService` or `GitClient` orchestration should own action sequencing. |
| `src-tauri/src/commands/codemap.rs:155-163` | `codemap_search` applies the default limit of 50 at the IPC boundary. | `CodeMapService::search` or its input type, so the default is service policy. |
| `src/app/feature/setting/model-setting/models-settings.ts:124` | Save validation, key migration/deletion, entry construction, and registry writes belong in a model/service facade. | A model settings service/facade; the component should render and dispatch. |
| `src/app/feature/setting/model-setting/models-settings.ts:222` | API key retrieval and HTTP endpoint/testing logic belong in a model service, not the settings component. | A model test/service layer; the component should hold UI state only. |
| `src/app/feature/setting/model-setting/models-settings.ts:290` | JSON parsing and default normalization belong outside the settings component. | A typed model settings parser or model service. |
| `src-tauri/src/commands/models.rs:18` | GGUF validation, process spawning, polling, timeout, and kill logic execute in the command module. | A Rust model service; the command should perform argument/result plumbing. |
| `src-tauri/src/commands/secrets.rs:13` | Keyring entry validation and secret lifecycle logic execute in the command module. | A Rust secrets service; the command should perform argument/result plumbing. |
| `src-tauri/src/commands/diagnostics.rs:4` | String-to-`LevelFilter` mapping executes in the command module. | A Rust diagnostics/logging service. |
| `src-tauri/src/commands/lsp.rs:43-102` | `lsp_start` owns process spawning, Windows flags, pipe extraction, state insertion, async read/exit tasks, and kill waiting. | A Rust LSP process/service module; the command should only validate arguments and delegate. |
| `src-tauri/src/commands/lsp.rs:105-143` | `lsp_send` and `lsp_stop` contain transport lookup, Content-Length framing, pipe writes, and kill-signal lifecycle policy. | A Rust LSP service/module with command functions reduced to argument/result plumbing. |
| `src-tauri/src/commands/search.rs:24-81` | Glob splitting and include/exclude override construction live in command-module helpers. | A Rust search service should own glob parsing and override policy. |
| `src-tauri/src/commands/search.rs:83-176` | `global_search` owns supersession, blocking dispatch, workspace validation, regex compilation, file walking, binary filtering, parallel scanning, and result grouping. | A Rust search service should own the search operation; the command should be argument/result plumbing. |
| `src-tauri/src/commands/search.rs:179-244` | `search_files` owns blocking dispatch, workspace validation, excluded-folder filtering, traversal, normalization, and filename matching. | A Rust search service should own traversal and matching; the command should be argument/result plumbing. |
| `src/app/feature/search/search.ts:338-399` | Replace-all confirmation, bulk-target construction, progress state, and result/skipped-match reconciliation are sequenced in the component. | The replace/search facade or a dedicated replace workflow service should own orchestration; the component should render state and dispatch. |
| `src-tauri/src/commands/lsp.rs:145-185` | `read_loop` and `stderr_loop` implement stdout framing and stderr draining in the command module. | A Rust LSP transport service/module used through a service handle. |
