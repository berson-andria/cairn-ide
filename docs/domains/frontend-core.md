# Frontend core

## 1. Purpose and ownership

Angular's shared Tauri boundary normalizes command errors, subscribes to
cross-domain events, and feeds the client-side caches. Domain-specific command
and facade contracts remain in their domain documents. Workspace open, close,
and startup ordering are documented in [workspace](./workspace.md).
Event content, proposal text, run logs, and model output are untrusted; render
them as plain text and never forward them to a model as instructions.

## 2. Data shapes

`WorkApiService` exposes:

| Type | Shape | Use |
|---|---|---|
| `ApiError` | `{ code: ApiErrorCode, message: string }` | Normalized command failure |
| `StorageError` | Same as `ApiError` | A per-record/list storage failure |
| `ListResult<T>` | `{ records: T[], errors: StorageError[] }` | List command result |

Domain records and typed event payloads are in
`src/app/shared/models/agent.model.ts` and the task/note facades. List-level
storage errors remain on their store; command-level failures go through the
shared error handler.

Workflow trust status is also a shared domain shape:
`{ hasWorkflows, trusted, folderHash, approvedHash?, files, changes }`.
`files` carries relative paths, byte sizes, and SHA-256 values; `changes`
classifies paths as added, modified, or removed.
Workflow resolution also includes `needsChoice`, `choice`, `choiceOptions`,
and `activeVia`. Patch summaries omit file text; a full patch carries file
`before`/`after` text, which is untrusted plain text.

## 3. Rust

There is no shared Rust frontend-core service. Each domain document describes
its Rust commands and events; Angular consumes their common event subscription
through `subscribeWorkEvents`.

## 4. Angular

### API wrapper and error normalization

`WorkApiService` is the typed `invoke` boundary. Structured `{ code, message }`
rejections retain their code; plain-string or other rejections become
`{ code: 'BadArgs', message }`. JavaScript arguments use camelCase. The wrapper
does not own UI state or subscribe to events.

### Event subscription helper

`subscribeWorkEvents(handlers)` registers task, note, project, run, proposal,
and patch listeners and resolves to an unlisten function. `WorkSyncService`
subscribes once, waits for registration before opening a project, applies
events to the relevant stores, and coordinates project-scoped refreshes.
`WorkspaceWatcherService` forwards filesystem batches to `WorkflowService`;
workflow-path batches trigger a debounced trust-status refresh.

### Store pattern and revision rule

Stores are client-side caches; components and facades do not write their state
directly. Task, note, and proposal event updates replace a missing record or
one with a lower `rev`. `task:reloaded` and `note:reloaded` replace
unconditionally because external edits or branch changes can preserve or reduce
revisions. List results replace their cache and retain per-record errors.
Patch summaries have no `rev`; `PatchStore` resolves duplicate and out-of-order
updates using `createdAt` and status. Stores clear when the workspace changes. See
[tasks and notes](./tasks-notes.md#tasks-notes),
[proposals](./proposals.md), [runs](./runs.md#runs), and
[patches](./patches.md#frontend) for domain APIs.

### Error handling and notifications

`handleApiError(reason, notices, refresh?, message?)` reports errors through
`NoticeManager`. It suppresses `NoProject`; with a refresh callback it refreshes
after `StaleRev` and reports the failure without silently retrying the mutation.
Callers may provide a user-facing message, including the standard
“This changed elsewhere; try again.”

| Code | Shared UI behavior |
|---|---|
| `StaleRev` | Refresh the affected data when appropriate; do not retry silently |
| `NoProject` | Suppress the notice and show the workspace empty state |
| `BadArgs` | Report the normalized error; this usually indicates a caller bug |
| Other service errors | Show the service message; domain-specific actions belong to that domain |

Domain-specific meanings and responses are documented in
[tasks and notes](./tasks-notes.md#tasks-notes),
[runs](./runs.md#runs), and [proposals](./proposals.md).

### Proposal notifier

`ProposalNotifier` does not display a toast. It accepts only unseen proposals
with `presentation: 'notify'`, groups created proposals by run, and emits
`notifications$` after a 1000 ms quiet window or 5000 ms maximum wait. Each
notification carries the run, workflow, optional task id, unique proposal ids,
and proposal kinds. `WorkSyncService` feeds it only `proposal:created` events;
the UI decides how to present and dismiss each group. See
[proposal UI recipes](./proposals.md#ui-recipes).

## 5. Flows

**Project events:** register listeners first; then the workspace coordinator
opens or closes the Rust project and refreshes the relevant stores. After an
open, it refreshes workflow trust; the shell shows a banner when project
workflows need review. No trust-review observable is implemented. The full startup sequence is in
[workspace](./workspace.md#5-flows).

**Workflow status:** `WorkflowService.status` and `templates` are refreshed
after project open. `active` is the active source status or `null`,
`activeIssue` is its issue message when status is not `ok`, and `warnings`
contains the active source warnings. An `.praide/workflows/` filesystem batch
shares the 500 ms debounce with trust refresh: status and trust refresh once
per window.

When `WorkflowStatus.needsChoice` is true, the run choice dialog uses
`choiceOptions` and `WorkflowService.choose`; `RunService.chooseAndRun` stops if
choosing fails. This state is not a run-disabled reason because the dialog
handles it.

**Patch review:** `PatchService` provides the patch summary signals and
load/apply/discard operations. Display all patch content as plain text. An
apply conflict is a `{ kind: 'conflict', message }` result; a successful apply
refreshes summaries while filesystem watcher events update the explorer.
Patch review never mutates node or tab stores.

**Workflow settings screen:** not implemented. `WorkflowService` exposes
status, templates, and creation operations, but there is no corresponding
feature screen. The shared `TrustSetting` dialog is opened from the shell's
untrusted-workflow banner. The shared no-entry dialog handles the workflow
choice state, but its source-selection actions are still in progress.

**Run button:** reasons use no-project, task-not-ready, active-run,
dependency, no-active-workflow, active-source-issue, and project-trust
wording in that order. `RunService.run(taskId)` sends only the task id; Rust
resolves the workflow scope.

**Mutation errors:** a domain facade calls the API, handles the rejection with
`handleApiError`, and refreshes on stale data when appropriate. The cache
changes from the resulting event or list refresh, not from component mutation.

### Workflow import rules

Workflow scripts use absolute imports for local helpers. Top-level helper
files and directories are on the entry file's Python path; relative package
imports and names that shadow the Praide SDK or common standard-library modules
are not supported.

The Angular 7d boundary imports workflow types from
`src/app/shared/models/agent.model.ts` and invokes Rust only through
`WorkApiService`; UI code does not read workflow files or interpret trust
files.

## 6. Gaps

There is no common store base class; domain stores retain their own record
types and refresh policies.

## 7. Logic in the wrong layer

Keep Tauri invocation and event subscription in shared Angular services,
domain decisions in their domain services, and cache updates in stores.
Components present state and invoke facades; they do not normalize command
errors or mutate caches.
