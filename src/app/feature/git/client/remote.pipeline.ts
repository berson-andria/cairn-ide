import { fail } from '../services/git.service';
import { confirmAction } from '../ui/git-dialogs';
import { plural } from '../features/dialogs/dialog-shared';
import { GitPipelineContext } from './context';
import { withRecovery } from './recovery';

export async function fetchPipeline(ctx: GitPipelineContext): Promise<void> {
  const result = await withRecovery(ctx, () => ctx.git.fetch());
  ctx.notices.report(result, 'Fetched');
}

export async function pullPipeline(ctx: GitPipelineContext): Promise<void> {
  const result = await withRecovery(ctx, () => ctx.git.pull());
  ctx.notices.report(result, 'Pulled.');
}

export async function pullRebasePipeline(ctx: GitPipelineContext): Promise<void> {
  const changes = ctx.git.status()?.files.length ?? 0;
  let autostash = false;
  if (changes) {
    const ok = await confirmAction(
      `You have ${changes} uncommitted ${plural(changes, 'change', 'changes')}. Stash them, pull with rebase, then restore them?`,
      'Stash and Pull',
    );
    if (!ok) return;
    autostash = true;
  }
  const result = await withRecovery(ctx, () => ctx.git.pullRebase(autostash));
  ctx.notices.report(result, 'Pulled (rebase).');
}

export async function pullFromPipeline(ctx: GitPipelineContext): Promise<void> {
  const remote = await ctx.dialogs.pickRemote('Pull from', await ctx.git.remotes(), 'Next');
  if (!remote) return;

  await ctx.git.loadBranches();
  const remoteBranches = ctx.git
    .branchList()
    .filter((b) => b.remote && b.name.startsWith(`${remote}/`) && !b.name.endsWith('/HEAD'));
  const picked = await ctx.dialogs.pickBranch(`Pull from ${remote}`, remoteBranches, {
    submitLabel: 'Pull',
  });
  if (!picked) return;

  const result = await withRecovery(ctx, () =>
    ctx.git.pullFrom(remote, picked.slice(remote.length + 1)),
  );
  ctx.notices.report(result, 'Pulled.');
}

/**
 * A branch with no upstream has nothing to push TO yet, and GitService.push() no longer guesses
 * one — guessing silently is exactly the kind of thing that shouldn't happen on a push. Route a
 * first push through publishBranchPipeline instead, so "which remote" is always asked (or
 * resolved) the same way, whether the person clicked Push or Publish Branch.
 */
export async function pushPipeline(
  ctx: GitPipelineContext,
  options: { force?: boolean } = {},
): Promise<void> {
  const status = ctx.git.status();
  if (!status?.branch) {
    ctx.notices.report(
      fail('You are not on a branch (detached HEAD), so there is nothing to push.'),
    );
    return;
  }
  if (!status.upstream) {
    return publishBranchPipeline(ctx); // nothing to force on a first push: options.force is dropped here
  }

  if (
    options.force &&
    !(await confirmAction(
      'Force push (with lease) overwrites the remote branch. Continue?',
      'Force Push',
    ))
  ) {
    return;
  }
  const result = await withRecovery(ctx, () => ctx.git.push(options));
  ctx.notices.report(result, options.force ? 'Force pushed.' : 'Pushed.');
}

export async function pushToPipeline(ctx: GitPipelineContext): Promise<void> {
  const remote = await ctx.dialogs.pickRemote('Push to', await ctx.git.remotes(), 'Push');
  if (!remote) return;
  const result = await withRecovery(ctx, () => ctx.git.pushTo(remote));
  ctx.notices.report(result, `Pushed to ${remote}.`);
}

export async function publishBranchPipeline(ctx: GitPipelineContext): Promise<void> {
  const remotes = await ctx.git.remotes();
  const remote =
    remotes.length === 1
      ? remotes[0]
      : await ctx.dialogs.pickRemote('Publish branch to', remotes, 'Publish');
  if (!remote) return;
  const result = await withRecovery(ctx, () => ctx.git.pushTo(remote));
  ctx.notices.report(result, 'Branch published.');
}

/** The Sync button: asks first, like VS Code, then pulls and pushes. */
export async function syncPipeline(ctx: GitPipelineContext): Promise<void> {
  const upstream = ctx.git.status()?.upstream;
  if (!upstream) return;
  const ok = await confirmAction(
    `This action will pull and push commits from and to "${upstream}".`,
    'OK',
  );
  if (!ok) return;
  const result = await withRecovery(ctx, () => ctx.git.sync());
  ctx.notices.report(result, 'Synced.');
}

export async function addRemotePipeline(ctx: GitPipelineContext): Promise<void> {
  const r = await ctx.dialogs.addRemote();
  if (!r) return;
  const result = await ctx.git.addRemote(r.name, r.url);
  ctx.notices.report(result, `Remote ${r.name} added.`);
}

export async function removeRemotePipeline(ctx: GitPipelineContext): Promise<void> {
  const remote = await ctx.dialogs.pickRemote('Remove remote', await ctx.git.remotes(), 'Remove');
  if (!remote) return;
  if (!(await confirmAction(`Remove remote "${remote}"?`, 'Remove'))) return;
  const result = await ctx.git.removeRemote(remote);
  ctx.notices.report(result, `Remote ${remote} removed.`);
}

export async function deleteRemoteBranchPipeline(ctx: GitPipelineContext): Promise<void> {
  await ctx.git.loadBranches();
  const remoteBranches = ctx.git.branchList().filter((b) => b.remote && !b.name.endsWith('/HEAD'));
  const name = await ctx.dialogs.pickBranch('Delete remote branch', remoteBranches, {
    submitLabel: 'Delete',
    danger: true,
  });
  if (!name) return;

  const slash = name.indexOf('/');
  const remote = name.slice(0, slash);
  const branch = name.slice(slash + 1);
  if (
    !(await confirmAction(
      `Delete "${branch}" from ${remote}? This affects everyone using it.`,
      'Delete',
    ))
  )
    return;

  const result = await withRecovery(ctx, () => ctx.git.deleteRemoteBranch(remote, branch));
  ctx.notices.report(result, `Deleted ${name}.`);
}

/**
 * NOTE: the clone dialog asks for one "Clone into" path, but GitService.clone(url, parentDir,
 * folderName?) wants them split. This splits the typed path on its last separator — check it
 * against how your dialog's default directory is built before relying on it.
 */
export async function cloneRepoPipeline(
  ctx: GitPipelineContext,
  defaultDirectory: string,
): Promise<string | undefined> {
  const r = await ctx.dialogs.cloneRepo(defaultDirectory);
  if (!r) return undefined;

  const path = r.directory.replace(/[\\/]+$/, '');
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const parentDir = lastSep >= 0 ? path.slice(0, lastSep) : path;
  const folderName = lastSep >= 0 ? path.slice(lastSep + 1) : undefined;

  const result = await withRecovery(ctx, () => ctx.git.clone(r.url, parentDir, folderName));
  ctx.notices.report(result, 'Cloned.');
  return result.ok ? result.path : undefined;
}
