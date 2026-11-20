# Task proposal API

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
their revisions, and emits one update per changed record. Unknown and already
seen ids are ignored. Calls may include at most 100 ids.

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
