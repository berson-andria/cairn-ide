# Cairn IDE: context (load this first, every session)

Companion: `docs/MAP.md` (folder tree, module index, gaps). Load ONE domain doc
from `docs/domains/` (or the current per-topic docs, see section 9) only when the
task touches it. Keep this file under about 200 lines. Last reviewed: 2026-11-21.

## 1. What Cairn is

A lean desktop IDE: Tauri v2 (Rust) + Angular (standalone, signals) + Monaco.
Formula: the IDE provides Tasks, Notes and a Code Map; the user programs the
agent in Python. Context for models comes from structure (Tree-sitter, tasks,
notes), not from dumping files, so small local models (Qwen 35B MoE through an
OpenAI-compatible endpoint) work well. The owner builds it alone on Windows
and cannot pay for cloud models. Differentiator: an open host with a stable
API, not a closed agent.

## 2. How we work

- Claude is architect and reviewer: writes prompts for the implementer
  (Copilot in VS Code; earlier Codex), then reviews what comes back. Slices are
  small, with a scope, a "do not touch" list, tests and a "Done when".
- Every report must name the new tests, report the full test summary, and give
  `git diff --stat` for ONLY the files changed. Unverified items must be said.
- One implementer session at a time on the working tree. Commit between
  slices. Format only files you edit (never crate-wide `cargo fmt`).
- Claims about code must cite `path:line`; measure before fixing; do not
  guess names of commands, files or fields: look them up.
- Service slices never touch components, templates or stylesheets.

## 3. Rules that do not change

1. Rust is the only reader/writer of tasks, notes, proposals and runs.
   Angular and the Python SDK are clients. Angular owns settings (writes).
2. Tauri commands and JSON-RPC methods call the same service functions.
   Commands hardcode `Actor::Ui`; no command accepts an actor or a status.
3. Events are the only sync mechanism. Angular stores are caches fed by events;
   components never write to them.
4. `rev` on every record; mutations take `expectedRev` (StaleRev otherwise). A
   record updated by event is applied only if its `rev` is newer; `*:reloaded`
   events replace unconditionally.
5. Own writes are recognized by a hash of the bytes written, not by `rev`.
6. Input types use `deny_unknown_fields`; ids are validated `[A-Za-z0-9_-]`
   (max 64); input text is untrusted (UI renders plain text, never HTML).
7. A script can never complete a task, create or edit tasks or notes, or
   change another task's subtasks.
8. Project history is Rust-owned app data, capped at ten entries, and contains
   canonical path, name, and last-opened timestamp; missing folders remain
   with `missing: true`. Startup precedence is launch `--folder`, saved last
   project for ordinary processes, then empty for `--new-window` or a missing
   folder. History writes re-read app data, merge under the lock, and replace
   atomically; window close and quit do not mutate history.

## 4. Task status rules (Rust enforces)

Statuses: ready, running, blocked, needs_review, completed, failed.
ready->running (Ui, System); ready<->blocked (System, reconcile);
running->needs_review (Script, System); running->failed (System);
running->completed (Ui); needs_review->completed | ready (Ui);
failed->ready (Ui); completed->ready (Ui). Same status = no-op.
Forbidden = allowed for another actor; InvalidTransition = allowed for nobody.
Subtasks follow no table, except a script can never set `completed`.
Dependencies: single `dependsOn`; cycles rejected; a dangling dependency does
not block. Links: note ids live on the task (`linkedNoteIds`) only.
Completing a task (Ui) also completes its `needs_review` subtasks, one write.

## 5. Runs, steps, proposals

- `run_start`: resolve workflow, check trust (the whole `.cairn/workflows`
  folder hash), start task (ready->running) with the run id in `task.runs` in the
  same write, then spawn `uv run --script` in a Job Object (Windows) / process
  group (Unix). One run at a time. Child talks JSON-RPC 2.0 over stdio, one
  message per line; SDK in `sdk/python/cairn` (stdlib only).
- Script methods (allowlist, API v1): `hello`, `run.context`, `run.finish`,
  `tasks.get|list`, `notes.get|for_task`, `proposals.list`, `tasks.propose`,
  `tasks.propose_batch`, `tasks.propose_subtasks`, `step.start`, `step.finish`.
- Run end: finish stored then 5 s grace; exit 0 without finish = needs_review;
  nonzero exit, cancel, 30 min timeout, spawn failure, project close = failed.
  Running subtasks become failed; interrupted runs are failed on project open.
- Steps: `step.start/finish` set subtask status running/needs_review/failed for
  the run's own task. "Done" for resume = needs_review or completed.
  `run.context` returns `attempt`, `previous`, `resume{total,done,pending}`.
  Retry then Run behaves like resume.
- Proposals: separate record. Kinds `task`, `tasks` (ordered batch, optional
  `sourceTaskId`), `subtasks`. `presentation`: `display` (planning view) or
  `notify` (toast/badge/inbox). Accept is idempotent (task id = proposal id,
  `<id>-<n>` for batches), UI only; `seenAt` drives the badge.

## 6. Data ownership and storage

| Domain | Writer | Frontend cache |
|---|---|---|
| tasks, notes, proposals, runs | Rust services | `task.store`, `note.store`, `proposal.store`, `run.store` |
| settings, models (not keys) | Angular `SettingsService` | settings signals |
| API keys | Rust, OS keychain (`model:<id>`) | none |
| codemap | Rust | `CodeMapService` |
| nodes, tabs, editor | Angular | `node.store`, `tab.store` |

`.cairn/`: `settings.json`, `tasks/<id>.json`, `notes/<id>.json`, `workflows/`
(committed), `cache/codemap.json`, `runs/<runId>/{run.json,run.log,trace.jsonl}`,
`runs/proposals/<id>.json`. The app creates `.cairn/.gitignore` (`cache/ runs/
tasks/ notes/`) only if missing and never edits it. App data: user settings and
`workflow-trust.json`, plus `last-session.json` for project history. Every
history write re-reads app data and merges by canonical path/timestamp before
an atomic replace; window close and quit do not change history. Missing history
entries remain marked missing, and startup is launch folder, saved last project
for ordinary processes, then empty. Explorer hides `.git`, `.cairn/cache`, `.cairn/runs`;
live events for heavy folders (`node_modules`, `.venv`, `target`...) pass only
for the folder itself.

## 7. Events and error codes

Events: `task:created|updated|deleted|reloaded`, `note:created|updated|deleted|
reloaded`, `proposal:created|updated|deleted`, `run:started|log|finished|step`,
`project:reloaded`, `fs:changed` (batched, `overflow`), `fs:watch-error`.
Errors `{code,message}`: NotFound, StaleRev, InvalidTransition, Forbidden,
Validation, Io, Corrupt, NoProject, RunActive, TrustRequired,
RuntimeUnavailable, WorkflowNotFound. Bad argument shapes arrive as plain strings.

## 8. Status

Done: editor, LSP bridge, terminal, explorer, git, settings and models UI,
Rust codemap (Rust grammar only), tasks/notes service and stores, outside-edit
reload, Rust file watcher (replaced the slow plugin watcher), runs/workflows/SDK,
steps and resume, proposals (3 kinds, presentation, seen), Angular services and
stores for all of it, Run button.
Not yet verified end to end: a real workflow through the app (Python tests pass
under `uv`), hard-kill recovery, the release SDK path, Unix process-group code
(never compiled).
Next: trust dialog, run log and step timeline, proposal inbox and planning
view (UI); 6c (codemap reads for scripts, script-created notes, permission
manifest); slice 7 (Rust settings reader, `models.run`, default workflow);
trace panel; TypeScript grammar for the codemap; documentation consolidation.

## 9. Docs to load per topic

| Topic | Doc |
|---|---|
| Tasks and notes | `domains/notes.md#tasks-notes` |
| Proposals | `domains/proposals.md` |
| Runs, workflows, and SDK | `domains/runs.md#runs` |
| Watcher, filesystem events, and tree rules | `domains/watcher-fs.md` |
| Code map implementation | `domains/codemap.md` |
| Project and workspace | `domains/workspace.md` |
| Decisions and rationale | `architecture.md` |

Historical, do not load: `current-state.md`, `session-handoff.md`,
`slice-2-port-notes.md`, `watch-policy-current.md`, `ui-contract.md`.

## 10. Commands

`npm run tauri:dev`; `cd src-tauri && cargo test`; `npx tsc --noEmit -p
tsconfig.app.json`; `npx ng build --configuration development`;
`npx tsx --test tests/frontend-services.test.ts`. Known warning:
`missing-language-dialog.ts` (NG8102).