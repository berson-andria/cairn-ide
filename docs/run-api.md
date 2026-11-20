# Workflow run API (Slice 6a)

Rust starts a trusted Python workflow as a child process. The child uses the
stdlib-only SDK at `sdk/python/cairn`; it never reads or writes project files
directly. The SDK and host communicate over the child's stdin and stdout using
JSON-RPC 2.0, one UTF-8 JSON message per line. Stdout is reserved for RPC;
workflow `print()` output is redirected to stderr and becomes run log output.
Lines larger than 1 MB are rejected with `-32600`.

## Starting and managing runs

The Tauri commands are:

| Command | Arguments | Result |
|---|---|---|
| `run_start` | `taskId`, `expectedRev`, optional `workflow` | run record |
| `run_cancel` | — | `null` |
| `run_get` | — | active run record, last run record, or `null` |
| `workflow_list` | — | `{ name, source, trusted }[]` |
| `workflow_trust` | `name`, `hash` | `null` |

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

## RPC methods

The first SDK call automatically performs the `hello` handshake. API version
1 is the only supported version.

| Method | Parameters | Result |
|---|---|---|
| `hello` | `{ "apiVersion": 1 }` | `{ "apiVersion": 1 }` |
| `run.context` | `{}` | `{ "runId", "taskId", "workflow" }` |
| `tasks.get` | `{ "id": string }` | one camelCase task record |
| `tasks.list` | `{}` | array of camelCase task records |
| `tasks.propose` | `NewTask` fields (camelCase), optional `presentation` | `{ "proposalId": string }` |
| `tasks.propose_batch` | `{ "items", "sourceTaskId"?, "presentation"? }` | `{ "proposalId": string }` |
| `tasks.propose_subtasks` | `{ "taskId", "items", "presentation"? }` | `{ "proposalId": string }` |
| `proposals.list` | `{}` | `{ "id", "title", "status" }[]` |
| `notes.get` | `{ "id": string }` | one camelCase note record |
| `notes.for_task` | `{ "taskId": string }` | linked note records; missing linked ids are skipped |
| `run.finish` | `{ "outcome": "needs_review" \| "failed", "summary"?: string, "reason"?: string }` | `null` |

For example, the request and response for a task read are each one line:

```json
{"jsonrpc":"2.0","id":1,"method":"tasks.get","params":{"id":"task-123"}}
{"jsonrpc":"2.0","id":1,"result":{"id":"task-123","title":"Example","status":"ready","createdAt":1,"schemaVersion":1,"rev":1}}
```

The host exposes only the methods in the table. Scripts may propose one or
more tasks or subtasks and list proposals, but mutating task or note methods,
including `tasks.create`, `tasks.update`, `tasks.set_status`,
`proposals.accept`, and `notes.create`, return method-not-found.
`presentation` is an optional `display` or `notify` UI hint and defaults to
`notify`; it does not change script permissions. `run.finish` cannot complete
a task; any outcome other than `needs_review` or `failed` returns `Forbidden`.
Proposal records, validation limits, and UI decisions are documented in
[proposal-api.md](./proposal-api.md).

## Errors

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

## Events

Events are emitted through the application's event sink:

| Event | Payload |
|---|---|
| `run:started` | `{ "runId", "taskId", "workflow" }` |
| `run:log` | `{ "runId", "lines": string[] }` |
| `run:finished` | `{ "runId", "taskId", "outcome": "needs_review" \| "failed", "reason"?: string }` |

`run:log` batches are emitted no more often than five times per second.

## Environment and files

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
| `run.json` | run id, task id, workflow, source, hash (project workflows folder hash; global workflow file hash), start/end timestamps, outcome, reason, and summary |
| `run.log` | workflow stderr and redirected `print()` output, capped at 5 MB |
| `trace.jsonl` | one timing/success/error record per RPC call, capped at 5 MB |

## Exit and status rules

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
system actor. The application kills the active child on shutdown.

## Recovery

When a project opens, any task still marked `running` is changed to `failed`
through the task service, and each unfinished `.cairn/runs/*/run.json` record is
ended as `failed` with reason `interrupted (app closed during run)`. Malformed
run records are skipped and logged; recovery errors do not prevent the project
from opening. Run finalization retries a task status update once after
`StaleRev`, and only if a re-read shows the task is still `running`.
