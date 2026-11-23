# Patches

Scripts never write workspace files. They propose patches, and the user applies
or discards each patch through Tauri commands.

## Record

Patches are stored as
`.cairn/runs/<runId>/patches/<n>.json`, with numbering starting at 1. Each
record uses camelCase and contains `id`, `runId`, `taskId`, optional
`subtaskId`, `title`, optional `summary`, `status`, `createdAt`, optional
`appliedAt`, and `files`. Status is `pending`, `applied`, or `discarded`.
Each file entry contains `path`, `op` (`create` or `modify`), optional
`baseSha256`, optional `before`, and `after`.

The open running subtask is recorded as `subtaskId` when one exists. Patches
are capped at 20 per run, 50 edits, 20 distinct files, and 1 MB of resulting
after-text.

## RPC

`patch.propose` accepts `title`, optional `summary`, and edits. Replace edits
require an existing file, a non-empty search string, and exactly one match in
the evolving text. Multiple replace edits on one file are applied in order.
Write edits replace a whole file; a missing file is `create`, an existing file
is `modify` with `baseSha256` and `before`.

Nothing is written to the workspace when a patch is proposed.

## Commands

| Command | Args | Result |
|---|---|---|
| `patch_list` | `runId?` | patch summaries newest first, without file texts |
| `patch_get` | `runId`, `patchId` | full patch record |
| `patch_discard` | `runId`, `patchId` | discard a pending patch |
| `patch_apply` | `runId`, `patchId` | apply a pending patch |

Run and patch ids must match `[A-Za-z0-9-]{1,64}`.

Apply requires a pending patch. For every modify entry, the current SHA-256
must equal `baseSha256`; for every create entry, the file must still be absent.
Conflicts return `PatchConflict` and list the paths. No conflict leaves the
workspace untouched. On success, files are written atomically and the patch
becomes `applied`. If a write fails, files already written are restored from
their `before` content or removed if they were creates.

## Events

`patch:created` and `patch:updated` carry patch summaries only: no file text
or search/replace content.

## Frontend

`WorkApiService` provides typed workflow-choice and patch commands.
`PatchStore` caches summaries by `runId/patchId`, merges refresh results and
events by `createdAt` and status (there is no revision), and clears when the
workspace changes. `PatchService` exposes `all`, `pending`,
`forTask(taskId)`, and `forRun(runId)` signals, plus `refresh()`,
`load(runId, patchId)`, `apply(runId, patchId)`, and
`discard(runId, patchId)`. Full patch records are cached up to 20 entries and
reloaded when the summary status changes.

Review recipe: list pending patches for a task, load a patch, display its
`before` and `after` values as plain text, then apply it. A conflict is returned
as `{ kind: 'conflict', message }`; show the Rust message as plain text and do
not parse it. Successful apply refreshes patch summaries because workspace
files changed on disk; filesystem watcher events continue to update the
explorer. Patch handling does not mutate node or tab stores.

## Secret deny list

Read, list, and patch paths deny `.git` and `.cairn` components and these
case-insensitive file patterns: `.env`, `.env.*`, `.npmrc`, `.pypirc`,
`id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`. Paths must be
relative and stay under the project root. This protects credentials and private
keys from script reads and patch proposals.
