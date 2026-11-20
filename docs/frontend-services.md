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
- `TaskItem.runs` is read-only attempt history (oldest first); it is never
  included in task input types. Every retry creates a new run.
- All service mutation methods resolve to the command result or `undefined`
  when a handled error prevented the operation, unless noted otherwise.

## API wrapper

### `WorkApiService`

Typed command boundary; it has no signals and consumes no events.

| Method | Resolves to | Command errors |
|---|---|---|
| `workflowList()` | `WorkflowInfo[]` | `NoProject`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `workflowInspect(name: string)` | `WorkflowInspect` | `NoProject`, `WorkflowNotFound`, `Validation`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `workflowTrust(name: string, hash: string)` | `void` | `NoProject`, `WorkflowNotFound`, `Validation`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `runStart(taskId: string, expectedRev: number, workflow?: string)` | `RunRecord` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `RunActive`, `TrustRequired`, `RuntimeUnavailable`, `WorkflowNotFound`, `Validation`, `Io`, `Corrupt` |
| `runCancel()` | `void` | `Io` |
| `runGet(runId?)` | `RunRecord \| null` | `NotFound`, `Validation` when an id is supplied |
| `runList(limit: number)` | `RunRecord[]` | `NoProject`, `Io` |
| `runLog(runId: string, maxLines: number)` | `string[]` | `NoProject`, `Validation`, `Io` |
| `proposalList()` | `ListResult<Proposal>` | `NoProject`, `Io` |
| `proposalAccept(id: string, expectedRev: number, payload?: ProposalPayload, sourceAction?: SourceAction)` | `AcceptResult` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `Validation`, `Io`, `Corrupt` |
| `proposalReject(id: string, expectedRev: number)` | `Proposal` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `Io`, `Corrupt` |
| `proposalDelete(id: string)` | `void` | `NoProject`, `NotFound`, `InvalidTransition`, `Io`, `Corrupt` |
| `proposalMarkSeen(ids: string[])` | `Proposal[]` | `NoProject`, `Validation`, `Io`, `Corrupt` |

Task and note command wrappers remain on this same service. All JS arguments use
camelCase.

## Stores

### `TaskStore` and `NoteStore`

Both stores are event-fed caches. `WorkSyncService` applies events; UI code
uses the task and note facades rather than mutating stores.

| API | Behavior |
|---|---|
| `records`, `errors`, `loaded` | Signals for cached records, list errors, and load state |
| `upsert(item)` | Replace only an absent/older revision |
| `reload(item)` | Replace unconditionally after an external reload event |
| `remove(id)` | Delete one record |
| `replace(items, errors)` | Apply a list result and mark loaded |
| `clear()` | Reset records, errors, and loaded state on workspace change |

### `ProposalStore`

Event-fed proposal cache; `WorkSyncService` applies events. `refresh()` coalesces
`proposal_list`; the facade handles failures and results from a cleared
workspace are discarded.

| API | Behavior |
|---|---|
| `records`, `all`, `errors`, `loaded` | Cached proposals, their list/errors, and load state |
| `upsert(proposal)` | Replace only with a newer revision |
| `remove(id)` | Delete on `proposal:deleted` |
| `replace(records, errors)` | Apply a successful list result |
| `refresh()` | Coalesced proposal list on project open/reload |
| `clear()` | Reset on workspace change |

### `RunStore`

Purpose: current/last-run snapshot, history, and bounded in-memory log cache.

| API | Behavior |
|---|---|
| `current` | `Signal<RunState \| null>`; current/last run, potentially partial |
| `history` | `Signal<RunRecord[]>` loaded by `RunService.loadHistory()` |
| `record(runId)` | `Signal<RunRecord \| undefined>` for one full cached record |
| `logLines(runId)` | Cached lines for one run |
| `started(event)` / `append(event)` / `finished(event)` | Apply run events; retain at most 500 log lines |
| `setCurrent(run)` / `setHistory(records)` / `setRecord(record)` / `setLog(runId, lines)` | Apply command results |
| `refresh()` | Coalesced `run_get()`; caches the full record and fetches the active run's log |
| `clear()` | Clear current run, history, and logs on workspace change |

The Rust lifecycle events omit some fields present on `RunRecord`: `run:started`
has no `source`, `scriptHash`, or `startedAt`; `run:finished` has no `endedAt` or `summary`. Its event-derived `RunState` stays
partial until `refresh()` replaces it with the full record; no fields are
synthesized. Live lines may overlap lines fetched during refresh.

## Services

### `WorkflowService`

Workflow list and trust-dialog inspection data.

| API | Behavior |
|---|---|
| `workflows` | `Signal<WorkflowInfo[]>` of the latest workflow list |
| `refresh()` | Coalesced `workflow_list()` after project open |
| `inspect(name)` | Return script path, hash, and file inventory for trust |
| `clear()` | Reset workspace-scoped state |

List and inspect errors are reported through `handleApiError`; the service
consumes no events.

### `RunService`

Start/cancel workflows and expose live run state.

| API | Behavior |
|---|---|
| `current` | `Signal<RunState \| null>` from `RunStore` |
| `isRunning` | `Signal<boolean>`; run is unfinished and its cached task is running when present |
| `logLines(runId)` | `Signal<string[]>` from the bounded run buffer |
| `runDisabledReason(task, workflow?)` / `canRun(task, workflow?)` | Explain or check project, task, run, dependency, and workflow eligibility |
| `run(taskId, workflow?)` | Call `run_start`; return `started`, or `trust-required` without toasting |
| `trustAndRun(taskId, workflowName, hash)` | Call `workflow_trust`, then retry `run` |
| `cancel()` | Call `run_cancel()` |
| `refresh()` | Refresh `run_get()` and the active run's log |
| `loadHistory(limit)` / `loadLog(runId, maxLines)` | Call `run_list` / `run_log` and cache results |
| `attemptCount(task)` / `lastRunId(task)` | Read task history locally; no command calls |
| `loadRunsFor(task, limit = 5)` | Load the newest task attempts, fetching only cache misses and skipping deleted runs |
| `clear()` | Clear run state on workspace change |

Without a workflow name, selection uses `default` when present, otherwise the
only listed workflow. If several non-default workflows exist, the run action
requires an explicit choice.

Errors other than the handled `TrustRequired` path are reported through
`handleApiError`; `NoProject` is suppressed by that helper. The service consumes
`run:started`, `run:log`, and `run:finished` through `WorkSyncService`.

### `ProposalService`

Proposal inbox/planning projections and user decisions.

| API | Behavior |
|---|---|
| `all`, `pending`, `display`, `notifications`, `unseenCount`, `byRun` | Signals for proposal views and grouping |
| `refresh()` | Coalesced `proposal_list()` on open/reload; reports list errors |
| `accept(proposal, options?)` | Accept with cached `rev`, optional edited payload and source action |
| `reject(proposal)` | Reject using cached `rev` |
| `remove(proposal)` | Delete only an accepted/rejected proposal |
| `markSeen(ids)` | Dismiss notifications; Rust ignores unknown/already-seen ids and accepts at most 100 |
| `clear()` | Clear workspace-scoped records |

Decision errors go through `handleApiError`; stale accept/reject refreshes the
list. `WorkSyncService` feeds proposal events.

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
`proposalCreated()` only for `proposal:created`; the notifier excludes `display`
and already-seen proposals, grouping each run with a 1000 ms quiet window and
5000 ms maximum wait. It does not toast; the UI presents and dismisses groups.

### `TaskService` action API (existing facade)

`availableActions` returns applicable `{ action, enabled, reason? }` entries.
Disabled actions are not executed. Mutations use cached `rev`; stale updates
refresh the affected task. Errors are handled through `handleApiError`.

| API | Behavior |
|---|---|
| `records`, `errors`, `loaded`, `tasks`, task-status projections | Task cache and filtered signals |
| `availableActions(task)` | Status actions, including workflow eligibility |
| `perform(task, action, options?)` | Route start/run/cancel/complete/review/retry/reopen; run accepts `{ workflow? }` |
| `refresh()`, `get(id)`, `select(id)`, `canStart(id)`, `getDependentTasks(id)` | Read and refresh tasks |
| `add`, `edit`, `delete`, `start`, `complete`, `setStatus`, task mutators | Existing task command facade |

### `WorkSyncService`

App-wide subscription and workspace lifecycle coordinator, instantiated by the
app initializer.

| Lifecycle | Behavior |
|---|---|
| Subscribe | Listen once to task, note, project, run, and proposal events |
| Workspace change | Clear caches, then close or open the project |
| Project open | Refresh tasks, notes, proposals, run, and workflows |
| `project:reloaded` | Refresh tasks, notes, and proposals |

### `NoteService` (existing facade)

Note facade over the event-fed `NoteStore`; refresh coalesces list requests.
Handled API errors go through `handleApiError`.

| API | Behavior |
|---|---|
| `records`, `errors`, `loaded`, `notes`, `openNotes`, `completedNotes`, `inboxNotes` | Note cache and filtered signals |
| `refresh()`, `get(id)` | Read and refresh notes |
| `add`, `edit`, `delete` | Create, update, and delete notes |
| `setAnchors`, `setAnchor`, `addAnchor`, `removeAnchor`, `setStatus`, `toggleStatus` | Note mutations |

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
3. On the run action call
   `await taskService.perform(task, 'run', { workflow })`; omit `workflow` to
   use `default`, or the sole listed workflow when there is exactly one.
4. On `{ kind: 'started', run }`, show the active state from
   `runService.current()` / `runService.isRunning()`. The event-fed task status
   also changes to `running`.
5. On `{ kind: 'trust-required', workflow }`, follow the trust-dialog recipe.
   Other handled errors appear through `NoticeManager`.
6. On `run:finished`, the event-derived state is interim; `RunStore.refresh()`
   fetches the full run record. `isRunning()` becomes false and the task event
   carries the task's resulting status.

### Trust dialog

1. `const result = await runService.run(task.id, workflowName)`.
2. If `result?.kind === 'trust-required'`, display its `path`, `hash`, and
   `files`, and plainly warn: **the script runs with your permissions**.
3. After approval call
   `await runService.trustAndRun(task.id, result.workflow.name, result.workflow.hash)`.
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

### Progress per subtask during a run

1. Read `runStore.stepStatus(runId)()` for the live latest event state keyed by
   `subtaskId`; each value contains `status` plus optional `summary` and
   `reason`.
2. Read `taskService.subtaskProgress(task)` for aggregate counts and
   `percent`, or read the full `RunRecord.steps` array after `run:finished`
   refresh and `run_get`.
3. The step event map is workspace-scoped and is cleared on workspace change.

### Resume after a failure

1. For a failed task, read `availableActions(task)`. A `resume` action appears
   next to `retry` only when completed/needs-review progress exists, unfinished
   pending steps remain, and run blockers are clear.
2. Read `runService.resumeInfo(task)` for the attempt number and done, total,
   and pending step counts for labels. The action hint is already phrased as
   `"N of M steps done"`; the UI decides button wording.
3. Calling `perform(task, 'resume')` sets the task to `ready` first and then
   starts the workflow. It stops if the status update fails.
4. Retry then Run behaves like Resume anyway: finished steps remain
   `needs_review` or `completed`, so a retry skips them and continues with
   pending steps.

### Review steps and complete

1. Read live step statuses from `runStore.stepStatus(runId)()`, and use the
   refreshed `RunRecord.steps` for the ordered final review.
2. Call the normal task action `perform(task, 'complete')` once after review.
3. Completing a task completes all of its `needs_review` subtasks in Rust as
   part of the task write. The UI must not call subtask completion once per
   subtask.

### Task run history

Every retry creates a new run and appends its id to the task's read-only
`runs` history. Use `runService.attemptCount(task)` for the number of recorded
attempts and `runService.lastRunId(task)` for the newest id. To list recent
attempts, call `await runService.loadRunsFor(task, 5)`; results are newest
first, only the newest requested ids are considered, and ids already in
`RunStore` are not fetched again. Missing/deleted run folders are skipped.
To open an older attempt's log, call
`await runService.loadLog(record.runId, 500)` and read
`runService.logLines(record.runId)`.

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

### Startup

1. Subscribe to work events before opening a project.
2. Call `project_open(path)`.
3. Refresh tasks, notes, proposals, the current run, and workflows.
   `WorkSyncService` follows this order on workspace changes.
4. On restart, pending unseen notify proposals appear in the inbox and
   `unseenCount`. They do not produce toasts: the notifier reacts only to
   `proposal:created` events, not list results.

### Known limits

- Run events omit record fields; the current run remains partial until the
  post-finish refresh obtains the full record.
- Live log events can overlap log lines fetched by a refresh.
- Proposals created before the app starts do not trigger notifier emissions.
