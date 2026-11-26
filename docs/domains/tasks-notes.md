# Tasks and notes

This document consolidates the implemented task and note contracts. Watcher
and filesystem-event contracts are in
[watcher and filesystem events](./watcher-fs.md). Run, workflow, and Python SDK contracts are in
[runs](./runs.md#runs). Proposal contracts are in [proposals](./proposals.md).

## tasks-notes

All commands return structured service errors as `{ "code": "...", "message": "..." }`. Tauri exposes Rust snake_case argument names as camelCase. Workspace open/close commands and startup/history behavior are documented in [workspace](./workspace.md). Every task and note command requires an open project. List commands return `{ records, errors }`; each error carries `{ code, message }`.

Tasks and notes are ignored by default in `.cairn/.gitignore`, which Rust creates as `cache/`, `runs/`, `tasks/`, and `notes/` only when that file is missing. It never overwrites a user file. Removing the `tasks/` and `notes/` lines allows those files to be added to Git and shared through Git.

### Commands

| Command | JS args | Returns |
|---|---|---|
| `task_list` | — | `{ records: TaskItem[], errors: StorageError[] }` |
| `task_get` | `id` | `TaskItem` |
| `task_create` | `task` | created `TaskItem` |
| `task_update` | `id`, `patch`, `expectedRev` | updated `TaskItem` |
| `task_delete` | `id` | `null` |
| `task_set_status` | `id`, `status`, `expectedRev` | updated `TaskItem` |
| `task_start` | `id`, `expectedRev` | updated `TaskItem` |
| `task_complete` | `id`, `expectedRev` | updated `TaskItem` |
| `task_set_dependency` | `id`, `dependsOn`, `expectedRev` | updated `TaskItem` |
| `task_set_anchor` | `id`, `anchor`, `expectedRev` | updated `TaskItem` |
| `task_link_note` | `id`, `noteId`, `expectedRev` | updated `TaskItem` |
| `task_unlink_note` | `id`, `noteId`, `expectedRev` | updated `TaskItem` |
| `task_get_dependent_tasks` | `id` | `TaskItem[]` |
| `task_can_start` | `id` | `boolean` |
| `task_set_acceptance_criteria` | `id`, `criteria`, `expectedRev` | updated `TaskItem` |
| `task_set_branch` | `id`, `branch`, `expectedRev` | updated `TaskItem` |
| `task_add_subtask` | `id`, `subtask`, `expectedRev` | updated `TaskItem` |
| `task_update_subtask` | `id`, `subId`, `patch`, `expectedRev` | updated `TaskItem` |
| `task_delete_subtask` | `id`, `subId`, `expectedRev` | updated `TaskItem` |
| `note_list` | — | `{ records: NoteItem[], errors: StorageError[] }` |
| `note_get` | `id` | `NoteItem` |
| `note_create` | `note` | created `NoteItem` |
| `note_update` | `id`, `patch`, `expectedRev` | updated `NoteItem` |
| `note_delete` | `id` | `null` |
| `note_set_anchors` | `id`, `anchors`, `expectedRev` | updated `NoteItem` |
| `note_set_anchor` | `id`, `anchor`, `expectedRev` | updated `NoteItem` |
| `note_add_anchor` | `id`, `anchor`, `expectedRev` | updated `NoteItem` |
| `note_remove_anchor` | `id`, `index`, `expectedRev` | updated `NoteItem` |
| `note_set_status` | `id`, `status`, `expectedRev` | updated `NoteItem` |
| `note_toggle_status` | `id`, `expectedRev` | updated `NoteItem` |

`TaskItem`, `NoteItem`, anchors and subtasks use the camelCase JSON shapes from Rust types. Status values are `ready`, `running`, `blocked`, `needs_review`, `completed`, `failed` for tasks and `open`, `completed` for notes. Delete commands resolve to no value (`null` through invoke).

`TaskItem.runs` is a read-only `string[]` of run ids, oldest first. It is
omitted when no run has been recorded, is capped at the newest 50 ids, and
does not bump the task schema version. It is returned by task reads and
included in task events, but is not accepted by `NewTask`, `TaskPatch`,
`BatchTaskItem`, or any command input. Run ids are not validated when task
files load: readers must tolerate unknown ids, including ids for deleted run
folders.

### Events

| Event | Payload |
|---|---|
| `task:created` | full `TaskItem` |
| `task:updated` | full `TaskItem` |
| `task:reloaded` | full `TaskItem` |
| `task:deleted` | `{ id: string }` |
| `note:created` | full `NoteItem` |
| `note:updated` | full `NoteItem` |
| `note:reloaded` | full `NoteItem` |
| `note:deleted` | `{ id: string }` |
| `project:reloaded` | `{}` |

For `task:reloaded` and `note:reloaded`, replace the cached record unconditionally and ignore `rev`; outside edits and git checkout can preserve or reduce revisions. Hand edits should bump `rev` to keep subsequent optimistic updates meaningful.

### Error codes

`NotFound`, `StaleRev`, `InvalidTransition`, `Forbidden`, `Validation`, `Io`, `Corrupt`, `NoProject`, `RunActive`. `NoProject` means no workspace has been opened. `Forbidden` means the requested transition exists but the UI actor cannot make it; callers cannot supply an actor. `task_delete` returns `RunActive` when the task has an active run; otherwise it deletes the task file, cascades to `.cairn/runs/<id>/` folders whose `run.json` `taskId` matches (emitting `run:deleted` per removed folder, continuing on per-folder delete errors), and `load`/`reconcile` sweeps orphan run folders.

### Null and absent values

For `task_update.patch.description` and `note_update.patch.type`, an absent key means unchanged, JSON `null` clears the optional value, and a supplied value sets it. For optional task anchor, acceptance criteria and branch setters, JSON `null` clears the value. Other service arguments are required; collection arguments such as note anchors replace the full collection. For `task_set_dependency`, `dependsOn: null` clears the dependency.
### Types

All input structs reject unknown fields. Fields are camelCase. Optional means the JSON property may be omitted; null behavior is stated explicitly. Persisted record output types (`SubTask`, `FileAnchor`, `NoteAnchor`, `StorageError`) retain their service model schemas.

| Type | JSON field | Type | Required | Null / absent behavior |
|---|---|---|---|---|
| `NewTask` | `title` | string | yes | null rejected |
| | `description` | string | no | absent/null become `None` |
| | `anchor` | `FileAnchor` | no | absent/null become `None` |
| | `linkedNoteIds` | string[] | no | absent/null become `None` |
| | `subTasks` | `NewSubTask[]` | no | absent/null become `None`; each item follows `NewSubTask` |
| | `dependsOn` | string | no | absent/null become `None` |
| | `acceptanceCriteria` | string | no | absent/null become `None` |
| | `branch` | string | no | absent/null become `None` |
| `TaskPatch` | `title` | string | no | absent/null mean unchanged |
| | `description` | string or null | no | absent unchanged; null clears; string sets |
| `NewSubTask` | `title` | string | yes | null rejected |
| | `description` | string | no | absent/null become `None` |
| `SubTaskPatch` | `title` | string | no | absent/null mean unchanged |
| | `description` | string or null | no | absent unchanged; null clears; string sets |
| | `status` | `TaskStatus` | no | absent/null mean unchanged |
| `NewNote` | `content` | string | yes | null rejected |
| | `type` | string | no | absent/null become `None` |
| | `anchors` | `NoteAnchor[]` | no (defaults to `[]`) | absent becomes `[]`; null rejected |
| `NotePatch` | `content` | string | no | absent/null mean unchanged |
| | `type` | string or null | no | absent unchanged; null clears; string sets |
| `FileAnchor` | `kind` | `"file" \| "function" \| "ast"` | yes | null rejected |
| | `path` | string | yes | null rejected |
| | `label` | string | no | absent/null become `None` |
| | `lineNumber` | unsigned integer | no | absent/null become `None` |
| `NoteAnchor` | `kind` | `"ast"` | yes | null rejected |
| | `id` | string | no | absent/null become `None` |
| | `label` | string | yes | null rejected |
| | `path` | string | yes | null rejected |
| | `lost` | boolean | no | absent/null become `None` |
| `SubTask` | `id` | string | yes | null rejected |
| | `title` | string | yes | null rejected |
| | `description` | string | no | absent/null become `None` |
| | `status` | `TaskStatus` | yes | null rejected |
| | `createdAt` | unsigned integer | yes | null rejected |
| | `updatedAt` | unsigned integer | no | absent/null become `None` |
| `StorageError` | `code` | `StorageErrorCode` | yes | null rejected; values `NotFound`, `StaleRev`, `Validation`, `Io`, `Corrupt` |
| | `message` | string | yes | null rejected |

`NewTask` and `NewNote` contain no identity, status, timestamp, schema version, or revision fields. Services generate those values. `task_add_subtask` similarly takes only `NewSubTask`; `task_update_subtask` takes `SubTaskPatch` plus the separate `subId` and `expectedRev` arguments.

Status command behavior (the UI is the fixed actor): `task_set_status` accepts same-status as a no-op, `ready → running`, `running → completed`, `needs_review → completed/ready`, `failed → ready`, and `completed → ready`; a transition reserved for another actor returns `Forbidden`, and a transition absent from the policy returns `InvalidTransition`. `task_start` accepts only `ready` tasks with completed or no dependency; otherwise `InvalidTransition`. `task_complete` accepts `running` and `needs_review`, and `completed` as a same-status no-op; other source statuses return `InvalidTransition`.

When the UI completes a task, every subtask currently in `needs_review` is
changed to `completed` as part of the same task write, revision bump, and
`task:updated` event. Subtasks in other statuses are unchanged. Reopening the
task (`completed → ready`) leaves all subtask statuses as they are; the UI may
still send an individual subtask back to `ready`.

#### JSON examples

`task_create`:

```json
{"task":{"title":"Write migration","description":null,"subTasks":[{"title":"Add tests"}]}}
```

`task_update`:

```json
{"id":"task-1","patch":{"description":null},"expectedRev":2}
```

`task_add_subtask`:

```json
{"id":"task-1","subtask":{"title":"Add tests"},"expectedRev":2}
```

`note_create`:

```json
{"note":{"content":"Check API behavior","anchors":[]}}
```

### Angular services

#### `TaskStore` and `NoteStore`

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

#### `TaskService` action API (existing facade)

`availableActions` returns applicable `{ action, enabled, reason? }` entries.
Disabled actions are not executed. Mutations use cached `rev`; stale updates
refresh the affected task. Errors are handled through `handleApiError`.

| API | Behavior |
|---|---|
| `records`, `errors`, `loaded`, `tasks`, task-status projections | Task cache and filtered signals |
| `availableActions(task)` | Status actions, including workflow eligibility |
| `perform(task, action, options?)` | Route start/run/cancel/complete/review/retry/reopen; Rust resolves the workflow scope for run |
| `refresh()`, `get(id)`, `select(id)`, `canStart(id)`, `getDependentTasks(id)` | Read and refresh tasks |
| `add`, `edit`, `delete`, `start`, `complete`, `setStatus`, task mutators | Existing task command facade |

#### `NoteService` (existing facade)

Note facade over the event-fed `NoteStore`; refresh coalesces list requests.
Handled API errors go through `handleApiError`.

| API | Behavior |
|---|---|
| `records`, `errors`, `loaded`, `notes`, `openNotes`, `completedNotes`, `inboxNotes` | Note cache and filtered signals |
| `refresh()`, `get(id)` | Read and refresh notes |
| `add`, `edit`, `delete` | Create, update, and delete notes |
| `setAnchors`, `setAnchor`, `addAnchor`, `removeAnchor`, `setStatus`, `toggleStatus` | Note mutations |

