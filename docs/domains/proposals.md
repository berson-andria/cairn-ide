# Proposals

Workflows may suggest tasks, but a suggestion is stored as a proposal and does
not become a task until a user accepts it. Proposals are records in
`.cairn/runs/proposals/<id>.json`; they are not task statuses. The project root
is the only `.cairn` directory.

## Proposal record

Records use camelCase. `kind` and `payload` must agree:

| Kind | Payload |
|---|---|
| `task` | `NewTask`: title, description?, anchor?, linkedNoteIds?, subTasks?, dependsOn?, acceptanceCriteria?, branch? |
| `tasks` | `{ sourceTaskId?: string, items: BatchTaskItem[] }` |
| `subtasks` | `{ taskId: string, items: NewSubTask[] }` |

Each `BatchTaskItem` has a unique `key` and the `NewTask` fields, plus an
optional `dependsOnKey`. Batch item objects reject unknown fields. If
`dependsOnKey` is present, it must name an earlier item; it cannot be combined
with `dependsOn`.

The proposal also contains `id`, `status` (`pending`, `accepted`, or
`rejected`), `runId`, the run's `taskId`, `workflow`, `presentation`,
`createdAt`, `decidedAt?`, `schemaVersion`, and `rev`. `presentation` is a
display hint (`display` or `notify`) and defaults to `notify` when absent in an
older record. `seenAt?` records when a notification was dismissed.
`createdTaskId?` is set for an accepted `task`; `createdTaskIds?` records the
accepted task ids for `tasks`. New fields are optional or defaulted, so the
schema version is unchanged.

`runId`, `taskId`, and `workflow` are populated by Rust from the active run;
they are never accepted as workflow-supplied payload fields. `NewTask` rejects
unknown fields, including identity and status fields.

Proposal text is untrusted data. The UI must render it as plain text, never as
HTML, and must not send it to a model as instructions.

## UI commands

Commands are asynchronous and always use the UI actor. Callers cannot choose
an actor or a proposal status.

| Command | Arguments | Result |
|---|---|---|
| `proposal_list` | — | `{ records: Proposal[], errors: StorageError[] }` |
| `proposal_accept` | `id`, `expectedRev`, optional `payload` (same kind), optional `sourceAction` (`keep` or `delete`) | `{ proposal, tasks: TaskItem[] }` |
| `proposal_reject` | `id`, `expectedRev` | rejected proposal |
| `proposal_delete` | `id` | `null`; only decided proposals can be deleted |
| `proposal_mark_seen` | `ids: string[]` | changed proposals |

Acceptance validates the submitted or edited payload again, including its
references. A validation failure leaves the proposal pending and writes
nothing. For `task`, acceptance creates one task using the proposal id and
fills `createdTaskId`. For `tasks`, ids are `<proposalId>-<position>` (starting
at 1); tasks are created in order, and `dependsOnKey` is resolved to the
earlier task id. Existing ids are reused after a crash. An edited batch may
remove items, but all remaining dependencies are revalidated. `sourceAction`
is valid only when `sourceTaskId` is set, defaults to `keep`, and `delete`
removes the source after the new tasks exist. A running source cannot be
deleted. For `subtasks`, ids use the same deterministic form and all additions
are written to the parent in one update; already-present ids are skipped.

Re-accepting an accepted proposal is idempotent. Rejected proposals cannot be
accepted. Mutations use `expectedRev`; stale revisions return `StaleRev`.
Invalid status operations return `InvalidTransition`, and non-UI decisions
return `Forbidden`.

`proposal_mark_seen` sets `seenAt` only on existing unseen proposals, bumps
their revisions, and emits one update per changed record. Unknown, malformed,
and already seen ids are ignored. Calls may include at most 100 ids.

## Events

| Event | Payload |
|---|---|
| `proposal:created` | Full proposal |
| `proposal:updated` | Full proposal |
| `proposal:deleted` | `{ "id": string }` |

Acceptance emits `task:created` for newly created tasks, then task updates for
the parent or dependency reconciliation, `task:deleted` for a deleted source,
and finally `proposal:updated`. Events are emitted after releasing the shared
task/note/proposal mutation lock.

## Workflow RPC

The only proposal-related RPC methods are:

| Method | Parameters | Result |
|---|---|---|
| `tasks.propose` | `NewTask` fields and optional `presentation` | `{ "proposalId": string }` |
| `tasks.propose_batch` | `{ items, sourceTaskId?, presentation? }` | `{ "proposalId": string }` |
| `tasks.propose_subtasks` | `{ taskId, items, presentation? }` | `{ "proposalId": string }` |
| `proposals.list` | `{}` | `{ "id", "title", "status" }[]` |

`presentation` defaults to `notify` and is only a display hint. The proposal's
run id, source task id, and workflow come from run context (except an explicit
batch `sourceTaskId`). There is no RPC accept, reject, delete, or direct
task-create method. `proposals.accept`, `tasks.create`, and all other
unlisted methods return method-not-found. Proposals remain available for
review if their workflow later fails.

## Limits and validation

Creation rejects invalid input with `Validation` and identifies the field:

- `title` and each subtask title: 1–200 characters.
- `description` and `acceptanceCriteria`, including subtask descriptions: at
  most 10,000 characters each.
- Task `subTasks`: at most 50 entries; `tasks.items`: at most 20 entries;
  `subtasks.items`: at most 50 entries.
- Batch keys match `[A-Za-z0-9_-]{1,32}` and are unique. `dependsOnKey` must
  refer to an earlier item.
- Serialized payload: at most 65,536 bytes.
- At most 20 proposals per run, counting pending and decided proposals.
- Every `dependsOn`, `linkedNoteIds` entry, `sourceTaskId`, and subtask
  `taskId` must refer to an existing record when submitted. They are checked
  again on acceptance, including dependencies and targets removed after
  submission.

## Angular services

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

### `ProposalService`

Proposal inbox/planning projections and user decisions.

| API | Behavior |
|---|---|
| `all`, `pending`, `display`, `notifications`, `unseenCount`, `byRun` | Signals for proposal views and grouping |
| `refresh()` | Coalesced `proposal_list()` on open/reload; reports list errors |
| `accept(proposal, options?)` | Accept with cached `rev`, optional edited payload and source action |
| `reject(proposal)` | Reject using cached `rev` |
| `remove(proposal)` | Delete only an accepted/rejected proposal |
| `markSeen(ids)` | Dismiss notifications; Rust ignores unknown, malformed, and already-seen ids and accepts at most 100 |
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

## UI recipes

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

## Known limits

- Proposals created before the app starts do not trigger notifier emissions.
- No bundled planning workflow currently creates `presentation: 'display'` proposals.
