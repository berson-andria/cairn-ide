# Git

## 1. Purpose and ownership

Git provides repository status, diffs, history, branches, remotes, stashes, blame, and askpass credential prompts. Rust owns process execution and the command allowlist; Angular owns repository presentation, UI prompts, parsed cache state, and the user-facing action orchestration. There is no Rust Git service or Git store in the current implementation. Rust process calls are not project-data writes. Claims below come from the Git row in `docs/MAP.md:455`.

## 2. Data shapes

| Rust | TypeScript | Difference |
|---|---|---|
| `GitCommandOutput { stdout, stderr, exit_code, success }`, serialized camelCase as `stdout/stderr/exitCode/success` | `GitCommandOutput { stdout, stderr, exitCode, success }` | Match; Rust snake_case `exit_code` becomes `exitCode`. |
| No Rust Git record types for status/branches/history/stashes/blame | `GitStatus`, `GitFileStatus`, `GitBranch`, `GitCommit`, `GitStash`, `CommitDetails`, `GraphCommit`, `FileBlame` | Rust runs Git and returns text; Angular parsers own these shapes. |

The Rust output shape is in `src-tauri/src/commands/git.rs:8-15`; the TypeScript equivalent is in `src/app/feature/git/services/git.service.ts:20-29`. Status shape: `src/app/feature/git/parser/status.parser.ts:3-16`. Branch shape: `src/app/feature/git/parser/branch.parser.ts:3-14`. History shape: `src/app/feature/git/parser/log.parser.ts:5-12`.

Git result/error handling is Angular-only:

| Rust | TypeScript |
|---|---|
| `git_run` and `askpass_answer` return plain `Result<_, String>` or unit | `GitResult { ok, output, error, unavailable?, code? }` |
| Askpass payloads use private Rust structs | `AskpassRequest { id, prompt, confirm }` |

The Angular result shape is in `src/app/feature/git/services/git.service.ts:31-47`; askpass payloads are in `src/app/feature/git/services/git-askpass.service.ts:5-13` and `src-tauri/src/commands/askpass.rs:28-42`.

## 3. Rust

### Services

There is no Rust Git service. Git process execution, allowlist validation, timeout handling, and askpass server state are implemented directly in command modules.

### Commands

| Name | Args (camelCase) | Return |
|---|---|---|
| `git_run` | `cwd`, `args`, `timeoutSecs`, `stdin`, plus managed `askpass` state | `GitCommandOutput` or `String` error |
| `askpass_answer` | `id`, `answer` | unit |

`git_run` validates one allowlisted subcommand, runs Git directly in `cwd`, applies a timeout, sets askpass and pager/editor environment, and returns process output. Arguments are array entries, not shell text. `src-tauri/src/commands/git.rs:211-278`. `askpass_answer` removes the pending request and sends `answer` to its waiting thread. `src-tauri/src/commands/askpass.rs:129-134`.

Commands are registered in `src-tauri/src/lib.rs:61-64`. The normal app starts the askpass server in `src-tauri/src/lib.rs:42-43`; askpass helper mode runs before Tauri startup in `src-tauri/src/main.rs:5-9`.

### Events

| Event | Payload |
|---|---|
| `askpass-request` | `{ id, prompt, confirm }` |

The Rust event is emitted after a helper process asks Git or ssh a question in `src-tauri/src/commands/askpass.rs:112-121`. Git itself emits no Tauri mutation events; Angular refreshes status from filesystem events and workspace changes.

## 4. Angular

### API wrapper

`GitService.runGitCommand(path, args, timeoutSecs?, stdin?)` invokes `git_run` with `cwd`, `args`, `timeoutSecs`, `stdin`; `GitAskpassService.init()` listens for `askpass-request` and invokes `askpass_answer`. `src/app/feature/git/services/git.service.ts:175-180`; `src/app/feature/git/services/git-askpass.service.ts:30-42`.

`GitService.exec(...)` converts invocation success/error into `GitResult` and catches invocation exceptions as `unavailable`. `mutate(...)` serializes mutations, sets `busy`, executes, and refreshes status. `src/app/feature/git/services/git.service.ts:188-228`.

### Signals and caches

`GitService` owns `repoRoot`, `status`, `error`, `busy`, `branchList`, and `statusVersion`, plus computed `isRepo`, `staged`, `unstaged`, `conflicts`, `byPath`, and `changedFolders`. It rebuilds status through `refresh`/`load` and clears all state for a plain folder or Git failure. `src/app/feature/git/services/git.service.ts:96-156`; `src/app/feature/git/services/git.service.ts:231-265`.

There is no Git store in `src/app/core/store`; Git state is a service-level signal cache.

### Facade and supporting services

`GitClient.commit(...)`, `stash(...)`, branch, remote, working-tree, and repository actions delegate to plain pipeline functions in `src/app/feature/git/client/*.ts`. `src/app/feature/git/services/git-client.service.ts:50-135`.

`GitDialogService` opens Git forms/pickers and returns canceled values; it deliberately does not call Git. `src/app/feature/git/services/git-dialog.service.ts:15-30`.

`GitAskpassService` queues askpass dialogs and sends the result back through `askpass_answer`. `src/app/feature/git/services/git-askpass.service.ts:24-49`.

`GitDiffService.open(...)`/`openChange(...)` constructs diff sides for the editor and uses `GitService.absolutePathOf`; it does not read file text directly. `src/app/feature/git/services/git-diff.service.ts:17-65`.

`GitBlameService.isEligible(...)` and `blame(...)` enforce editor limits and call `GitService.blame(...)`; `repoVersion` follows `statusVersion`. `src/app/feature/git/services/git-blame.service.ts:20-52`.

Errors handled in Angular: every `GitResult` reports `ok/error/code`; `exec` catches invocation failure and marks `unavailable`; network methods classify authentication/SSH text; commit identity uses `withRecovery`. `src/app/feature/git/services/git.service.ts:188-198`; `src/app/feature/git/services/git.service.ts:646-651`; `src/app/feature/git/client/recovery.ts:10-38`.

## 5. Flows

### Status refresh

UI/workspace/file event -> `GitService.effect` or `fsEvents$` -> `refresh()` -> `load()` -> `git_run("rev-parse")`, then `git_run("status"...")` -> Rust -> output -> parser `parseStatusV2` -> `repoRoot/status/error/statusVersion` signals.

The exact sequence is in `src/app/feature/git/services/git.service.ts:157-163`, `231-265`, and `src/app/feature/git/parser/status.parser.ts:55`.

### Stage/discard/commit

UI action -> component or `GitClient` -> pipeline -> `GitService.mutate`/`GitService.commit` -> `git_run` -> Rust allowlist/process -> `GitResult` -> `refresh()` -> signal update -> notice/UI refresh.

Commit prompts and unsaved-file handling occur in `src/app/feature/git/client/commit.pipeline.ts:10-74`; mutation serialization and refresh are in `src/app/feature/git/services/git.service.ts:211-228`.

### Branch action

UI -> `GitClient` -> `branch.pipeline` -> `GitDialogService` if needed -> `GitService.switchTo/createBranch/deleteBranch/merge/rebase/renameBranch` -> `GitService.mutate` -> `git_run` -> Rust -> `GitResult` -> refresh. `src/app/feature/git/services/git-client.service.ts:105-126`; `src/app/feature/git/client/branch.pipeline.ts:10-77`.

### Remote action

UI -> `GitClient` -> `remote.pipeline` -> `GitService.fetch/pull/push/pullFrom/pushTo` -> `GitService.network/mutate` -> `git_run` -> Rust -> `GitResult` -> refresh. `src/app/feature/git/services/git-client.service.ts:127-135`; `src/app/feature/git/services/git.service.ts:646-700`.

### Askpass

Git subprocess -> ssh/credential prompt -> helper executable -> `run_helper` TCP line -> Rust server `serve` -> `askpass-request` event -> `GitAskpassService.init` queues `handle` -> Git dialog -> `askpass_answer` -> pending sender -> helper stdout/exit -> Git.

The helper and server are in `src-tauri/src/commands/askpass.rs:38-127` and `153-189`; Angular is in `src/app/feature/git/services/git-askpass.service.ts:30-49`.

## 6. Gaps

- No Rust Git service exists, so the command module owns allowlist, process, timeout, and environment policy.
- No Git Tauri event exists for status changes; status is refreshed by `fsEvents$` and workspace effects, not an authoritative Git event. `src/app/feature/git/services/git.service.ts:157-163`.
- `GitService.saveCredentials` invokes `git credential reject/approve`, but Rust `ALLOWED_SUBCOMMANDS` does not contain `credential`. This is unverified end to end. `src/app/feature/git/services/git.service.ts:630-642`; `src-tauri/src/commands/git.rs:24-44`.
- Git status is a cache in `GitService`, not a formal store. Store behavior and reload semantics for Git were not verified.
- `commitAndPush` calls `await this.gitClient;` rather than an action, so it appears dead/broken. `src/app/feature/git/features/changes/git-changes.ts:160-168`.
- Unix/Tauri helper behavior and real askpass credential flows are unverified in this environment.

## 7. Logic in the wrong layer

- `src-tauri/src/commands/git.rs:67-168` - allowlist and subcommand-specific argument validation belong in a Rust Git service.
- `src-tauri/src/commands/git.rs:171-208` - timeout, pipe draining, and child-process polling belong in a Rust Git process service.
- `src-tauri/src/commands/askpass.rs:38-127` - askpass listener, pending-request registry, timeout, and event emission belong in a Rust Git/askpass service.
- `src/app/feature/git/features/changes/git-changes.ts:160-168` - commit-and-push/sync sequencing belongs in `GitClient` pipelines rather than the changes component.
- `src/app/feature/git/client/branch.pipeline.ts:43-77` - stash-switch-restore/migrate sequencing belongs in a Git operation service/facade rather than a pipeline workflow.
- `src/app/feature/git/client/commit.pipeline.ts:18-74` - commit preflight, staged/unstaged decisions, and recovery sequencing belong in `GitService` or `GitClient` orchestration rather than split UI pipeline logic.
