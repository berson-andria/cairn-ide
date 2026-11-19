# Slice 2 port notes

## Public service method mapping

Computed views remain Angular-side. Rust counterparts below are planned in the slice 2 service API.

| TypeScript public method/property | Rust counterpart |
|---|---|
| TaskService.tasks | `TaskService::list` |
| TaskService.selectedTaskId / selectedTask / select | dropped: view selection state |
| TaskService.readyTasks / runningTasks / blockedTasks / completedTasks / availableTasks | dropped: computed views stay Angular |
| TaskService.get | `TaskService::get` |
| TaskService.add | `TaskService::create` |
| TaskService.edit | `TaskService::update` (restricted patch of title and description only; description is clearable) |
| TaskService.delete | `TaskService::delete` |
| TaskService.setStatus | `TaskService::set_status` |
| TaskService.setAnchor | `TaskService::set_anchor` |
| TaskService.addLinkedNote | `TaskService::link_note` |
| TaskService.removeLinkedNote | dropped as a public operation; note delete performs private cross-task unlinking. Angular call sites are `note-view.ts:146` and `note-list.ts:111`; the Angular migration must replace both with task-scoped `unlink_note(task_id, note_id, expected_rev)` calls after identifying the owning task(s). |
| TaskService.setDependency | `TaskService::set_dependency` |
| TaskService.addSubTask | `TaskService::add_subtask` |
| TaskService.updateSubTask | `TaskService::update_subtask` |
| TaskService.deleteSubTask | `TaskService::delete_subtask` |
| TaskService.getDependentTasks | `TaskService::get_dependent_tasks` |
| TaskService.canStart | `TaskService::can_start` |
| TaskService.start | `TaskService::start` (returns updated task; errors replace boolean failure) |
| TaskService.complete | `TaskService::complete` |
| TaskService.setAcceptanceCriteria | `TaskService::set_acceptance_criteria` |
| TaskService.setBranch | `TaskService::set_branch` |
| NoteService.notes | `NoteService::list` |
| NoteService.openNotes / completedNotes / inboxNotes | dropped: computed views stay Angular |
| NoteService.get | `NoteService::get` |
| NoteService.add | `NoteService::create` |
| NoteService.edit | `NoteService::update` (restricted patch of content and type only; type is clearable) |
| NoteService.delete | `NoteService::delete` |
| NoteService.setAnchors | `NoteService::set_anchors` |
| NoteService.setAnchor | `NoteService::set_anchor` |
| NoteService.addAnchor | `NoteService::add_anchor` |
| NoteService.removeAnchor | `NoteService::remove_anchor` |
| NoteService.setStatus | `NoteService::set_status` |
| NoteService.toggleStatus | `NoteService::toggle_status` |

## TypeScript behavior outside the service rules

- Both services start with empty in-memory arrays; additions prepend. Missing ids are silent no-ops for edits/deletes/status/anchor operations. Rust uses repository-backed `NotFound` errors.
- Task creation uses UUID ids, timestamps in milliseconds, defaults status to ready unless an unfinished dependency is found (then blocked), and preserves an explicitly requested status. Rust ignores requested status and derives it, resets supplied initial subtask ids/statuses, and rejects linked note ids that do not exist.
- Task edits merge arbitrary partial fields and set `updatedAt`; changing `dependsOn` blocks only if the dependency exists and is unfinished. Missing dependencies remain accepted by TypeScript. Rust rejects missing dependencies and cycles per slice rules.
- TypeScript permits arbitrary task status changes via `edit` and `setStatus`, including ready->completed, running->ready, and blocked->running. The Rust transition policy intentionally rejects these except the explicit subtask exception.
- Completing a task unblocks only currently blocked direct dependents. Rust reconcile recalculates every ready/blocked task, including blocking as well as unblocking.
- `start` returns false for missing/completed/unavailable tasks, but does not explicitly require ready; a blocked task whose dependency is complete can be started. Rust requires ready and returns a structured error.
- Task anchors, acceptance criteria and branch can be set to null, which removes the optional field. Linked note insertion is unique and silently ignores missing task/duplicate link; TypeScript does not check note existence.
- Subtasks receive UUIDs and millisecond timestamps. Add defaults status to ready; update timestamps the subtask and parent. TypeScript permits arbitrary subtask status edits; Rust applies only the stated script-completed prohibition.
- Note creation uses `String(Date.now())` ids, defaults to open and empty anchors, and prepends. Rust uses repository UUID fallback and the typed model's defaults.
- Note edits merge arbitrary fields and timestamp; missing ids are silent no-ops. Rust patch accepts only content and type. `setAnchor(null)` clears all anchors; array replaces all; scalar replaces with one. `addAnchor` appends without deduplication. Rust `remove_anchor` rejects an invalid index without changing timestamp/revision; TypeScript instead leaves anchors unchanged but timestamps the note.
- Note status can be set or toggled freely between open and completed. No additional status restrictions are specified for notes.
- The current TypeScript task status union has only ready/running/blocked/completed; the Rust model already includes needs_review/failed per architecture decisions.

## Assumptions

- Rust service methods return records for mutations (and changed ids from reconcile); no caller compatibility is needed until the later Tauri slice.
- `update` patch types expose only permitted mutable fields; identity, creation time, schema version and revision are not accepted.
- TaskService and NoteService receive the same `Arc<Mutex<()>>`; mutation lock order is shared service lock, then repository lock.
- Both `list` methods return repository `ListReport` with valid records and per-file errors.
- List reports with corrupt entries are treated conservatively: valid records are returned and storage errors are not silently discarded where surfaced by the API.
- Reconcile ignores dangling dependencies for status computation as specified, but removes links whose note ids cannot be loaded.
- Operations use one service lock per service instance, then repository methods; task reconciliation invoked during a task or note mutation shares the task service lock and emits only after successful record writes.
