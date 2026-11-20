# Cairn architecture decisions

Status: decisions for the tasks/notes service and the Python SDK.
Facts about the current code live in `docs/current-state.md`. This file holds
what is decided but not built yet.

## 1. Core rules

1. **Rust is the only reader/writer of project data** (tasks, notes, and later
   runs). Angular and the Python SDK are both clients.
2. **The SDK never touches files.** It talks to Rust over JSON-RPC. The on-disk
   format is a private detail and may change.
3. **Two front doors, one service.** Tauri commands (for Angular) and JSON-RPC
   methods (for Python) call the same service functions. Validation, status
   rules and event emission are written once.
4. **Events are the only sync mechanism.** Angular stores are caches fed by
   events. Components never mutate store state directly.
5. **Status rules are enforced in Rust**, including who may make which
   transition (section 4).
6. **Angular remains the only writer of settings.** Rust gets a read-only
   settings reader when the SDK needs it (`models`, check commands, python path).

## 2. Layout of `.cairn/`

| Path | Content | Git |
|---|---|---|
| `settings.json` | workspace settings (exists) | out of scope for now |
| `tasks/<id>.json` | one task per file, subtasks inside | ignored by default |
| `notes/<id>.json` | one note per file | ignored by default |
| `workflows/` | project Python workflows | committed |
| `cache/` | codemap cache (`cache/codemap.json`, exists) | ignored |
| `runs/` | traces, model calls, logs | ignored |

Tasks and notes belong to the working tree, not to a branch: committed files
would vanish and reappear on every checkout. The app creates `.cairn/.gitignore`
(`cache/`, `runs/`, `tasks/`, `notes/`) only when it is missing and never edits
it afterwards. Deleting the `tasks/` and `notes/` lines shares them through
git. `task.branch` is metadata only. Ignored files are not backed up by git,
and `git clean -fdx` removes them.

One file per item keeps git merges small if they are shared. Writes are atomic (write temp file,
then rename). Every record carries `schemaVersion` and `rev`.

## 3. Data model

Keep the **current Angular shapes as the wire format** so existing components
change as little as possible. In Rust use `#[serde(rename_all = "camelCase")]`.

Task (existing fields, from `task.service.ts`):
`id, title, description?, anchor?, linkedNoteIds?, subTasks?, dependsOn?,
status, createdAt, updatedAt?, acceptanceCriteria?, branch?`

Note (existing fields, from `note.service.ts`):
`id, content, type?, status ('open'|'completed'), anchors[], createdAt, updatedAt?`

Added to both: `schemaVersion: number`, `rev: number`.

Decisions:

- **IDs.** Use UUIDs for tasks, subtasks and notes. Notes currently use
  `String(Date.now())`, which can collide. Nothing is persisted yet, so no
  migration is needed.
- **Task-note link.** The link is stored on the task only
  (`task.linkedNoteIds`). Notes do not carry a task anchor, so there is one
  copy and nothing to drift. Note anchors are AST/file anchors only
  (`NoteAnchor`). Verify against the current `note.service.ts` before slice 1,
  since the code changed after the discovery pass.
- **Dangling links.** Deleting a note leaves its id in `linkedNoteIds`. The
  service removes it from every task that references it. Because that touches
  other files it is not atomic, so the reconcile pass (section 4) also drops
  ids that point to missing notes, and reads tolerate a dangling id.
- **Name clash.** The old duplicate `TaskAnchor` name disappears with the note
  task anchor. In Rust use `FileAnchor` for the task anchor and `NoteAnchor`
  for note anchors.
- **Anchors.** Anchors currently hold `path`, `label` and `lineNumber`, which
  go stale as code moves. When Tree-sitter covers more languages, anchors
  should reference codemap symbol ids (`file::name::kind`) and use the existing
  `lost` flag when a symbol disappears. Not part of the first slices.
- **Dependencies.** `dependsOn` is a single id today. Keep it. `schemaVersion`
  allows widening it to a list later.

## 4. Status rules

Current statuses: `ready | running | blocked | completed`. Add
`needs_review` and `failed`.

| From | To | Actor |
|---|---|---|
| ready | running | ui, run lifecycle (Rust) |
| ready | blocked | rust (dependency not completed) |
| blocked | ready | rust (dependency completed) |
| running | needs_review | script, rust (process exited cleanly) |
| running | failed | rust only (crash, cancel, timeout) |
| running | completed | **ui only** (the human did the work) |
| needs_review | completed | **ui only** |
| needs_review | ready | ui (rejected) |
| failed | ready | ui (retry) |
| completed | ready | ui (reopen) |

A script can never set `completed`. A transition that some actor may make but
the caller may not returns `Forbidden`; one that no actor may make returns
`InvalidTransition`. Subtasks follow no table, except that a script can never
set a subtask to `completed`. Dependency logic currently in
`TaskService` (initial status, unblocking dependents, `canStart`) moves into
the Rust service. Dependents live in other files, so the update is not atomic:
after every mutation, and when a project loads, run an idempotent reconcile
that recomputes `blocked`/`ready` from `dependsOn` and drops `linkedNoteIds`
that point to missing notes.

## 5. Concurrency and errors

- Updates carry `expectedRev`. A stale update is rejected with `StaleRev`.
- Mutations from the UI and from a running script are serialized per record.
- Errors for the new service are structured: `{ code, message }`. Existing
  commands use `Result<_, String>`; do not refactor them. Codes include
  `NotFound`, `StaleRev`, `InvalidTransition`, `Forbidden`, `Validation`.
  JSON-RPC maps these codes directly.

## 6. Events

The service reports every change through an `EventSink` trait (slice 2); the
Tauri implementation that emits to Angular comes in slice 3.

Use Tauri events (broadcast), not per-call Channels. Today Angular has no event
listener helper; add one in `core/services/tauri/`.

Events: `task:created`, `task:updated`, `task:deleted`, `note:created`,
`note:updated`, `note:deleted`, `project:reloaded`. Each carries the full new
record (or the id for deletes).

## 7. Project root in Rust

Whether Rust holds a global workspace root is unverified. The codemap receives
the root through `codemap_open`. Add a small shared `ProjectState` in Rust,
set by a `project_open(path)` command that Angular calls when the workspace
changes. Tasks, notes and (later) the settings reader use it.

## 8. Run lifecycle (target)

1. Angular calls `run_task(id)`.
2. Rust rejects it if the task is already `running`, then sets `running` and
   emits an event.
3. Rust spawns the Python process (workflow path, task id, session token) and
   opens the JSON-RPC channel.
4. The script calls `tasks.get`, `codemap.context_for`, `models.run`, and so on.
   Every write goes through the service.
5. On exit: `needs_review` or `failed`. On user cancel: kill the process, set
   `failed`.

Python is a separate process, started lazily, never embedded in Rust.

## 9. Existing subsystems (reference)

**Settings** (`src/app/feature/setting/`). Angular owns it. `settings.registry.ts`
holds `SettingDef`, `SECTIONS`, `SETTINGS`. `SettingsService` exposes
`get(key)` as a signal, `set`, `reset`, `sourceOf`, `load`. Precedence is
workspace over user over default. User scope is a JSON file in app data;
workspace scope is `.cairn/settings.json`. Only non-default keys are written,
and writes are debounced. `core/services/settings-runtime.service.ts` applies
settings live (themes, Monaco options, terminal, LSP restarts, log level).
Model entries live in user settings. API keys are in the OS keychain through
the `keyring` crate (`secret_set/get/delete`, service `cairn-ide`, ref
`model:<id>`); they never appear in JSON. `model_test_local` runs `llama-cli`.

**Codemap** (`src-tauri/src/services/codemap/`). Rust only. Tree-sitter
extraction, blake3 body hashes, caller/callee graph, cache at
`.cairn/cache/codemap.json`. Production currently enables the Rust grammar
only; grammars are installed on demand. Exposed as `codemap_*` Tauri commands.
This is the base for the SDK's `codemap` namespace.

## 10. Build order (each slice is one nuclear task)

| # | Slice | Done when |
|---|---|---|
| 1 | Rust types, repository trait, file-backed repository | create/get/list/update/delete round-trip on disk; stale `rev` rejected; atomic write tested; corrupt file does not crash load |
| 2 | Service layer: status rules, dependency reconcile, `rev` handling | every row of the transition table has a test; script actor cannot reach `completed` |
| 3 | Tauri commands, events, `project_open`/`ProjectState` | commands registered in `lib.rs`; events emitted after every mutation |
| 4 | Angular: API service, `task.store.ts`/`note.store.ts` as event-fed caches, `TaskService`/`NoteService` become thin facades | existing task and note screens work; data survives restart |
| 5 | File watcher for external edits (`git pull`, manual) | editing a task file on disk updates the UI |
| 6 | JSON-RPC host + read methods + run lifecycle | a script can list tasks and a run reaches `needs_review` |
| 7 | Thin Python SDK + default workflow | default workflow runs end to end |
| 8 | Write methods and permission manifest | scripts blocked from undeclared calls |

Do not start slice N+1 before slice N is reviewed.

## 11. Script permissions (decided)

Scripts may: read tasks and notes (codemap later), finish a run, **propose**
tasks (the user validates before anything is created), and create notes
(marked as script-created). Scripts may not: create or edit tasks directly,
edit notes, change a task status other than through `run.finish`, complete a
task, write files in the workspace, or read settings and secrets. Direct edit
methods are not exposed; add them one at a time, behind the permission
manifest, only when a real workflow needs one.

Transport: JSON-RPC 2.0 over the child's stdin/stdout, one message per line. No
session token is needed because the pipe identifies the run. The SDK exits when
stdin reaches EOF, so a crashed app does not leave an orphan. The SDK moves
`print()` to stderr, which becomes the run log.

Run end: `run.finish` sets `needs_review` or `failed`. Exit 0 without a finish
means `needs_review`. A nonzero exit, a cancel, a timeout or a spawn failure
means `failed`, with a reason.

Trust: a project workflow runs only after the user approves its SHA-256
(stored in app data, never in the repo). A changed file asks again. Global
workflows are trusted.