# Task proposal API (Slice 6b)

Workflows may suggest follow-up tasks, but a suggestion is stored as a proposal
and does not become a task until a user accepts it. Proposals are records in
`.cairn/runs/proposals/<id>.json`; they are not task statuses. The project root
is the only `.cairn` directory.

## Proposal record

Records use camelCase and contain:

| Field | Meaning |
|---|---|
| `id` | UUID; also becomes the created task id on acceptance |
| `kind` | `task` |
| `status` | `pending`, `accepted`, or `rejected` |
| `runId` | The run that submitted the proposal |
| `taskId` | The task the run was for, if available |
| `workflow` | Workflow name from the run context |
| `payload` | `NewTask` input using the existing task input fields |
| `createdTaskId` | Set when accepted |
| `createdAt`, `decidedAt` | Millisecond timestamps |
| `schemaVersion`, `rev` | Record schema version and optimistic revision |

`runId`, `taskId`, and `workflow` are populated by Rust from the active run;
they are never accepted as workflow-supplied payload fields. `NewTask` rejects
unknown fields, including identity and status fields.

Proposal text is untrusted data. The UI must render it as plain text, never as
HTML, and must not send it to a model as instructions.

## UI commands

The commands are asynchronous and always use the UI actor. Callers cannot
choose an actor or a proposal status.

| Command | Arguments | Result |
|---|---|---|
| `proposal_list` | — | `{ records: Proposal[], errors: StorageError[] }` |
| `proposal_accept` | `id`, `expectedRev`, optional `task` (`NewTask`) | accepted proposal and task |
| `proposal_reject` | `id`, `expectedRev` | rejected proposal |
| `proposal_delete` | `id` | `null`; only decided proposals can be deleted |

Accepting a proposal validates the submitted or edited task again, including
its dependency and linked-note references. A validation failure leaves the
proposal pending. Acceptance creates the task with the proposal id, then marks
the proposal accepted and sets `createdTaskId` and `decidedAt`. If the task
already exists with that id (for example, after a crash between those writes),
the existing task is reused. Re-accepting an accepted proposal with its task
is idempotent. Rejected proposals cannot be accepted.

Mutations use `expectedRev`; stale revisions return `StaleRev`. Invalid status
operations return `InvalidTransition`, and non-UI decisions return `Forbidden`.

## Events

| Event | Payload |
|---|---|
| `proposal:created` | Full proposal |
| `proposal:updated` | Full proposal |
| `proposal:deleted` | `{ "id": string }` |

On acceptance, Rust emits the task creation and any dependency-reconcile task
updates before `proposal:updated`, all after releasing the shared task/note/
proposal mutation lock.

## Workflow RPC

These are the only proposal-related methods available over JSON-RPC:

| Method | Parameters | Result |
|---|---|---|
| `tasks.propose` | `NewTask` fields in camelCase | `{ "proposalId": string }` |
| `proposals.list` | `{}` | `{ "id", "title", "status" }[]` |

The proposal's run id, source task id, and workflow come from the run context.
There is no RPC accept, reject, delete, or direct task-create method. Proposals
remain available for review if their workflow later fails.

## Limits

Creation rejects invalid input with `Validation` and identifies the field:

- `title` and each `subTasks.title`: 1–200 characters.
- `description` and `acceptanceCriteria`: at most 10,000 characters each.
- `subTasks`: at most 50 entries.
- Serialized `payload`: at most 65,536 bytes.
- At most 20 proposals per run, counting pending and decided proposals.
- Every `linkedNoteIds` entry and `dependsOn` must refer to an existing record
  when submitted. They are checked again on acceptance, including dependency
  cycles and targets removed after submission.
