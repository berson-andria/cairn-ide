import { GitResult } from '../services/git.service';
import type { OverwriteStrategy } from '../services/git-dialog.service';
import { confirmAction } from '../ui/git-dialogs';
import type { GitBranch } from '../parser/branch.parser';
import { GitPipelineContext } from './context';
import { withRecovery } from './recovery';

/**
 * Switch to a branch from `branches()`. Git itself only refuses when local changes would be
 * overwritten, so the dialog only appears then — never up front.
 */
export async function switchToPipeline(ctx: GitPipelineContext, branch: GitBranch): Promise<void> {
  if (branch.current) return;

  // A remote branch with an existing local twin ("origin/dev" when "dev" already exists):
  // switch to the local one instead of re-tracking, or `--track` fails with "already exists".
  const twinName = branch.remote ? branch.name.slice(branch.name.indexOf('/') + 1) : null;
  const twin = twinName
    ? ctx.git.branchList().find((b) => !b.remote && b.name === twinName)
    : undefined;
  const target = twin ?? branch;

  const result = await withRecovery(ctx, () => ctx.git.switchTo(target));
  if (result.ok || result.code !== 'overwrite') {
    ctx.notices.report(result, `Switched to ${target.name}.`);
    return;
  }

  const strategy = await ctx.dialogs.overwriteStrategy(target.name);
  if (!strategy) return; // cancelled: nothing was changed
  if (
    strategy === 'force' &&
    !(await confirmAction(
      'Discard your local changes and switch? This cannot be undone.',
      'Force Checkout',
    ))
  ) {
    return;
  }

  const final = await withRecovery(ctx, () => switchWith(ctx, target, strategy));
  ctx.notices.report(final, `Switched to ${target.name}.`);
}

async function switchWith(
  ctx: GitPipelineContext,
  branch: GitBranch,
  strategy: OverwriteStrategy,
): Promise<GitResult> {
  if (strategy === 'force') return ctx.git.switchTo(branch, { force: true });

  const before = (await ctx.git.stashes()).length;
  const stashed = await ctx.git.stash(`Auto-stash before switching to ${branch.name}`, 'all', true);
  if (!stashed.ok) return stashed;
  const created = (await ctx.git.stashes()).length > before; // "No local changes to save" also succeeds

  const switched = await ctx.git.switchTo(branch);
  if (!switched.ok) {
    if (created) await ctx.git.stashPop(0); // put everything back
    return switched;
  }
  return strategy === 'migrate' && created ? ctx.git.stashPop(0) : switched;
}

export async function checkoutToPipeline(ctx: GitPipelineContext): Promise<void> {
  await ctx.git.loadBranches();
  const name = await ctx.dialogs.pickBranch(
    'Checkout to',
    ctx.git.branchList().filter((b) => !b.current),
    { submitLabel: 'Checkout' },
  );
  const branch = ctx.git.branchList().find((b) => b.name === name);
  if (branch) await switchToPipeline(ctx, branch);
}

export async function createBranchPipeline(
  ctx: GitPipelineContext,
  fromPicker = false,
): Promise<void> {
  let from: string | undefined;
  if (fromPicker) {
    await ctx.git.loadBranches();
    from = await ctx.dialogs.pickBranch('Create branch from', ctx.git.branchList(), {
      submitLabel: 'Next',
      message: 'Pick the starting point.',
    });
    if (!from) return;
  }
  const name = await ctx.dialogs.branchName('Create branch', 'Create', {
    message: from ? `Starting from ${from}.` : undefined,
    validate: (v) => ctx.git.checkBranchName(v),
  });
  if (!name) return;
  const result = await ctx.git.createBranch(name, { from });
  ctx.notices.report(result, `Switched to ${name}.`);
}

export async function deleteBranchPipeline(ctx: GitPipelineContext): Promise<void> {
  await ctx.git.loadBranches();
  const local = ctx.git.branchList().filter((b) => !b.current && !b.remote);
  const name = await ctx.dialogs.pickBranch('Delete branch', local, {
    submitLabel: 'Delete',
    danger: true,
  });
  if (!name) return;

  let result = await ctx.git.deleteBranch(name);
  if (!result.ok && /not fully merged/i.test(result.error)) {
    const force = await confirmAction(
      `"${name}" has commits that are not merged. Delete anyway?`,
      'Delete',
    );
    if (force) result = await ctx.git.deleteBranch(name, true);
  }
  ctx.notices.report(result, `Deleted ${name}.`);
}

export async function mergeBranchPipeline(ctx: GitPipelineContext): Promise<void> {
  await ctx.git.loadBranches();
  const current = ctx.git.status()?.branch;
  const name = await ctx.dialogs.pickBranch(
    'Merge branch',
    ctx.git.branchList().filter((b) => !b.current),
    { submitLabel: 'Merge', message: `Merge into ${current}.` },
  );
  if (!name) return;
  const result = await ctx.git.merge(name);
  ctx.notices.report(result, `Merged ${name}.`);
}

/** Aborts whichever of merge or rebase is in progress. */
export async function abortPipeline(ctx: GitPipelineContext): Promise<void> {
  const merge = await ctx.git.mergeAbort();
  const result =
    merge.ok || !/no merge to abort/i.test(merge.error) ? merge : await ctx.git.rebaseAbort();
  ctx.notices.report(result, 'Aborted.');
}

export async function rebaseBranchPipeline(ctx: GitPipelineContext): Promise<void> {
  await ctx.git.loadBranches();
  const name = await ctx.dialogs.pickBranch(
    'Rebase branch',
    ctx.git.branchList().filter((b) => !b.current),
    { submitLabel: 'Rebase', message: `Rebase ${ctx.git.status()?.branch} onto:` },
  );
  if (!name) return;
  const result = await ctx.git.rebase(name);
  ctx.notices.report(result, `Rebased onto ${name}.`);
}

export async function renameBranchPipeline(ctx: GitPipelineContext): Promise<void> {
  const current = ctx.git.status()?.branch;
  if (!current) return;
  const name = await ctx.dialogs.branchName('Rename branch', 'Rename', {
    initial: current,
    validate: (v) => ctx.git.checkBranchName(v),
  });
  if (!name || name === current) return;

  const upstream = ctx.git.status()?.upstream; // e.g. "origin/old", before the rename
  const result = await ctx.git.renameBranch(current, name);
  if (!result.ok) {
    ctx.notices.report(result);
    return;
  }

  if (upstream) {
    const remote = upstream.slice(0, upstream.indexOf('/'));
    const rename = await confirmAction(
      `"${current}" is published as ${upstream}. Rename it on ${remote} too?`,
      'Rename on Remote',
    );
    if (rename) {
      // publishes under the new name and starts tracking it; the old remote name is untouched
      await withRecovery(ctx, () => ctx.git.pushTo(remote));
      // optional: offer deleteRemoteBranchPipeline-style cleanup for the old name afterward
    }
  }
  ctx.notices.report(result, `Renamed to ${name}.`);
}

export async function checkoutDetachedPipeline(ctx: GitPipelineContext): Promise<void> {
  await ctx.git.loadBranches();
  const ref = await ctx.dialogs.pickBranch(
    'Checkout detached',
    ctx.git.branchList().filter((b) => !b.current),
    { submitLabel: 'Checkout' },
  );
  if (!ref) return;
  const result = await ctx.git.checkoutDetached(ref);
  ctx.notices.report(result, `Detached at ${ref}.`);
}
