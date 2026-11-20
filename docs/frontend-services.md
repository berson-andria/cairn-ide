# Frontend services for runs, workflows, and proposals

These APIs are Angular clients of the Rust task, run, workflow, and proposal
commands. The stores are caches; command results do not replace event-fed
records except where a service explicitly returns a one-shot result. Subscribe
to events before opening a project. Proposal text, workflow logs, and model
output are untrusted plain text.

## Conventions and types

- `WorkApiService` is the typed Tauri `invoke` wrapper. It converts object
  rejections to `{ code, message }` and plain-string rejections to
  `{ code: 'BadArgs', message }`.
- `handleApiError` in `core/services/tauri/api-error.ts` reports service errors
  through `NoticeManager`, suppresses `NoProject`, and can refresh after
  `StaleRev`. Task and note facades use it to reload the affected record.
- List commands return `ListResult<T> = { records: T[]; errors: StorageError[] }`.
  The list's storage errors stay on their store; command-level failures are
  reported through `handleApiError`.
- Domain records and event payloads are in
  `src/app/shared/models/agent.model.ts`. Proposal `payload` is discriminated by
  `kind`; acceptance payloads are validated again by Rust.
- All service mutation methods resolve to the command result or `undefined`
  when a handled error prevented the operation, unless noted otherwise.

## API wrapper

### `WorkApiService`

Typed command boundary; it has no signals and consumes no events.

| Method | Resolves to | Command errors |
|---|---|---|
| `workflowList()` | `WorkflowInfo[]` | `NoProject`, `Io`, `Corrupt` |
| `workflowInspect(name: string)` | `WorkflowInspect` | `NoProject`, `WorkflowNotFound`, `Io`, `Corrupt` |
| `workflowTrust(name: string, hash: string)` | `void` | `NoProject`, `WorkflowNotFound`, `TrustRequired`, `Validation`, `Io` |
| `runStart(taskId: string, expectedRev: number, workflow?: string)` | `RunRecord` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `RunActive`, `TrustRequired`, `RuntimeUnavailable`, `WorkflowNotFound`, `Validation`, `Io` |
| `runCancel()` | `void` | `NoProject`, `Io` |
| `runGet()` | `RunRecord \| null` | `Io`, `Corrupt` |
| `runList(limit: number)` | `RunRecord[]` | `NoProject`, `Io` |
| `runLog(runId: string, maxLines: number)` | `string[]` | `NoProject`, `Validation`, `Io` |
| `proposalList()` | `ListResult<Proposal>` | `NoProject`, `Io`, `Corrupt` |
| `proposalAccept(id: string, expectedRev: number, payload?: ProposalPayload, sourceAction?: SourceAction)` | `AcceptResult` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `Forbidden`, `Validation`, `Io` |
| `proposalReject(id: string, expectedRev: number)` | `Proposal` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `Forbidden`, `Io` |
| `proposalDelete(id: string)` | `void` | `NoProject`, `NotFound`, `InvalidTransition`, `Forbidden`, `Io` |
| `proposalMarkSeen(ids: string[])` | `Proposal[]` | `NoProject`, `Validation`, `Io` |

Task and note command wrappers remain on this same service. All JS arguments use
camelCase.

## Stores

### `TaskStore` and `NoteStore`

Each keeps `records: Signal<Record<string, TaskItem|NoteItem>>`,
`errors: Signal<StorageError[]>`, and `loaded: Signal<boolean>`. `upsert`
accepts only a newer `rev`; `reload` replaces unconditionally for external
changes; `remove`, `replace`, and `clear` manage the cache. The existing
`TaskService.refresh()` and `NoteService.refresh()` coalesce concurrent list
requests. These stores do not subscribe to events directly; `WorkSyncService`
feeds them. For each store, `upsert(item)` only replaces an absent/older
revision, `reload(item)` replaces regardless of revision, `remove(id)` deletes,
`replace(items, errors)` sets records/errors and marks loaded, and `clear()`
resets records/errors/loaded. These are internal cache methods; UI code calls
the facades instead.

### `ProposalStore`

Purpose: event-fed proposal cache and proposal-list loading.

| Signal | Type | Meaning |
|---|---|---|
| `records` | `Signal<Record<string, Proposal>>` | Proposals keyed by id |
| `all` | `Signal<Proposal[]>` | Current cache values |
| `errors` | `Signal<StorageError[]>` | Per-record/list storage errors |
| `loaded` | `Signal<boolean>` | Whether a list result has been applied |

`upsert(proposal)` accepts only a higher `rev`; `remove(id)` deletes; `replace`
applies a list result; `clear()` resets all signals on workspace change.
`refresh(): Promise<void>` calls `proposal_list`; concurrent calls share one
promise. List command failures reject to `ProposalService.refresh()` for
handling. An in-flight result from a cleared workspace is discarded. It
consumes no events directly.

| Method | Signature / result | Errors and when to call |
|---|---|---|
| `upsert` | `(proposal: Proposal): void` | Event handler only; ignores equal/older revisions |
| `remove` | `(id: string): void` | On `proposal:deleted` |
| `replace` | `(records: Proposal[], errors: StorageError[]): void` | On successful `proposal_list` |
| `refresh` | `(): Promise<void>` | Coalesced `proposal_list`; on project open/reload |
| `clear` | `(): void` | On workspace change |

### `RunStore`

Purpose: current/last-run snapshot, history, and bounded in-memory log cache.

| Signal/API | Type | Meaning |
|---|---|---|
| `current` | `Signal<RunState \| null>` | Active or most recently known run; event-derived values may be partial |
| `history` | `Signal<RunRecord[]>` | Records loaded by `RunService.loadHistory()` |
| `logLines(runId)` | `Signal<string[]>` | Cached log lines for one run |

`started(event)` sets the current run and starts its buffer; `append(event)`
retains the newest 500 lines; `finished(event)` applies outcome and reason to
the matching current run; `setCurrent`, `setHistory`, and `setLog` apply command
results. `refresh(): Promise<void>` coalesces `run_get()` and, when active,
fetches `run_log(runId, 500)` once. Live lines may overlap lines fetched during
refresh, so a short run of duplicate log lines after refresh is acceptable.
`clear()` removes the current run, history, and logs on workspace change.
`started(event: RunStartedEvent)`, `append(event: RunLogEvent)`, and
`finished(event: RunFinishedEvent)` consume the corresponding events;
`setCurrent(run: RunRecord | null)`, `setHistory(records: RunRecord[])`, and
`setLog(runId: string, lines: string[])` apply explicit refresh/history/log
loads. The refresh rejects command errors to `RunService.refresh()`.

The Rust lifecycle events omit some fields present on `RunRecord`: `run:started`
has no `source`, `scriptHash`, or `startedAt`; `run:finished` has no `endedAt`
or `summary`. Accordingly, the event-fed `RunState` is partial until a command
returns a full record. No placeholder field values are synthesized.

## Services

### `WorkflowService`

Purpose: workflow list and trust-dialog inspection data.

| Signal | Type | Meaning |
|---|---|---|
| `workflows` | `Signal<WorkflowInfo[]>` | Latest workflow list |

`refresh(): Promise<void>` coalesces `workflow_list()` and is called after
`project_open`. `inspect(name: string): Promise<WorkflowInspect | undefined>`
returns the script path/hash/file inventory for the trust dialog.
`clear(): void` resets workspace-scoped workflow state. It consumes no events.
List and inspect errors are reported through `handleApiError`.

### `RunService`

Purpose: start/cancel workflows and expose live run state.

| Signal/API | Type | Meaning |
|---|---|---|
| `current` | `Signal<RunState \| null>` | Delegates to `RunStore.current` |
| `isRunning` | `Signal<boolean>` | Current run has neither `endedAt` nor an outcome |
| `logLines(runId)` | `Signal<string[]>` | Delegates to the bounded `RunStore` buffer |

Methods:

- `canRun(task: TaskItem): boolean` is true only for `ready` tasks with no
  active run, an open project, and no dependency or a completed dependency.
- `run(taskId: string, workflow?: string): Promise<RunResult | undefined>` calls
  `run_start(taskId, task.rev, workflow)`. Result is
  `{ kind: 'started', run }`, or on `TrustRequired`,
  `{ kind: 'trust-required', workflow: WorkflowInspect }`. The trust case does
  not toast. Other errors go through `handleApiError`.
- `trustAndRun(taskId: string, workflowName: string, hash: string): Promise<RunResult | undefined>`
  calls `workflow_trust` first and only then calls `run`.
- `cancel(): Promise<void>` calls `run_cancel()`.
- `refresh(): Promise<void>` refreshes `run_get()` and the active run's log.
- `loadHistory(limit: number): Promise<RunRecord[] | undefined>` calls `run_list`.
- `loadLog(runId: string, maxLines: number): Promise<string[] | undefined>` calls `run_log` and
  replaces that run's cached lines.
- `clear()` clears run state for workspace changes.

Errors other than the handled `TrustRequired` path are reported through
`handleApiError`; `NoProject` is suppressed by that helper. The service consumes
`run:started`, `run:log`, and `run:finished` through `WorkSyncService`.

### `ProposalService`

Purpose: proposal inbox/planning projections and user decisions.

| Signal | Type | Meaning |
|---|---|---|
| `all` | `Signal<Proposal[]>` | Every cached proposal |
| `pending` | `Signal<Proposal[]>` | Pending proposals |
| `display` | `Signal<Proposal[]>` | Pending proposals with `presentation: 'display'` |
| `notifications` | `Signal<Proposal[]>` | Pending proposals with `presentation: 'notify'` |
| `unseenCount` | `Signal<number>` | Pending notify proposals without `seenAt` |
| `byRun` | `Signal<Record<string, Proposal[]>>` | All proposals grouped by run id |

Methods:

- `refresh(): Promise<void>` coalesces `proposal_list()` through the store and
  is called after project open and `project:reloaded`.
- `accept(proposal, options?): Promise<AcceptResult | undefined>` supplies the
  cached proposal's `rev` as `expectedRev`, plus optional edited `payload` and
  `sourceAction`. On `StaleRev` it refreshes the full list and reports
  “This changed elsewhere; try again.”
- `reject(proposal): Promise<Proposal | undefined>` supplies the cached
  `expectedRev`.
- `remove(proposal): Promise<void>` calls `proposal_delete`; only decided
  proposals may be deleted.
- `markSeen(ids): Promise<void>` calls `proposal_mark_seen`; Rust ignores
  unknown/already-seen ids and accepts at most 100 ids. Changed records are
  applied by the proposal events.
- `clear()` clears workspace-scoped records.

Decision errors are reported through `handleApiError`. A `StaleRev` from
`accept` refreshes the store before the notice; `reject` also refreshes on
`StaleRev`. The service consumes `proposal:created`, `proposal:updated`, and
`proposal:deleted` through `WorkSyncService`.

| Method | Signature / result | Errors and when to call |
|---|---|---|
| `refresh` | `(): Promise<void>` | On project open/reload; reports list errors |
| `accept` | `(proposal: Proposal, options?: { payload?: ProposalPayload; sourceAction?: SourceAction }): Promise<AcceptResult \| undefined>` | Pending proposal approval/edit |
| `reject` | `(proposal: Proposal): Promise<Proposal \| undefined>` | Reject a pending proposal |
| `remove` | `(proposal: Proposal): Promise<void>` | Remove only after accepted/rejected |
| `markSeen` | `(ids: string[]): Promise<void>` | Dismiss notifications; does not reject |
| `clear` | `(): void` | On workspace change |

Exported pure editing helpers:

- `editablePayload(proposal)` returns a deep copy of its payload.
- `removeBatchItem(payload, key)` returns `{ payload }`, or
  `{ error: 'has-dependents', keys }` when another item references the key by
  `dependsOnKey`.
- `removeSubtaskItem(payload, index)` returns a copied subtask payload without
  that item.

### `ProposalNotifier`

Purpose: group new notify proposals for the UI to present; it does not toast.

`notifications$: Observable<ProposalNotification>` emits
`{ runId, workflow, taskId?, proposalIds, kinds }`. `WorkSyncService` calls
`proposalCreated(proposal: Proposal): void` only for `proposal:created`; the notifier filters out
`display` proposals and proposals with `seenAt`, then coalesces same-run
proposals until one second of inactivity. It consumes no Tauri event directly.
The UI decides whether/how to show a toast and can call `markSeen(ids)` when
dismissed.

### `TaskService` action API (existing facade)

`availableActions(task): AvailableTaskAction[]` returns each applicable
`{ action, enabled, reason? }` for the status transition table. In particular,
`start` requires a missing/completed dependency and `run` additionally requires
`RunService.canRun(task)`. `perform(task, action)` routes to `task_start`,
`run_start` via `RunService`, `task_complete`, or `task_set_status(..., 'ready')`
for `sendBack`, `retry`, and `reopen`. Disabled actions are not executed.
Existing task methods (`add`, `edit`, `delete`, `start`, `complete`,
`setStatus`, etc.) remain available. Mutations use cached `rev`; stale updates
refresh the affected task and report the changed-elsewhere notice.

Added method signatures:

- `availableActions(task: TaskItem): AvailableTaskAction[]`
- `perform(task: TaskItem, action: TaskAction): Promise<TaskItem | RunResult | undefined>`

`start` and `complete` resolve to the resulting `TaskItem` or `undefined`;
`run` resolves to the `RunService` result or `undefined`; `sendBack`, `retry`,
and `reopen` resolve to the updated `TaskItem` or `undefined`. API errors are
handled through `handleApiError`.

The facade also exposes `records`, `errors`, and `loaded` from `TaskStore`;
computed `tasks`, `selectedTask`, `readyTasks`, `runningTasks`,
`blockedTasks`, `completedTasks`, `needsReviewTasks`, `failedTasks`, and
`availableTasks`; plus `selectedTaskId`. Existing methods include
`refresh(): Promise<void>`, `get(id: string): TaskItem | undefined`,
`select(id: string): void`, `canStart(id: string): boolean`,
`getDependentTasks(id: string): TaskItem[]`, `add(data: NewTask)`,
`edit(id: string, patch: TaskPatch)`, `delete(id: string)`,
`setStatus(id: string, status: TaskStatus)`, `start(id: string)`,
`complete(id: string)`, and the anchor, note-link, dependency, subtask,
acceptance-criteria, and branch mutators. Mutation methods resolve to a
`TaskItem` or `undefined` (delete resolves `void`); errors are reported through
`handleApiError`.

### `WorkSyncService`

Purpose: app-wide single subscription and workspace lifecycle coordinator.
It exposes no signals or public command methods. It is instantiated by the app
initializer. It subscribes once to task, note, project, run, and proposal events
before allowing `project_open`; event handlers update the corresponding
stores. `project:reloaded` refreshes tasks, notes, and proposals. On workspace
change it clears task, note, proposal, run, and workflow caches, then closes or
opens the project and refreshes the relevant services.

### `NoteService` (existing facade)

Signals: `records: Signal<Record<string, NoteItem>>`,
`errors: Signal<StorageError[]>`, `loaded: Signal<boolean>`,
`notes: Signal<NoteItem[]>`, `openNotes: Signal<NoteItem[]>`,
`completedNotes: Signal<NoteItem[]>`, and `inboxNotes: Signal<NoteItem[]>`.
Methods: `refresh`, `get`, `add`, `edit`, `delete`,
`setAnchors`, `setAnchor`, `addAnchor`, `removeAnchor`, `setStatus`, and
`toggleStatus`. Commands resolve to their record/void result or `undefined`
when a handled error prevents the operation. It consumes no events directly;
`WorkSyncService` feeds `NoteStore`. `refresh()` coalesces list requests.
Public signatures are `refresh(): Promise<void>`,
`get(id: string): NoteItem | undefined`,
`add(note: NewNote): Promise<NoteItem | undefined>`,
`edit(id: string, patch: NotePatch): Promise<NoteItem | undefined>`,
`delete(id: string): Promise<void>`,
`setAnchors(id: string, anchors: NoteAnchor[]): Promise<NoteItem | undefined>`,
`setAnchor(id: string, anchor: NoteAnchor | NoteAnchor[] | null)`,
`addAnchor(id: string, anchor: NoteAnchor)`,
`removeAnchor(id: string, index: number)`,
`setStatus(id: string, status: NoteStatus)`, and `toggleStatus(id: string)`.
Mutators resolve to their record/void result or `undefined`; API errors are
handled through `handleApiError`.

## Error table

| Code | Meaning | Existing service behavior |
|---|---|---|
| `StaleRev` | Record changed since the caller read it | Task/note facades refetch the record; proposal acceptance refreshes the list. All report “This changed elsewhere; try again.” and do not retry. |
| `NotFound` | Referenced item is absent | Reported; proposal operations also refresh if the proposal is absent from cache. |
| `InvalidTransition` | Requested status/decision transition is invalid | Reported; refresh the UI from event-fed state. |
| `Forbidden` | Caller is not permitted to make the transition | Reported as an error. |
| `Validation` | Input or edited payload failed validation | Reported with Rust's message. |
| `NoProject` | No project is open | `handleApiError` suppresses the toast. |
| `RunActive` | Another workflow is active | Reported; `isRunning` allows the UI to disable run actions. |
| `TrustRequired` | Project workflow hash is not approved | `RunService.run` returns `trust-required` and does not toast. |
| `RuntimeUnavailable` | Workflow launcher/SDK is unavailable | Reported with Rust's message. |
| `WorkflowNotFound` | Workflow name cannot be resolved | Reported with Rust's message. |
| `Io`, `Corrupt` | Disk or record problem | Reported with Rust's message; list-level storage errors remain in store `errors`. |
| `BadArgs` | Tauri rejected a plain-string/bad-shape argument | Normalized by `WorkApiService`; reported as an error. |

`handleApiError` suppresses `NoProject`; it handles stale refreshes when given a
refresh callback. `RunService` is the sole special case for `TrustRequired`.
No service retries a rejected mutation silently.

## UI recipes

### Run button and its states

1. Read the task from `TaskService` and render the actions returned by
   `taskService.availableActions(task)`.
2. Derive a run-in-progress state from `runService.isRunning()`; disabled
   actions include a `reason`.
3. On the run action call `await runService.run(task.id)`.
4. On `{ kind: 'started', run }`, show the active state from
   `runService.current()` / `runService.isRunning()`. The event-fed task status
   also changes to `running`.
5. On `{ kind: 'trust-required', workflow }`, follow the trust-dialog recipe.
   Other handled errors appear through `NoticeManager`.
6. On `run:finished`, `current` has its outcome/reason and `isRunning()` becomes
   false; the task event carries the task's resulting status.

### Trust dialog

1. `const result = await runService.run(task.id, workflowName)`.
2. If `result?.kind === 'trust-required'`, display its `path`, `hash`, and
   `files`, and plainly warn: **the script runs with your permissions**.
3. After approval call
   `await runService.trustAndRun(task.id, workflow.name, workflow.hash)`.
   This calls `workflow_trust` before retrying `run_start`.
4. If the hash has changed since inspection, Rust rejects trust/start and the
   service reports the error; inspect again before asking for approval.

### Live log view

1. Obtain `const lines = runService.logLines(runId)` and render `lines()` as
   plain text.
2. For a known run after reload, call
   `await runService.loadLog(runId, 500)` once to refill the signal.
3. Live `run:log` events append to that run's buffer; it retains at most 500
   newest lines. A refresh may briefly duplicate overlapping lines.

### Proposal inbox

1. Read `proposalService.notifications()` for pending notify items and
   `proposalService.unseenCount()` for the badge.
2. Use `proposalService.all()` or `byRun()` for decided/history context.
3. Dismissal calls `await proposalService.markSeen(ids)`; it does not reject.
4. Accept by calling
   `await proposalService.accept(proposal, { payload, sourceAction })`, or
   reject with `await proposalService.reject(proposal)`. Remove only decided
   records with `await proposalService.remove(proposal)`.
5. Event-fed proposal signals update after Rust emits the changes.

### Planning view (display proposals)

1. Read `proposalService.display()` for pending proposals with
   `presentation: 'display'`.
2. Copy editable data with `editablePayload(proposal)` before editing; render
   all strings as plain text.
3. Accept the edited payload with
   `await proposalService.accept(proposal, { payload })`, or call
   `proposalService.reject(proposal)`.
4. The notifier never emits for display proposals.

### Notification toast with grouping

1. Subscribe to `proposalNotifier.notifications$`.
2. Each emission contains one run's grouped `proposalIds` and unique `kinds`,
   alongside its `workflow` and optional `taskId`.
3. Look up proposal details through `proposalService.byRun()` or
   `proposalService.all()` and present one grouped notification.
4. On dismissal call `proposalService.markSeen(notification.proposalIds)`.
   Already-seen proposals and display proposals do not create notifications.

### Split-task approval

1. Find a pending `kind: 'tasks'` proposal in `proposalService.all()` and make a
   deep editable copy with `editablePayload(proposal)`.
2. Before removing a batch item, call `removeBatchItem(payload, key)`. If the
   result is `{ error: 'has-dependents', keys }`, keep the referenced item(s)
   or edit those dependencies first.
3. If `payload.sourceTaskId` exists, present the `keep` / `delete` choice.
   Choose `delete` only when the source task may be removed; Rust rejects
   deleting a running source. The default is `keep`.
4. Call
   `await proposalService.accept(proposal, { payload, sourceAction: 'keep' })`
   or use `'delete'`. Rust creates the tasks before deleting the source and
   revalidates the final payload.
