# UI contract: what to call, what to listen to

For building the Angular UI. Args are camelCase as passed to `invoke`. Every
command rejects with `{ code, message }` OR a plain string (bad arguments);
normalize both (the existing `work-api.service.ts` does this). Authoritative
details: `task-note-api.md`, `run-api.md`, `proposal-api.md`.

## 0. Rules that apply everywhere

- Stores are caches. Never write to them from a component; call a command and
  let the event update the store.
- `task:created|updated`, `note:created|updated`, `proposal:created|updated`:
  upsert only if `rev` is newer. `task:reloaded`, `note:reloaded`: replace
  unconditionally (outside edit). `project:reloaded`: refetch the lists.
- Startup order: subscribe to all events, then `project_open(path)`, then the
  list commands. Switching folder: clear the stores, then the same sequence.
- Proposal text, run logs and model output are untrusted: render as plain text
  (no `innerHTML`), never forward them to a model as instructions.
- A script can never complete a task. Only the buttons below can.

## 1. Project and watcher

| Purpose | Call |
|---|---|
| Open / close the workspace | `project_open(path)` -> plain root path; `project_close()` |
| Outside change in the tree | event `fs:changed` `{ events:[{kind,paths}], overflow }`; on `overflow` do a full refresh |
| Watcher failed | event `fs:watch-error` `{ message }` -> show a notice |

## 2. Tasks

| Purpose | Call |
|---|---|
| Load the list (with unreadable files) | `task_list()` -> `{ records, errors }` |
| One task | `task_get(id)` |
| Create | `task_create(task)` (`NewTask`: title, description?, anchor?, linkedNoteIds?, subTasks?, dependsOn?, acceptanceCriteria?, branch?) |
| Edit title / description | `task_update(id, patch, expectedRev)`; `description: null` clears |
| Dependency | `task_set_dependency(id, dependsOn, expectedRev)`; `null` clears |
| Anchor / criteria / branch | `task_set_anchor`, `task_set_acceptance_criteria` (`criteria`), `task_set_branch`; `null` clears |
| Link a note | `task_link_note(id, noteId, expectedRev)`, `task_unlink_note(...)` |
| Subtasks | `task_add_subtask(id, subtask, expectedRev)` (`{title, description?}`), `task_update_subtask(id, subId, patch, expectedRev)`, `task_delete_subtask(id, subId, expectedRev)` |
| Delete | `task_delete(id)` |
| Run history | `TaskItem.runs?: string[]` is read-only, oldest first; do not send it to any task input |
| "Can it start?" / dependents | compute locally from the store (not wrapped) |
| Events | `task:created`, `task:updated`, `task:deleted {id}`, `task:reloaded` |

Use `TaskService.availableActions(task)` for the applicable status actions and
enabled state; execute with `TaskService.perform(task, action, options?)`.
When a workflow run is active for a running task, its actions include
`cancelRun` and a disabled `complete`; run actions may pass
`{ workflow: name }` when the user selects a workflow. See
[frontend-services.md](./frontend-services.md) for action reasons and the
service recipes.

## 3. Notes

`note_list`, `note_get(id)`, `note_create(note)` (`{content, type?, anchors?}`),
`note_update(id, patch, expectedRev)` (`content`, `type`; `type: null` clears),
`note_delete(id)`, `note_set_anchors | note_set_anchor | note_add_anchor |
note_remove_anchor(id, ..., expectedRev)`, `note_set_status | note_toggle_status`.
Events: `note:created|updated|deleted|reloaded`. Notes written by a script
are marked as script-created (6c, planned).

## 4. Running a workflow

| Purpose | Call |
|---|---|
| Which workflows exist | `workflow_list()` -> `[{ name, source: "project"\|"global", trusted }]` |
| Details for the trust dialog (files, hash) | `workflow_inspect(name)` -> `{ name, source, path, hash, trusted, files:[{path,size}] }` |
| Approve a project workflow | `workflow_trust(name, hash)`; the hash must be the current folder hash |
| Start | `run_start(taskId, expectedRev, workflow?)` -> run record; default workflow name is `default` |
| Stop | `run_cancel()` |
| Current or last run | `run_get()` -> record or `null` (running while `endedAt` is empty) |
| One attempt | `run_get(runId)` -> that record; unknown ids return `NotFound` |
| Past runs | `run_list(limit)` -> summaries, newest first |
| Log of a run, also after a restart | `run_log(runId, maxLines)` |
| Live | events `run:started {runId,taskId,workflow}`, `run:log {runId,lines[]}`, `run:finished {runId,taskId,outcome,reason?}` |

Start flow: call `run_start`. On `TrustRequired`, open the trust dialog:
`workflow_inspect`, show the files, say plainly that **the script runs with your
permissions**, and on approval call `workflow_trust` then `run_start` again.
`RunActive`: another run is going (one at a time). `RuntimeUnavailable`: `uv`
is missing or the SDK was not found. After `run:finished` the task is already
`needs_review` or `failed`; the UI only displays it. Keep the last 500 log lines
in memory per run and use `run_log` to refill after a reload.

Every retry creates a new run and adds its id to `TaskItem.runs`; the history
is oldest first and capped at 50 ids. `run.context` includes the current
1-based `attempt`. The frontend task-history recipe and APIs are in
[frontend-services.md](./frontend-services.md).

## 5. Proposals

A proposal is a suggestion from a workflow. Nothing becomes a task until the
user accepts. Always from `proposal:created|updated|deleted` plus
`proposal_list()` -> `{ records, errors }`.

| Purpose | Call |
|---|---|
| Accept (optionally edited) | `proposal_accept(id, expectedRev, payload?, sourceAction?)` -> `{ proposal, tasks[] }` |
| Reject | `proposal_reject(id, expectedRev)` |
| Remove a decided one | `proposal_delete(id)` (pending ones cannot be deleted) |
| Mark as seen | `proposal_mark_seen(ids[])` |

The optional `payload` must match the proposal kind:

- `task`: one `NewTask`.
- `tasks`: `{ sourceTaskId?, items }`; each item has a unique key and may
  depend on an earlier item using `dependsOnKey`.
- `subtasks`: `{ taskId, items }`; all subtasks are added to one parent.

`sourceAction` is `keep` or `delete`, is valid only when a batch has
`sourceTaskId`, and defaults to `keep`. A deleted source cannot be running.
Edited payloads are revalidated on acceptance; removing a batch item that
another item depends on is invalid. The result is `{ proposal, tasks[] }`.
Task ids in accepted batches and subtask ids are deterministic and positions
start at 1.

**Presentation.** Same record, same events, two purposes:

| `presentation` | Meant for | Where the UI shows it |
|---|---|---|
| `display` | planning with the agent | inline in the planning view, with Accept / Edit / Reject |
| `notify` | an agent working on a task that suggests subtasks or a split | a notification (toast) with Review / Accept / Dismiss, plus a badge and an inbox list |

Rules: `presentation` defaults to `notify`; the badge counts
`status == "pending" && !seenAt && presentation == "notify"`. Dismissing a
notification calls `proposal_mark_seen`; it does NOT reject. Several `notify`
proposals from one run should become one notification ("3 suggestions from
<workflow>"). Mark-seen calls accept at most 100 ids, ignore unknown or
already-seen ids, and bump revisions only for changed proposals.

## 6. Errors and what the UI does

| Code | Meaning | UI |
|---|---|---|
| `StaleRev` | changed elsewhere | refetch the record, say "changed elsewhere, try again"; never retry silently |
| `NotFound` | gone | refresh the list |
| `InvalidTransition` | not allowed from this status | refresh; the button should not have been shown |
| `Forbidden` | wrong actor | a bug; log it |
| `Validation` | bad input; the message names the field | show it next to the form |
| `NoProject` | no folder open | empty state |
| `RunActive` | a run is going | disable run buttons |
| `TrustRequired` | workflow not approved | trust dialog |
| `RuntimeUnavailable` | uv or SDK missing | show the message |
| `WorkflowNotFound` | no such workflow | show the message |
| `Io`, `Corrupt` | disk problem | show the message |
| plain string | bad argument shape | a bug; log it |

## 7. Not available yet (do not build UI for these)

Reading a model's output or calling a model from the UI; `codemap` data for
workflows (6c); script-created notes and the permission manifest (6c); a
planning workflow that creates `display` proposals (nothing creates them yet
until one exists).