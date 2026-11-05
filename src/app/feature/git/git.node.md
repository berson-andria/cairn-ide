Components can already build a `DiffRequest` themselves. The only part that needs the service is looking up the `fileId` for a working-file side. So I'm changing the shared function to take a request, and a working-file side is given by path only. The git panel gets its own convenience method on top.

`GitDiffService.open()` now takes a request that any component can build, and the git panel has its own convenience method on top of it. Both files are updated: `git-diff.service.ts` and `diff-tab.ts`.

**The shared function:**

```ts
open(request: DiffRequestInput): Promise<string | null>   // error message, or null
```

A request is the two sides you already defined. The only difference is that a working-file side is `{ kind: 'worktree', path }` with no `fileId`. `open` looks the id up through the node store, then opens the tab. If the file isn't in the workspace, it returns an error message.

**Graph component (commit against commit):**

```ts
// a commit against its parent
const request = this.diffs.requestForCommits(`${hash}^`, hash, file);
// two commits chosen in the graph (the older one first)
const request = this.diffs.requestForCommits(olderHash, newerHash, file);

if (request) {
  const error = await this.diffs.open(request);
  if (error) this.notice.set({ kind: 'error', text: error });
}
```

`requestForCommits` takes `file.path` and `file.oldPath` as they are in `CommitFile`, which are repo-relative, and converts them to absolute paths. If you'd rather build the request yourself, any two sides work, such as a commit against HEAD:

```ts
this.diffs.open({
  original: { kind: 'commit', rev: hash, path },
  modified: { kind: 'head', path },
});
```

**Git panel:**

```ts
const error = await this.diffs.openChange(file, mode); // mode: 'staged' | 'unstaged'
```

`openChange` keeps the earlier behavior. It opens untracked and conflicted files as normal tabs, and for everything else it builds the staged or unstaged request and calls `open`.

**Things to check:**
- **Absolute paths.** Every path in a request must be absolute, in every side kind. `requestForCommits` and `openChange` convert for you, but a request you write by hand needs absolute paths.
- **Older commit first.** In `requestForCommits` the first argument is the older commit and becomes the left side. Check that the graph passes them in that order when a user picks two commits.
- **Renames across arbitrary commits.** `oldPath` is only meaningful when `from` is the parent of `to`. For two unrelated commits, a file that was renamed in between will show as empty on the older side.