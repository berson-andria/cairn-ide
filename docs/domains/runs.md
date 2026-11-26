# Runs, workflows, and SDK

## runs

Rust starts a trusted Python workflow as a child process. The child uses the
stdlib-only SDK at `sdk/python/cairn`; it never reads or writes project files
directly. The SDK and host communicate over the child's stdin and stdout using
JSON-RPC 2.0, one UTF-8 JSON message per line. Stdout is reserved for RPC;
workflow `print()` output is redirected to stderr and becomes run log output.
Lines larger than 1 MB are rejected with `-32600`.

### Starting and managing runs

The Tauri commands are:

| Command | Arguments | Result |
|---|---|---|
| `run_start` | `taskId`, `expectedRev` | run record |
| `run_cancel` | — | `null` |
| `run_get` | optional `runId` | with an id, that run record; without one, active run record, last run record, or `null` |
| `run_list` | `limit` | run records, newest first |
| `run_log` | `runId`, `maxLines` | `string[]` |
| `workflow_status` | — | resolved scope, choice requirement, and per-scope folder status |
| `workflow_choose` | `scope` (`bundled` or `global`) | `null` |
| `workflow_choice_clear` | — | `null` |
| `workflow_templates` | — | `[{ id, title, description }]` |
| `workflow_template_get` | `id` | template source text |
| `workflow_create` | `scope`, `template` | `{ source, entry, entryPath }` |
| `workspace_trust_status` | — | current folder hash, file inventory, approval and changes |
| `workspace_trust` | `hash` | `null` |
| `workspace_trust_revoke` | — | `null` |

`run_list` reads `.cairn/runs/*/run.json`, skips and logs unreadable or
malformed records, and clamps `limit` to 1–50. Active records omit `endedAt`.
When `run_get` receives `runId`, it returns the active in-memory record if that
id matches; otherwise it reads `.cairn/runs/<runId>/run.json`. An unknown id
returns `NotFound`; malformed ids return `Validation`.
`run_log` returns the last `maxLines` lines from a run's log, clamped to
1–2000; a missing log returns an empty array. `runId` must match
`[A-Za-z0-9-]{1,64}`.

Each scope is a `workflows/` directory with one entry point, exactly
`main.py` directly inside it. The scopes are `.cairn/workflows` in the project,
`cairn/workflows` under the platform config directory, then the bundled
`workflows` directory (app resources in release builds,
`sdk/python/workflows` in development). Nothing is selected by filename.

`workflow_status` returns
`{ active, sources, needsChoice, choice, choiceOptions, activeVia }`, where
`sources` contains `{ source, folder, status, entry?, message?, warnings,
trusted }`, `choiceOptions` is `{ bundled: true, global: boolean }`, and
`activeVia` is `project`, `chosen`, `fallback`, or `null`. `active` is the
effective runnable scope or `null` if a choice is required or resolution has a
hard error. `choice` is the usable remembered scope for a project `no-entry`
folder; it is `null` when the saved choice is ignored or unusable.

Statuses are `empty` (missing directory or only `__pycache__`), `ok`,
`no-entry` (has entries but no exact-case `main.py`), and `reserved-name`
(a root `cairn.py` file or `cairn` directory, case-insensitive). An active
scope that is not `ok` fails `run_start` with `Validation`. The messages are
`no main.py in <display folder>` and
`<conflicting name> would shadow the Cairn SDK; rename it`. Display folders
are `.cairn/workflows`, `<config dir>/cairn/workflows`, and
`<app>/workflows`; they never expose an absolute path or username. `entry` is
the display folder plus `/main.py`. Warnings identify top-level files and
directories named after common standard-library modules; they do not block
execution.
`trusted` is the project folder's 7b trust state, `true` for nonempty global
and bundled scopes, and `null` for an empty scope.

Resolution is intentionally different for the two non-runnable project states:

1. Project `ok` always runs, and any remembered choice is ignored.
2. Project `reserved-name` is a hard `Validation` error; no choice is offered.
3. Project `no-entry` uses a remembered `bundled` choice, or a remembered
   `global` choice only while global status is `ok`. Otherwise `needsChoice` is
   true and `run_start` returns `WorkflowChoiceRequired` and asks the user to
   select a workflow source.
   A selected global or bundled workflow does not require project trust.
4. Project `empty` falls back to nonempty global, then bundled, without asking.
   A global `no-entry` or `reserved-name` is a hard `Validation` error rather
   than a fall-through.

`workflow_choose` accepts only `bundled` or `global`; global must currently be
`ok`, otherwise it returns `Validation: no usable global workflow`. Choices are
stored by canonical project root in app-data `workflow-choice.json` as
`{ "<canonical root>": { "scope": "...", "chosenAt": <ms> } }` and replaced
atomically. Missing or corrupt choice data is logged and treated as no choice.
`workflow_choice_clear` clears only the current project's entry. `run_start`
clears a saved choice when project status has become `ok`; successful project
workflow creation also clears it.

`workflow_template_get` accepts only an id returned by `workflow_templates`.
Ids containing path separators or other non-template characters are rejected;
unknown ids return `NotFound`. Template text is read from the same SDK template
directory used by the listing in both development and release builds.

The dialog flow is limited to project `no-entry`: present the options indicated
by `choiceOptions`, let the user choose bundled or usable global, and remember
that choice for this project. If the user instead creates a project workflow,
the new `main.py` takes precedence and the remembered choice is cleared. Empty
projects never show this dialog.

The frontend exposes `needsChoice`, `choice`, `choiceOptions`, and `activeVia`
signals on `WorkflowService`. When `RunService.run(taskId)` returns
`{ kind: 'choice-required' }`, the caller opens the choice dialog without an
error notice. The dialog calls `chooseAndRun(taskId, scope)`, which persists
the selection, refreshes workflow status, and starts the run only after the
choice succeeds. The run-button disabled-reason check does not block on
`needsChoice`; the dialog owns that interaction. `choose(scope)` and
`clearChoice()` refresh status after the Rust command completes.

`run_start` launches `uv run --script <active folder>/main.py` with the project
root as cwd. The run record's `workflow` and `source` fields both hold the scope
label (`project`, `global`, or `bundled`). The UI-facing run command has no
workflow-name argument.

`workflow_templates` reads `sdk/python/templates/*.py`; each template's `id`,
`title`, and `description` come from its filename and `# title:` /
`# description:` comments in the first ten lines. The built-in templates are
`blank`, `steps`, and `edit-file`. `workflow_create` accepts scope `project` or
`global` and either one of those ids or `bundled` (a recursive copy of the
bundled workflow directory). Project creation is allowed in `empty` or
`no-entry` folders: ordinary templates create only `main.py` and preserve
existing files; a case-insensitive `Main.py`-style entry must be renamed, and
bundled copies are refused if any destination path collides case-insensitively.
It never overwrites. Global creation behavior is unchanged. Project creation
first ensures `.cairn`, and global creation creates its directories.
`entryPath` is the real
absolute path to open in the editor; unlike status display strings, it is not
redacted.

Workflow scripts must use absolute imports for local helpers, for example
`import prompts` or `from helpers import x`; do not use `from . import helper`.
`uv run --script` adds the entry file's directory to imports, and namespace
subfolders work without `__init__.py`. Never name a file `cairn.py` or a
directory `cairn`, because it shadows the SDK on `PYTHONPATH`. Avoid
standard-library module names for top-level files and folders.

### Bundled default workflow

The bundled `sdk/python/workflows/main.py` processes the current task, or each
pending subtask as a resumable step. It reads linked notes, seeds context from
the task and note file anchors plus paths mentioned in their text, and makes
one optional exploration request using a root/one-level project listing to
choose up to six additional files. It then asks the configured default model
for one JSON edit, a reason it cannot proceed, or (only for a task without
subtasks) a proposed split. Changes are recorded with `patch.propose`; the
workflow never writes project files itself. Split proposals use `notify` and
require acceptance before the task is run again. A failed step stops the
workflow so a retry resumes from that subtask.

The workflow sends task and subtask text, linked-note text, the project listing
and selected relative file names, and the bounded contents of selected project
files to the configured model provider. In particular, task text and project
files named above are sent to the configured model provider. The SDK rejects
secret paths; the workflow also skips secret and generated paths and does not
include file contents in run-log output. The root/one-level listing is capped
at 200 entries and exploration selects at most six extra files. File text is
limited to about three characters per token and at most 60% of the default
model's remaining context after reserving output tokens; a missing
`contextLimit` is treated as 16,000 tokens. Truncation is identified in the
prompt, and replace edits are disallowed on truncated files. A
`ContextTooLarge` response causes one retry with half the file-text budget;
invalid model JSON and patch-validation errors may each be repaired up to two
times.

`WorkflowService.create('project', 'bundled')` copies the bundled workflow
folder into the project; the workflow settings screen is not implemented.
Afterward, edit `main.py` or helper files in the workspace editor. Keep helpers
beside the entry point and use absolute sibling imports. Project workflows take
precedence over the bundled copy and require project trust.

When a run starts, Rust reads the user's app-data `settings.json` once and snapshots
the model registry/default into that run. Missing or malformed settings are
logged and give the run an empty registry; later settings edits do not affect
an active run.

Project trust is per canonical project root, not per run. Project workflows
require approval of the SHA-256 hash of the entire `.cairn/workflows` folder.
The hash covers every file and subfolder helper, sorted by relative path, with
each relative path and its content; symlinks are not followed and their link
target strings are hashed. `__pycache__` directories and `*.pyc` files are
excluded. Adding, removing, or changing any included file invalidates approval
for every project workflow.

The trust store is `workflow-trust.json` in Tauri app data, never in the
project. Each canonical-root entry stores `folderHash`, per-relative-path
SHA-256 values, and `approvedAt`. Older entries containing only a hash string
remain readable; they establish trust when the current folder hash matches but
cannot produce a per-file change list. The project’s settings or other files
cannot grant trust.

`workspace_trust_status` returns `hasWorkflows` (true only when exact-case
`main.py` exists in the project folder), `trusted`, `folderHash`,
optional `approvedHash`, current `files` (`path`, `size`, `sha256`), and
`changes` relative to the stored file inventory (`added`, `modified`, or
`removed`). Changes are empty if there is no approval or the approval predates
file inventories. `workspace_trust(hash)` accepts only the current folder hash
and stores that hash plus the current file list. `workspace_trust_revoke()`
removes the approval. Both require an open project. Global and bundled
workflows are trusted without approval. Before changing the task status and
again immediately before spawning, Rust verifies the project workflow hash.
An untrusted project workflow returns `TrustRequired` with the Settings review
message.

### Angular workflow trust state

The Angular workflow service exposes `status`, `active`, `activeIssue`,
`warnings`, and `templates`. `active` is the active source object or `null`;
`activeIssue` is the active source message when its status is not `ok`; and
`warnings` contains the active source warnings.

After a project opens, the service refreshes workflow status and templates.
The existing 500 ms filesystem debounce is shared by workflow and trust
refreshes: a batch containing a path under `.cairn/workflows/` refreshes both
once per window, while unrelated paths do nothing.

**Workflow settings UI:** not implemented. `WorkflowService` exposes scope
status, templates, and creation; there is no workflow-management feature screen.
The shared no-entry dialog is incomplete: only the project-creation path is
connected; global and bundled choices do not yet persist and start a run.

**Run button:** reasons are project closed, task not ready, another run
active, dependency incomplete, no active workflow, active source issue, or
project workflow unreviewed/changed. Rust selects the active source;
`runStart` receives only the task id and expected revision.

The Angular `WorkflowService` derives a trust state from the Rust status:

| State | Fields |
|---|---|
| `unknown` | No trust status has been loaded |
| `none` | `hasWorkflows` is false |
| `trusted` | Workflows exist and `trusted` is true |
| `unreviewed` | Workflows exist, are not trusted, and `approvedHash` is absent |
| `changed` | Workflows exist, are not trusted, and `approvedHash` is present |

The state checks use this order: a missing status is `unknown`; no workflows is
`none`; a Rust `trusted` result is `trusted`; no `approvedHash` is
`unreviewed`; otherwise it is `changed`. This last row includes legacy approvals
with an `approvedHash` and no per-file change inventory: it is `changed`, and
`detailsAvailable` is false until Rust reports changes.

`approvedHash` is the folder hash stored at the time of approval. It is not an
approval entry point and is never passed back by Angular to approve workflows.
The Settings card receives the displayed `folderHash` and calls `approve(hash)`
with that exact value. Approval happens only for the current hash accepted by
Rust. If files change while the review is open, Rust returns `Validation`;
Angular refreshes the trust status and reports `changed-while-reviewing` instead
of approving stale files.

The service computes change counts and exposes the Settings review as
`{ state, files, changes }`. `files` is the current Rust inventory, while
`changes` is the Rust change list and includes removed paths even when they are
no longer in `files`. `detailsAvailable` is true only when at least one change
is present.

Trust notices use these recipes:

- **Notice at open:** refresh trust after opening the project. Emit a notice for
  `unreviewed` or `changed` once per `folderHash` in the current workspace
  session. `trusted` and `none` do not emit, and workspace changes clear the
  announced hashes.
- **Settings review:** show the current inventory and change summary. Approve
  only the hash currently displayed after the user reviews it.
- **Files changed during review:** Rust rejects a stale approval with
  `Validation`; refresh trust, show the new state and changes, and require a
  separate approval.

Global and bundled workflows do not require project approval and are not
affected by these project trust states. Project scripts run with the user's
operating-system permissions; approval grants trust for the workflow folder and
is **not a sandbox**.

Approval is not a sandbox: **approved scripts run with your permissions**.
Users should inspect the current file inventory and all reported changes in
Settings before approving.

### RPC methods

The first SDK call automatically performs the `hello` handshake. API version
1 is the only supported version.

| Method | Parameters | Result |
|---|---|---|
| `hello` | `{ "apiVersion": 1 }` | `{ "apiVersion": 1 }` |
| `models.list` | `{}` | `{ "id", "contextLimit"?, "default" }[]`; never includes endpoints or key references |
| `models.complete` | `{ "model"?, "messages", "maxTokens"?, "temperature"?, "stop"?, "json"? }` | `{ "text", "finishReason"?, "usage": { "promptTokens"?, "completionTokens"? }, "model", "ms" }` |
| `run.context` | `{}` | `{ "runId", "taskId", "workflow", "attempt", "resume", "previous"? }` |
| `tasks.get` | `{ "id": string }` | one camelCase task record |
| `tasks.list` | `{}` | array of camelCase task records |
| `tasks.propose` | `NewTask` fields (camelCase), optional `presentation` | `{ "proposalId": string }` |
| `tasks.propose_batch` | `{ "items", "sourceTaskId"?, "presentation"? }` | `{ "proposalId": string }` |
| `tasks.propose_subtasks` | `{ "taskId", "items", "presentation"? }` | `{ "proposalId": string }` |
| `proposals.list` | `{}` | `{ "id", "title", "status" }[]` |
| `notes.get` | `{ "id": string }` | one camelCase note record |
| `notes.for_task` | `{ "taskId": string }` | linked note records; missing linked ids are skipped |
| `run.finish` | `{ "outcome": "needs_review" \| "failed", "summary"?: string, "reason"?: string }` | `null` |
| `step.start` | `{ "subtaskId": string }` | `null` |
| `step.finish` | `{ "subtaskId": string, "outcome": "needs_review" \| "failed", "summary"?: string, "reason"?: string }` | `null` |
| `files.read` | `{ "path": string, "maxBytes"?: number }` | `{ "path", "text", "truncated", "bytes", "sha256" }` |
| `files.list` | `{ "path"?: string, "maxEntries"?: number }` | `{ "name", "kind": "file" \| "dir", "size"? }[]` |
| `patch.propose` | `{ "title": string, "summary"?: string, "edits": [{ "op": "replace", "path", "search", "replace"} \| {"op":"write","path","content"}] }` | `{ "patchId", "files": [{"path","op"}] }` |

`models.complete` accepts at most 100 messages and 1,000,000 message-content
characters. Roles are `system`, `user`, or `assistant`. If `model` is omitted,
the snapshotted default is used; without one, the call returns `Validation`.
When the selected model has a context limit, Rust estimates input tokens as
characters divided by three and adds `maxTokens`; exceeding the limit returns
`ContextTooLarge` with both values. Calls within a run are serialized.

The provider is OpenAI-compatible and non-streaming. Rust posts to
`{baseUrl}/chat/completions`; the API key is loaded from the OS keychain only
when the registry entry has `apiKeyRef`. Entries without an endpoint return
`ModelUnavailable` with guidance to register the server as an API model. The
IDE does not spawn a model process.

`run.context.attempt` is the current run id's 1-based position in the task's
`runs` history. It is `1` when the history is absent or does not contain that
id. Every retry creates a new run and appends a new id.

`run.context.resume` contains `total`, `done`, and `pending`. `done` counts
subtasks in `needs_review` or `completed`; `pending` contains every other
subtask, preserving task order, as `{ "id", "title", "status" }`. A task with
no subtasks returns zero counts and an empty pending list. When a previous run
id exists in the task's run history, `previous` contains that run's `runId`,
`outcome`, and optional `reason` and `summary`. Missing or unreadable previous
run metadata omits `previous`.

`step.start` accepts a subtask belonging to the current run's task. Only one
step may be open at a time. Subtasks in `ready`, `failed`, or `needs_review`
may start; completed subtasks cannot be restarted. Each run stores up to 200
steps. `step.finish` must match the open step; its outcome is `needs_review`
or `failed` (scripts cannot complete subtasks), `summary` is limited to 2000
characters, and `reason` to 500. Both methods update the subtask through the
task service and emit one `task:updated` event plus a `run:step` event.

For example, the request and response for a task read are each one line:

```json
{"jsonrpc":"2.0","id":1,"method":"tasks.get","params":{"id":"task-123"}}
{"jsonrpc":"2.0","id":1,"result":{"id":"task-123","title":"Example","status":"ready","createdAt":1,"schemaVersion":1,"rev":1}}
```

The host exposes only the methods in the table. The `step.start` and
`step.finish` methods are the only direct subtask-progress operations exposed
to scripts; they cannot complete a subtask or edit its title or description.
Proposal-related methods, permissions, and validation are documented in
[proposals](./proposals.md). `run.finish` cannot complete a task; any outcome
other than `needs_review` or `failed` returns `Forbidden`.

`files.read` is project-confined and read-only. The default limit is 200,000
bytes and the ceiling is 1,000,000 bytes; files larger than 5 MB or containing
a NUL byte in the first 8 KB return `Validation`. `files.list` is directory-only,
sorted, capped at 500 entries (default 200), and omits denied secret names.
Project paths never expose `.git` or `.cairn`, secret files, or paths outside the
project root. Script traces record file paths and byte counts but never file text.
Scripts cannot apply or discard patches.

### Errors

Standard JSON-RPC errors use `-32700` for parse errors, `-32600` for invalid
requests (including overlong lines), `-32601` for unknown methods, and `-32602`
for invalid parameters. Service errors use `-32000` and include structured
data:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Stale revision","data":{"code":"StaleRev","message":"Stale revision"}}}
```

The complete Rust service-code set is `NotFound`, `StaleRev`,
`InvalidTransition`, `Forbidden`, `Validation`, `Io`, `Corrupt`, `NoProject`,
`RunActive`, `TrustRequired`, `WorkflowChoiceRequired`, `RuntimeUnavailable`,
`ModelUnavailable`, `ModelError`, `ContextTooLarge`, and `PatchConflict`.
Patch conflicts list the conflicting workspace-relative paths.
Network refusal, DNS, and timeout errors name only the endpoint host and port.
HTTP errors include the status and at most 300 body characters after key-like
text is redacted. A `hello` version mismatch returns an invalid-parameters
error, then terminates the child and fails the run with reason
`SDK API version mismatch`.

The Python SDK raises `CairnError(code, message)` for error responses and exits
with status 1 if stdin reaches EOF.

### Events

Events are emitted through the application's event sink:

| Event | Payload |
|---|---|
| `run:started` | `{ "runId", "taskId", "workflow" }` |
| `run:log` | `{ "runId", "lines": string[] }` |
| `run:finished` | `{ "runId", "taskId", "outcome": "needs_review" \| "failed", "reason"?: string }` |
| `run:step` | `{ "runId", "taskId", "subtaskId", "status": "running" \| "needs_review" \| "failed", "summary"?: string, "reason"?: string }` |
| `run:deleted` | `{ "runId" }` |

`run:log` batches are emitted no more often than five times per second.

### Environment and files

The child is launched as `uv run --script <script>` with the project root as
its working directory and stdin, stdout, and stderr piped. The host sets:

| Variable | Value |
|---|---|
| `PYTHONPATH` | SDK directory (`sdk/python`) |
| `CAIRN_RUN_ID` | current run id |
| `CAIRN_API_VERSION` | `1` |

On Windows, the launcher and its descendants are placed in a Job Object that
kills the entire job when closed. On Unix, the launcher starts in a new
process group and termination signals the group. Cancellation, timeout,
project close/switch, version mismatch, and application shutdown stop the
whole process tree.

Run data is stored under `.cairn/runs/<runId>/`:

| File | Contents |
|---|---|
| `run.json` | run id, task id, workflow, source, hash (project workflows folder hash; global workflow file hash), start/end timestamps, outcome, reason, summary, and ordered `steps` |
| `run.log` | workflow stderr and redirected `print()` output, capped at 5 MB |
| `trace.jsonl` | per-RPC timing/success/error; model calls also include model id and token usage; capped at 5 MB |
| `calls/<n>.json` | model messages and response text, capped at 1 MB per file and 20 MB per run; no headers or keys |

### Exit and status rules

After trust and revision checks, the task moves from `ready` to `running`.
`run.finish` stores a requested outcome. The host waits up to five seconds for
the child to exit, then kills the remaining process tree; the requested
`needs_review` or `failed` outcome is retained regardless of the process exit
code. Exit code 0 without `run.finish` sets `needs_review`. A nonzero exit,
cancellation, 30-minute timeout, project close/switch, SDK API version
mismatch, or spawn failure sets `failed` with a reason. `uv` startup failures
return `RuntimeUnavailable`.

Finalization reads the task's current revision and changes its status only if
it is still `running`; a status changed by the user during execution is not
overwritten. `needs_review` is applied as the script actor and `failed` as the
system actor. Before finalizing the task, any subtask still `running` is changed
to `failed` as the system actor, and an open step is closed as `failed` with
reason `step not finished`. The application kills the active child on shutdown.

### Recovery

When a project opens, any task or subtask still marked `running` is changed to
`failed` through the task service. The task `load`/`reconcile` pass also sweeps
orphan run folders under `.cairn/runs/` whose `taskId` points to a missing task,
skipping `runs/proposals/`, taskless runs, active runs, and unreadable/corrupt
`run.json` files. Each unfinished `.cairn/runs/*/run.json`
record is ended as `failed` with reason `interrupted (app closed during run)`;
open steps are closed as `failed` with reason `interrupted`. Malformed run
records are skipped and logged; recovery errors do not prevent the project
from opening. Run finalization retries a task status update once after
`StaleRev`, and only if a re-read shows the task is still `running`.

### Angular services

### Conventions and types

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

### API wrapper

#### `WorkApiService`

Typed command boundary; it has no signals and consumes no events. Its workflow
and run methods use the current Rust command contract listed here.

| Method | Resolves to | Command errors |
|---|---|---|
| `workflowStatus()` | `WorkflowStatus` | `NoProject`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `workflowTemplates()` | `{ id, title, description }[]` | `RuntimeUnavailable`, `Io`, `Corrupt` |
| `workflowTemplateGet(id: string)` | template source text | `Validation`, `NotFound`, `RuntimeUnavailable`, `Io`, `Corrupt` |
| `workflowCreate(scope, template)` | `{ source, entry, entryPath }` | `NoProject`, `Validation`, `RuntimeUnavailable`, `Io`, `Corrupt` |
| `workspaceTrustStatus()` | `WorkflowTrustStatus` | `NoProject`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `workspaceTrust(hash: string)` | `void` | `NoProject`, `Validation`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `workspaceTrustRevoke()` | `void` | `NoProject`, `Io`, `Corrupt`, `RuntimeUnavailable` |
| `runStart(taskId: string, expectedRev: number)` | `RunRecord` | `NoProject`, `NotFound`, `StaleRev`, `InvalidTransition`, `RunActive`, `TrustRequired`, `RuntimeUnavailable`, `Validation`, `Io`, `Corrupt` |
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

#### `RunStore`

Purpose: current/last-run snapshot, history, and bounded in-memory log cache.

| API | Behavior |
|---|---|
| `current` | `Signal<RunState \| null>`; current/last run, potentially partial |
| `history` | `Signal<RunRecord[]>` loaded by `RunService.loadHistory()` |
| `record(runId)` | `Signal<RunRecord \| undefined>` for one full cached record |
| `logLines(runId)` | Cached lines for one run |
| `started(event)` / `append(event)` / `finished(event)` / `remove(runId)` | Apply run events; retain at most 500 log lines; `remove` clears cached state for a deleted run |
| `setCurrent(run)` / `setHistory(records)` / `setRecord(record)` / `setLog(runId, lines)` | Apply command results |
| `refresh()` | Coalesced `run_get()`; caches the full record and fetches the active run's log |
| `clear()` | Clear current run, history, and logs on workspace change |

The Rust lifecycle events omit some fields present on `RunRecord`: `run:started`
has no `source`, `scriptHash`, or `startedAt`; `run:finished` has no `endedAt` or `summary`. Its event-derived `RunState` stays
partial until `refresh()` replaces it with the full record; no fields are
synthesized. Live lines may overlap lines fetched during refresh.

#### `WorkflowService`

Scope status, templates, and project-level trust status.

| API | Behavior |
|---|---|
| `status` | `Signal<WorkflowStatus \| null>` with active scope and all scope statuses |
| `templates` | `Signal<WorkflowTemplate[]>` parsed from template comments |
| `needsChoice` | Boolean derived from `status.needsChoice` |
| `trust` | `Signal<WorkflowTrustStatus \| null>` with current files and approval changes |
| `trustState` / `trustSummary` / `review` | Derived trust state, change counts, and review inventory |
| `needsTrustReview` | True when the active project scope is not trusted |
| `refresh()` / `refreshTrust()` | Refresh scope status or project trust status |
| `choose(scope)` / `clearChoice()` | Persist or clear the current project's remembered source and refresh status |
| `create(scope, template)` | Create a template or recursively copy the bundled scope; never overwrite |
| `projectOpened()` | Refresh project trust status |
| `approve()` / `revoke()` | Approve the latest displayed folder hash or remove the project approval |
| `filesChanged(paths)` | Debounce trust refreshes by 500 ms for paths in `.cairn/workflows` |
| `clear()` | Reset workspace-scoped state and pending refresh timers |

Command errors are reported through `handleApiError`. The workspace watcher
passes filesystem batches to the service; unrelated paths do not refresh trust.

#### `RunService`

Start/cancel workflows and expose live run state.

| API | Behavior |
|---|---|
| `current` | `Signal<RunState \| null>` from `RunStore` |
| `isRunning` | `Signal<boolean>`; run is unfinished and its cached task is running when present |
| `logLines(runId)` | `Signal<string[]>` from the bounded run buffer |
| `runDisabledReason(task)` / `canRun(task)` | Explain or check project, task, run, dependency, and active-scope eligibility |
| `run(taskId)` | Call `run_start`; return `started`, `{ kind: 'trust-required' }`, or `{ kind: 'choice-required' }` without toasting |
| `chooseAndRun(taskId, scope)` | Persist a selected source, then run only if the choice succeeds |
| `cancel()` | Call `run_cancel()` |
| `refresh()` | Refresh `run_get()` and the active run's log |
| `loadHistory(limit)` / `loadLog(runId, maxLines)` | Call `run_list` / `run_log` and cache results |
| `attemptCount(task)` / `lastRunId(task)` | Read task history locally; no command calls |
| `loadRunsFor(task, limit = 5)` | Load the newest task attempts, fetching only cache misses and skipping deleted runs |
| `clear()` | Clear run state on workspace change |

Errors other than the handled `TrustRequired` path are reported through
`handleApiError`; `NoProject` is suppressed by that helper. The service consumes
`run:started`, `run:log`, and `run:finished` through `WorkSyncService`.

#### `WorkSyncService`

App-wide subscription and workspace lifecycle coordinator, instantiated by the
app initializer.

| Lifecycle | Behavior |
|---|---|
| Subscribe | Listen once to task, note, project, run, proposal, and patch events |
| Workspace change | Clear caches, then close or open the project |
| Project open | Refresh tasks, notes, proposals, patches, run, workflows, and trust status |
| `project:reloaded` | Refresh tasks, notes, and proposals |
| `fs:changed` | Refresh trust status after a debounced workflow-path batch |

### Error table

| Code | Meaning | Existing service behavior |
|---|---|---|
| `StaleRev` | Record changed since the caller read it | Task/note facades refetch the record; proposal accept/reject refresh the list. All report “This changed elsewhere; try again.” and do not retry. |
| `NotFound` | Referenced item is absent | Reported; proposal accept/reject refresh the list before calling only when the proposal is absent from cache. |
| `InvalidTransition` | Requested status/decision transition is invalid | Reported; refresh the UI from event-fed state. |
| `Forbidden` | Caller is not permitted to make the transition | Reported as an error. |
| `Validation` | Input or edited payload failed validation | Reported with Rust's message. |
| `NoProject` | No project is open | `handleApiError` suppresses the toast. |
| `RunActive` | Another workflow is active | Reported; `isRunning` allows the UI to disable run actions. |
| `TrustRequired` | Project workflow hash is not approved | `RunService.run` returns `{ kind: 'trust-required' }` and points the UI to Settings; it does not inspect or approve automatically. |
| `WorkflowChoiceRequired` | A project workflow folder has files but no entry point and has no usable remembered choice | `RunService.run` returns `{ kind: 'choice-required' }`; the no-entry choice flow selects a source before retrying. |
| `RuntimeUnavailable` | Workflow launcher/SDK is unavailable | Reported with Rust's message. |
| `ModelUnavailable` | The configured endpoint cannot be reached, or the run was cancelled during a call | Reported with the host and port or cancellation message. |
| `ModelError` | The model endpoint returned an HTTP or response error | Reported with a redacted, bounded message. |
| `ContextTooLarge` | Estimated input and output exceed the selected model context limit | Reported with the estimated size and limit. |
| `PatchConflict` | A patch base file changed before apply | Returned to the patch-review caller; the workspace is not changed. |
| `Io`, `Corrupt` | Disk or record problem | Reported with Rust's message; list-level storage errors remain in store `errors`. |
| `BadArgs` | Tauri rejected a plain-string/bad-shape argument | Normalized by `WorkApiService`; reported as an error. |

`handleApiError` suppresses `NoProject`; it handles stale refreshes when given a
refresh callback. `RunService` is the sole special case for `TrustRequired`.
No service retries a rejected mutation silently.

### UI integration

The Angular command wrappers and selectors consume the current scope-based
workflow contract. The following interaction recipes describe the integration:

#### Run button and its states

1. Read the task from `TaskService` and render the actions returned by
   `taskService.availableActions(task)`.
2. Derive a run-in-progress state from `runService.isRunning()`; disabled
   actions include a `reason`.
3. On the run action call `await taskService.perform(task, 'run')`. Rust
   resolves the active scope from project state.
4. On `{ kind: 'started', run }`, show the active state from
   `runService.current()` / `runService.isRunning()`. The event-fed task status
   also changes to `running`.
5. On `{ kind: 'trust-required' }`, direct the user to the Settings review flow.
   Other handled errors appear through `NoticeManager`.
6. On `run:finished`, the event-derived state is interim; `RunStore.refresh()`
   fetches the full run record. `isRunning()` becomes false and the task event
   carries the task's resulting status.

#### Trust and choice UI currently

The app shell shows an untrusted-workflow banner when the project workflow
state is `unreviewed` or `changed`; its Manage action opens `TrustSetting`.
Project open refreshes trust state but does not emit a trust-review observable.
The app shell opens the shared no-entry dialog when Rust reports
`needsChoice`. The dialog's global and bundled actions are not connected to
`WorkflowService.choose`/`RunService.chooseAndRun` yet.

#### Settings Agents workflow management

The Agents settings section shows the project workflow status, entry, warnings,
and trust state. It can create a project workflow from a listed template or
copy the bundled workflow, then opens the returned entry path in the editor.
When the project is `no-entry`, the bundled source can be selected only if
`choiceOptions.bundled` permits it; a remembered choice can be cleared. A
project workflow takes precedence once its status is `ok`. Global workflow
management is disabled and labeled “Coming soon”. Template source is fetched
only when expanded, cached by template id in a signal, and rendered as text;
copy errors are shown beside the template.

#### Settings review and approval

1. Read `workflowService.trust()` and render its `files` and `changes` before
   offering approval. A change is relative to the prior approved inventory;
   show added, modified, and removed paths clearly.
2. Warn plainly: **approved scripts run with your permissions**. Trust is not
   a sandbox and applies to all project workflows and helpers as one folder.
3. After the user reviews the current inventory, call
   `await workflowService.approve()`. It submits the displayed `folderHash`;
   Rust rejects it with `Validation` if the folder changed in the meantime.
4. On approval, the service refreshes status. To withdraw approval, call
   `await workflowService.revoke()`.
5. A changed helper is included in the folder hash, so it requires a new
   review just like a changed workflow script.

#### Failed run start

1. If `runService.run(task.id)` returns
   `{ kind: 'trust-required' }`, point the user to Settings; the result carries
   no script inspection data and the service does not trust or retry.
2. Settings presents the latest `trust` status. If it is stale, refresh and
   have the user review the new file list and changes before approval.
3. After approval, the user explicitly retries the run. `run_start` checks
   trust before the task status change and Rust hashes again before spawn.

#### Live log view

1. Obtain `const lines = runService.logLines(runId)` and render `lines()` as
   plain text.
2. For a known run after reload, call
   `await runService.loadLog(runId, 500)` once to refill the signal.
3. Live `run:log` events append to that run's buffer; it retains at most 500
   newest lines. A refresh may briefly duplicate overlapping lines.

#### Progress per subtask during a run

1. Read `runStore.stepStatus(runId)()` for the live latest event state keyed by
   `subtaskId`; each value contains `status` plus optional `summary` and
   `reason`.
2. Read `taskService.subtaskProgress(task)` for aggregate counts and
   `percent`, or read the full `RunRecord.steps` array after `run:finished`
   refresh and `run_get`.
3. The step event map is workspace-scoped and is cleared on workspace change.

#### Resume after a failure

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

#### Review steps and complete

1. Read live step statuses from `runStore.stepStatus(runId)()`, and use the
   refreshed `RunRecord.steps` for the ordered final review.
2. Call the normal task action `perform(task, 'complete')` once after review.
3. Completing a task completes all of its `needs_review` subtasks in Rust as
   part of the task write. The UI must not call subtask completion once per
   subtask.

#### Task run history

Every retry creates a new run and appends its id to the task's read-only
`runs` history. Use `runService.attemptCount(task)` for the number of recorded
attempts and `runService.lastRunId(task)` for the newest id. To list recent
attempts, call `await runService.loadRunsFor(task, 5)`; results are newest
first, only the newest requested ids are considered, and ids already in
`RunStore` are not fetched again. Missing/deleted run folders are skipped.
To open an older attempt's log, call
`await runService.loadLog(record.runId, 500)` and read
`runService.logLines(record.runId)`.

### Known limits

- Run events omit record fields; the current run remains partial until the
  post-finish refresh obtains the full record.
- Live log events can overlap log lines fetched by a refresh.

### Python SDK usage

The stdlib-only SDK is imported from `cairn`. It performs the `hello` handshake on the first RPC call, keeps JSON-RPC on stdout, and redirects workflow `print()` output to stderr.

| Namespace | Methods |
|---|---|
| `models` | `list()`, `complete(messages, model=None, max_tokens=None, temperature=None, stop=None, json=False)` |
| `tasks` | `get(task_id)`, `list()`, `propose(...)`, `propose_batch(items, source_task_id=None, presentation="notify")`, `propose_subtasks(task_id, items, presentation="notify")` |
| `proposals` | `list()` |
| `notes` | `get(note_id)`, `for_task(task_id)` |
| `run` | `context()`, `pending_steps()`, `step_start(subtask_id)`, `step_finish(subtask_id, outcome, summary=None, reason=None)`, `step(subtask_id)`, `finish(outcome, summary=None, reason=None)` |
| `files` | `read(path, max_bytes=None)`, `list(path="")` |
| `patch` | `propose(title, edits, summary=None)` |

Examples below are the SDK workflows shipped in `sdk/python/examples/`.

`models.complete()` returns a response object with `.text`, `.finish_reason`,
and `.usage` (a dictionary containing optional prompt/completion token counts).
See [ask.py](../../sdk/python/examples/ask.py) for a minimal request.

#### Read task and notes, then finish

```python
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

import sys

from cairn import notes, run, tasks

context = run.context()
task = tasks.get(context["taskId"])
task_notes = notes.for_task(task["id"])
summary = f"Read task '{task['title']}' and {len(task_notes)} linked note(s)."
print(summary, file=sys.stderr)
run.finish("needs_review", summary=summary)
```

#### Propose a follow-up task

```python
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from cairn import run, tasks

context = run.context()
task = tasks.get(context["taskId"])
proposal_id = tasks.propose(
    title=f"Follow up: {task['title']}",
    description=f"Continue work related to {task['title']}.",
)
print(f"Proposed follow-up task {proposal_id}")
```

#### Propose a dependent task batch

```python
# ///
# requires-python = ">=3.10"
# dependencies = []
# ///

from cairn import run, tasks

context = run.context()
current = tasks.get(context["taskId"])
proposal_id = tasks.propose_batch(
    source_task_id=current["id"],
    presentation="notify",
    items=[
        {"key": "first", "title": "First step"},
        {
            "key": "second",
            "title": "Second step",
            "dependsOnKey": "first",
        },
        {
            "key": "third",
            "title": "Third step",
            "dependsOnKey": "second",
        },
    ],
)
print(f"Proposed a three-task split for {current['title']}: {proposal_id}")
```

#### Process resumable steps

```python
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from cairn import run

summaries = []
for pending_step in run.pending_steps():
    try:
        with run.step(pending_step["id"]) as step:
            title = pending_step["title"]
            if title.startswith("FAIL: "):
                raise RuntimeError(f"Step failed: {title}")
            step.summary = f"Finished {title}"
            summaries.append(step.summary)
    except Exception as error:
        reason = str(error)[:500]
        run.finish("failed", reason=reason)
        # Stopping at the first failure makes resume continue from that step.
        break
else:
    run.finish("needs_review", summary="; ".join(summaries))
```
