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
| `run_start` | `taskId`, `expectedRev`, optional `workflow` | run record |
| `run_cancel` | — | `null` |
| `run_get` | optional `runId` | with an id, that run record; without one, active run record, last run record, or `null` |
| `run_list` | `limit` | run records, newest first |
| `run_log` | `runId`, `maxLines` | `string[]` |
| `workflow_list` | — | `{ name, source, trusted }[]` |
| `workflow_inspect` | `name` | `{ name, source, path, hash, trusted, files }` |
| `workflow_trust` | `name`, `hash` | `null` |

`run_list` reads `.cairn/runs/*/run.json`, skips and logs unreadable or
malformed records, and clamps `limit` to 1–50. Active records omit `endedAt`.
When `run_get` receives `runId`, it returns the active in-memory record if that
id matches; otherwise it reads `.cairn/runs/<runId>/run.json`. An unknown id
returns `NotFound`; malformed ids return `Validation`.
`run_log` returns the last `maxLines` lines from a run's log, clamped to
1–2000; a missing log returns an empty array. `runId` must match
`[A-Za-z0-9-]{1,64}`.

`run_start` requires an open project, no active run, a resolvable trusted
workflow, and a startable task with the supplied revision. If `workflow` is
omitted, the name `default` is used. Workflows are resolved by name (without
the `.py` extension) from `.cairn/workflows/<name>.py` in the project first,
then from the global `cairn/workflows/<name>.py` directory under the platform
config directory. Names must match `[A-Za-z0-9_-]{1,64}`.

Project workflows require approval of the SHA-256 hash of the entire
`.cairn/workflows` folder. The hash includes every regular file, sorted by
relative path, with each relative path and its content; `__pycache__`
directories and `*.pyc` files are excluded. Adding a file or changing any
workflow or helper invalidates approval for every project workflow. The trust
store is `workflow-trust.json` in the platform app data directory, never in
the project. Its keys are `<canonical project root>|.cairn/workflows`; its
values are folder SHA-256 hashes. `workflow_trust` accepts a hash only when it
matches the current folder hash. `TrustRequired` reports the folder path and
current hash. Global workflows are trusted automatically.
`workflow_inspect` returns the resolved script path and hash, plus file paths
and sizes. For project workflows, the inventory is exactly the sorted set of
files covered by the folder hash, excluding `__pycache__` directories and
`*.pyc`; for global workflows, it contains only the workflow script.

### RPC methods

The first SDK call automatically performs the `hello` handshake. API version
1 is the only supported version.

| Method | Parameters | Result |
|---|---|---|
| `hello` | `{ "apiVersion": 1 }` | `{ "apiVersion": 1 }` |
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

### Errors

Standard JSON-RPC errors use `-32700` for parse errors, `-32600` for invalid
requests (including overlong lines), `-32601` for unknown methods, and `-32602`
for invalid parameters. Service errors use `-32000` and include structured
data:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Stale revision","data":{"code":"StaleRev","message":"Stale revision"}}}
```

Service codes include `NotFound`, `StaleRev`, `InvalidTransition`, `Forbidden`,
`Validation`, `RunActive`, `TrustRequired`, `RuntimeUnavailable`, and
`WorkflowNotFound`. A `hello` version mismatch returns an invalid-parameters
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
| `trace.jsonl` | one timing/success/error record per RPC call, capped at 5 MB |

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
`failed` through the task service. Each unfinished `.cairn/runs/*/run.json`
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

#### `RunStore`

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

#### `WorkflowService`

Workflow list and trust-dialog inspection data.

| API | Behavior |
|---|---|
| `workflows` | `Signal<WorkflowInfo[]>` of the latest workflow list |
| `refresh()` | Coalesced `workflow_list()` after project open |
| `inspect(name)` | Return script path, hash, and file inventory for trust |
| `clear()` | Reset workspace-scoped state |

List and inspect errors are reported through `handleApiError`; the service
consumes no events.

#### `RunService`

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

#### `WorkSyncService`

App-wide subscription and workspace lifecycle coordinator, instantiated by the
app initializer.

| Lifecycle | Behavior |
|---|---|
| Subscribe | Listen once to task, note, project, run, and proposal events |
| Workspace change | Clear caches, then close or open the project |
| Project open | Refresh tasks, notes, proposals, run, and workflows |
| `project:reloaded` | Refresh tasks, notes, and proposals |

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
| `TrustRequired` | Project workflow hash is not approved | `RunService.run` returns `trust-required` and does not toast. |
| `RuntimeUnavailable` | Workflow launcher/SDK is unavailable | Reported with Rust's message. |
| `WorkflowNotFound` | Workflow name cannot be resolved | Reported with Rust's message. |
| `Io`, `Corrupt` | Disk or record problem | Reported with Rust's message; list-level storage errors remain in store `errors`. |
| `BadArgs` | Tauri rejected a plain-string/bad-shape argument | Normalized by `WorkApiService`; reported as an error. |

`handleApiError` suppresses `NoProject`; it handles stale refreshes when given a
refresh callback. `RunService` is the sole special case for `TrustRequired`.
No service retries a rejected mutation silently.

### UI recipes

#### Run button and its states

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

#### Trust dialog

1. `const result = await runService.run(task.id, workflowName)`.
2. If `result?.kind === 'trust-required'`, display its `path`, `hash`, and
   `files`, and plainly warn: **the script runs with your permissions**.
3. After approval call
   `await runService.trustAndRun(task.id, result.workflow.name, result.workflow.hash)`.
   This calls `workflow_trust` before retrying `run_start`.
4. If the hash has changed since inspection, Rust rejects trust/start and the
   service reports the error; inspect again before asking for approval.

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
| `tasks` | `get(task_id)`, `list()`, `propose(...)`, `propose_batch(items, source_task_id=None, presentation="notify")`, `propose_subtasks(task_id, items, presentation="notify")` |
| `proposals` | `list()` |
| `notes` | `get(note_id)`, `for_task(task_id)` |
| `run` | `context()`, `pending_steps()`, `step_start(subtask_id)`, `step_finish(subtask_id, outcome, summary=None, reason=None)`, `step(subtask_id)`, `finish(outcome, summary=None, reason=None)` |

Examples below are the SDK workflows shipped in `sdk/python/examples/`.

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
