# Architecture decisions

docs/CONTEXT.md wins when the two differ.

This document records rationale, not current implementation details. Current
contracts and status live in [CONTEXT.md](./CONTEXT.md) and
[MAP.md](./MAP.md).

## Ownership and boundaries

- Rust owns project data and enforces validation, status transitions, and
  mutation rules. Angular and the Python SDK are clients so that UI and
  automation cannot drift into separate data models or policy.
- Tauri commands and JSON-RPC methods call the same Rust services. This keeps
  authorization and validation at the service boundary rather than duplicating
  them in transports.
- Events are the synchronization mechanism for Angular caches. Components do
  not mutate cache state, keeping local UI state from becoming a second
  authoritative copy.
- Angular owns settings because they are UI preferences with existing user and
  workspace scopes. Rust reads settings only where a host operation requires
  them.
- The Python SDK communicates with Rust over JSON-RPC and never reads or writes
  project files. Keeping the on-disk representation private allows storage
  changes without breaking workflows.

## Project data

- Tasks, notes, proposals, and run records are project data managed by Rust.
  Settings remain separate because Angular owns their writes.
- One file per task or note limits the scope of writes and reduces conflicts
  when project data is shared intentionally. Atomic replacement prevents
  partially written records.
- `schemaVersion` and `rev` separate format evolution from optimistic
  concurrency. A mutation supplies the revision it observed; stale writes
  fail instead of silently overwriting another actor.
- Task dependencies and note links are resolved by the service. Reconciliation
  is idempotent because related records occupy separate files and cannot be
  changed in one filesystem transaction.

## Runs and trust

- Workflows run as a separate Python process so the IDE can bound and stop the
  process tree and keep Python runtime failures outside the Rust process.
- JSON-RPC over the child's standard streams identifies the run without a
  reusable session token. Redirecting workflow `print()` to stderr preserves
  stdout for protocol messages.
- Project workflow approval covers the whole workflow folder. Shared helper
  files can affect execution just as the selected script can, so trusting only
  one script would leave unapproved code in the execution path.
- Scripts propose tasks rather than creating or editing them directly. Human
  approval keeps automated suggestions from becoming project changes without
  review.

## Superseded decisions

- Tasks committed -> ignored by default: branch switches removed them.
- Note anchor for task links -> link stored on the task only: one authoritative
  link avoids duplicated state that could drift.
- Plugin-fs watcher -> Rust notify watcher: the plugin walked the whole tree.
- Revision-based own-write detection -> content hash: revisions can change
  independently of the bytes written.
- Single-file trust -> whole workflows folder: helper files can change run
  behavior too.
- workflows chosen by name -> one workflow per scope with a main.py entry.
- no-entry never falls through -> ask once, remember per project.
- Full-record create inputs -> dedicated input types: clients must not choose
  identity, status, timestamps, schema version, or revision.
