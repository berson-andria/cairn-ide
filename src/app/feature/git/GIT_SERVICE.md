# GitService: reference

File: `git_service.ts` (Angular, `providedIn: 'root'`)

A thin wrapper around the `git` command line, run through the Tauri command `git_run`. It keeps the repository status in Angular signals so the UI (explorer, changes panel, diff editor, history panel) can react to it, and it exposes one method per git action.

**Dependencies:** `TauriBridgeService` (runs the command), `WorkspaceNodeStore` (provides `rootPath`, the open folder), `git-status.parser` / `git-parsers` (turn git output into objects), `fsEvents$` (file-system change events).

---

## 1. How it works (read this first)

Three layers, from lowest to highest:

| Layer | Method | Role |
|---|---|---|
| Raw | `runGitCommand` | Calls Tauri `git_run`. **Throws** if git can't run. |
| Safe | `exec` (private) | Wraps `runGitCommand`. **Never throws**, returns a `GitResult`. Used by every *read*. |
| Write | `mutate` (private) | Wraps `exec`. Runs **one at a time** (avoids `index.lock` errors), sets `busy`, then calls `refresh()`. Used by every *write*. |

Rules of thumb:

- **Reads** (history, branches, readAt…) call `exec`. They do not refresh status.
- **Writes** (stage, commit, switch…) call `mutate`. They refresh status afterwards.
- Commands run from the **repository root** by default, because paths in `git status` are relative to it.

### Automatic refresh triggers

The status reloads on its own when:

1. the open folder changes (an `effect` on `rootPath()`), and
2. any file-system event happens (`fsEvents$`, debounced 500 ms). This also catches a `git add` done in a terminal.

After a `mutate`, `refresh()` runs too, so you can see two refreshes in a row. `refresh()` collapses overlapping calls, so this is harmless.

---

## 2. Types

### `GitResult`: what every action returns

| Field | Meaning |
|---|---|
| `ok` | `true` if git succeeded |
| `output` | git's stdout |
| `error` | git's message, ready to show to the user |
| `unavailable?` | `true` when git couldn't be run at all (not installed, refused by allowlist, timeout) |
| `code?` | `'identity'` when git doesn't know the user's name/email yet |

### `GitCommandOutput`: raw result from Rust

`stdout`, `stderr`, `exitCode` (camelCase on purpose), `success`.

### `GitBadge`: what the explorer shows next to a file

`letter` (M, A, D, R, C, T, U, `!`), `kind`, `staged`.

### Constants

- `NETWORK_TIMEOUT = 300` s: fetch / pull / push
- `SLOW_TIMEOUT = 120` s: commit (hooks can be slow)
- Clone uses a 900 s timeout (inline).
- `IDENTITY_ERROR`: regex matching git's "who are you?" messages.
- `keyOf(path)`: normalises a path (backslashes, lower case) so git paths and explorer paths compare equal.

---

## 3. Signals (state)

| Signal | Type | Meaning |
|---|---|---|
| `repoRoot` | `string \| null` | Top of the repository, `null` if the folder isn't in one |
| `status` | `GitStatus \| null` | Parsed `git status` |
| `error` | `string \| null` | Set when git itself is unusable (not installed). Different from "not a repo" |
| `isRepo` | computed | `repoRoot() !== null` |
| `busy` | `boolean` | `true` while a write is running (disable buttons) |
| `statusVersion` | `number` | Increments after every successful status load. The diff editor watches it to reload |
| `staged` | computed | Files with staged changes |
| `unstaged` | computed | Files with unstaged changes (excluding conflicts) |
| `conflicts` | computed | Files with unresolved merge conflicts |
| `byPath` | computed | Map: absolute path → file status, for O(1) lookup while rendering the explorer |
| `changedFolders` | computed | Set of every folder containing a change, to mark parents in the tree |

---

## 4. Methods

Paths come in two flavours. Keep them straight:

- **Repo-relative**, e.g. `src/a.ts`: what git reports (`GitFileStatus.path`, `CommitFile.path`).
- **Absolute**, e.g. `C:\proj\src\a.ts`: what the explorer and editor use.

### 4.1 Running git

| Method | Purpose |
|---|---|
| `runGitCommand(path, args, timeoutSecs?)` | Raw access to `git_run`. Throws on failure. Public, but only needed for things not covered below. |
| `exec(args, {cwd?, timeoutSecs?})` *(private)* | Runs one command, never throws. Returns `GitResult`. |
| `mutate(args, {cwd?, timeoutSecs?})` *(private)* | Queued write, then refresh. |

### 4.2 Status

| Method | Purpose |
|---|---|
| `refresh()` | Reload status. Safe to call often. |
| `load()` *(private)* | Does the work: `rev-parse --show-toplevel`, then `status --porcelain=v2 --branch -z --untracked-files=all`. Sets the signals. |
| `clear(error)` *(private)* | Resets all state (not a repo, or git unavailable). |

### 4.3 Explorer helpers

| Method | Purpose |
|---|---|
| `badgeFor(absPath)` | Returns a `GitBadge` for a file, or `null` if unchanged. |
| `hasChangesInside(absFolderPath)` | `true` if something inside the folder changed. |
| `absolutePathOf(repoRelPath)` | `src/a.ts` → absolute path. `null` if no repo. |
| `repoPathOf(absPath)` | Absolute → `src/a.ts`. `null` if outside the repo. |

### 4.4 Staging

| Method | Git command | Purpose |
|---|---|---|
| `stage(paths)` | `add -- <paths>` | Stage specific files. No-op if empty. |
| `stageAll()` | `add -A` | Stage everything. |
| `unstage(paths)` | `reset -q -- <paths>` | Unstage specific files. Uses `reset`, not `restore --staged`, because the latter fails in a repo with no commits. |
| `unstageAll()` | `reset -q` | Unstage everything. |
| `discard(files)` | `restore` + `clean -f` | **Destructive, cannot be undone.** Tracked files go back to their staged/committed content; untracked files are deleted. Staged changes are untouched (unstage first). The caller should confirm first. |

### 4.5 Commits

| Method | Git command | Purpose |
|---|---|---|
| `commit(message, {all?, amend?})` | `commit [-a] [--amend] -m …` | Commit. Empty message is an error unless amending (then `--no-edit`). Returns `code: 'identity'` if git doesn't know who the user is. |
| `undoLastCommit()` | `reset --soft HEAD~1` | Remove the last commit but keep its changes staged. |
| `lastCommitMessage()` | `log -1 --format=%B` | Pre-fills the message box when amending. |

### 4.6 History and commit contents

| Method | Purpose |
|---|---|
| `history(limit = 50, absPath?)` | **List of commits** (metadata only, not file content). `limit` caps how many commits are loaded so big repos stay fast. With `absPath`, only commits touching that file (`--follow` tracks renames). |
| `commitDetails(hash)` | Message, date, hash and the files changed by one commit. `null` if the hash is invalid/unknown. |
| `readAtCommit(hash, repoRelPath)` | Text of a file as it was in a commit (`git show hash:path`). `null` if it doesn't exist there. Also accepts `hash^` for the parent. |
| `readCommitDiff(hash, file)` | Both sides (`before`, `after`) of one file in one commit, ready for a diff editor. Handles added files (no before), deleted files (no after) and renames (uses `oldPath`). |
| `isCommitHash(hash)` *(private)* | Accepts only 4–40 hex chars, so a ref can never be read as an option. |

Flow: `history()` → user clicks a commit → `commitDetails()` → user clicks a file → `readCommitDiff()`.

### 4.7 Branches

| Method | Git command | Purpose |
|---|---|---|
| `branches()` | `branch -a <format>` | All local and remote branches. |
| `checkBranchName(name)` | `check-ref-format --branch` | Validation while the user types. Returns `null` if valid, otherwise a message. |
| `switchBranch(name)` | `switch <name>` | Switch to an existing **local** branch. |
| `switchTo(branch)` | `switch [--track]` | Switch to a branch as listed by `branches()`. Handles remote-only branches (needs `--track`). Does nothing if already current. |
| `createBranch(name, {from?, switchTo?})` | `switch -c` or `branch` | Create a branch; switches to it by default. |
| `deleteBranch(name, force?)` | `branch -d` / `-D` | Delete. `force` deletes even if unmerged. |
| `merge(branch)` | `merge --no-edit` | Merge into the current branch. On conflicts returns `ok: false`; the `conflicts` signal then lists the files. |
| `mergeAbort()` | `merge --abort` | Cancel an in-progress merge. |

### 4.8 Identity

| Method | Purpose |
|---|---|
| `getIdentity()` | Returns `{name, email}` from git config (empty strings if unset). |
| `setIdentity(name, email, scope = 'global')` | Saves `user.name` and `user.email`. `global` = whole machine, `local` = this repo only. |

### 4.9 Remotes

| Method | Git command | Purpose |
|---|---|---|
| `fetch()` | `fetch --prune` | Download remote changes. |
| `pull()` | `pull --ff-only` | **Fast-forward only**: fails instead of silently creating a merge commit. |
| `push({force?})` | `push [--force-with-lease]` | Push. If the branch has no upstream, adds `--set-upstream <remote> <branch>`. Refuses on detached HEAD or when no remote exists. |
| `defaultRemote()` | `remote` | `origin` if present, otherwise the first remote, otherwise `null`. |

### 4.10 Stash

| Method | Git command | Purpose |
|---|---|---|
| `stash(message?)` | `stash push --include-untracked` | Save changes, including untracked files. |
| `stashes()` | `stash list` | List stashes. |
| `stashPop(i = 0)` | `stash pop` | Apply and remove. On conflict git keeps the stash. |
| `stashApply(i = 0)` | `stash apply` | Apply, keep the stash. |
| `stashDrop(i = 0)` | `stash drop` | Delete a stash. |

### 4.11 Repositories

| Method | Purpose |
|---|---|
| `init()` | `git init` in the open folder. |
| `clone(url, parentDir, folderName?)` | Clones into `<parentDir>/<folderName>`. Returns `GitResult` plus `path` (the new folder) on success. Doesn't touch the current repo. |
| `folderNameFromUrl(url)` *(private)* | `https://host/a/repo.git` → `repo`. |

### 4.12 File contents for diffs

| Method | Purpose |
|---|---|
| `readAtHead(absPath)` | Committed version of a file (left side of a diff). `null` for new/untracked files or an empty repo. |
| `readFromIndex(absPath)` | Staged version (for staged-vs-committed diffs). |
| `readAt(ref, absPath)` *(private)* | Shared by the two above: `git show <ref>:<path>`. |

---

## 5. Known quirks and cleanup candidates

Kept here so future work doesn't rediscover them.

1. **Overlapping reads of a file at a ref.** `readAt` (absolute path) and `readAtCommit` (repo-relative path) both run `git show <ref>:<path>`. Could share one helper.
2. **Two hash/ref checks.** `isCommitHash` and the inline regex in `readAtCommit` (which also allows a trailing `^`) do the same job.
3. **`switchBranch` vs `switchTo`.** `switchTo` wraps `switchBranch` and adds remote support. Callers probably only need `switchTo`.
4. **Repeated "invalid name" guard** (`!name || name.startsWith('-')`) in `switchBranch`, `createBranch`, `deleteBranch`, `merge`, with a slightly different version in `checkBranchName`.
5. **`stashPop` / `stashApply` / `stashDrop`** are the same call with a different verb.
6. **`exec` sets `error` even on success** (`stderr || stdout`), so `result.error` is not reliable as "something went wrong". Check `result.ok` instead.
7. **Leftovers:** `console.log(result)` in `commitDetails`, and `window.__git` debug helper in the constructor.
8. **`runGitCommand` is public.** Check whether anything outside this file uses it; if not it could be private.
9. **Windows-only path handling.** Several places hard-code `\\` as the separator (`changedFolders`, `repoPathOf`, `clone`).
10. **Class name typo in a dependency:** the store is imported as `WorkspaceNodeStore`.

---

## 6. Typical UI flows

- **Open a folder** → `load()` runs automatically → signals fill → explorer shows badges.
- **Stage + commit** → `stage(paths)` → `commit(message)` → on `code: 'identity'`, show a form (`getIdentity` / `setIdentity`) and retry.
- **Sync** → `fetch()` → `pull()` → `push()`.
- **Switch branch** → `branches()` → `switchTo(branch)`.
- **Inspect history** → `history()` → `commitDetails(hash)` → `readCommitDiff(hash, file)`.
- **Diff a working file** → `readAtHead(path)` (or `readFromIndex(path)`) and compare with the editor text; reload when `statusVersion` changes.
