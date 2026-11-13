import { fail, StashScope } from '../services/git.service';
import { confirmAction } from '../ui/git-dialogs';
import { GitPipelineContext } from './context';
import { confirmUnsaved } from './shared';

export async function stashPipeline(
  ctx: GitPipelineContext,
  scope: StashScope = 'all',
  includeUntracked = false,
): Promise<boolean> {
  if (ctx.git.busy()) return false;

  const staged = ctx.git.staged().length;
  const unstaged = ctx.git.unstaged().length;
  const available =
    scope === 'staged' ? staged : scope === 'unstaged' ? unstaged : staged + unstaged;
  if (!available) {
    ctx.notices.report(
      fail(scope === 'staged' ? 'No staged changes to stash.' : 'No changes to stash.'),
    );
    return false;
  }

  if (!(await confirmUnsaved(ctx, 'stash'))) return false;
  const message = await ctx.dialogs.stashMessage(scope, includeUntracked);
  if (message === undefined) return false;

  const labels = {
    all: 'Changes stashed.',
    staged: 'Staged changes stashed.',
    unstaged: 'Unstaged changes stashed.',
  };
  const result = await ctx.git.stash(message, scope, includeUntracked);
  ctx.notices.report(result, labels[scope]);
  return result.ok;
}

/** Latest stash is index 0 (stash@{0}); no picker, as in VS Code. */
export async function stashLatestPipeline(
  ctx: GitPipelineContext,
  action: 'apply' | 'pop',
): Promise<boolean> {
  const result = action === 'apply' ? await ctx.git.stashApply(0) : await ctx.git.stashPop(0);
  ctx.notices.report(result, action === 'apply' ? 'Stash applied.' : 'Stash popped.');
  return result.ok;
}

const STASH_PICK_LABEL: Record<'apply' | 'pop' | 'drop', string> = {
  apply: 'Apply',
  pop: 'Pop',
  drop: 'Drop',
};

export async function stashPickPipeline(
  ctx: GitPipelineContext,
  action: 'apply' | 'pop' | 'drop',
): Promise<boolean> {
  const label = STASH_PICK_LABEL[action];
  const stashes = await ctx.git.stashes();
  const picked = await ctx.dialogs.pick(`${label} stash`, {
    // `s.message`: confirm this matches the field name on GitStash from log.parser.ts
    items: stashes.map((s, i) => ({ value: String(i), label: `stash@{${i}}: ${s.message}` })),
    submitLabel: label,
    danger: action === 'drop',
    emptyText: 'No stashes.',
  });
  if (picked === undefined) return false;

  const index = Number(picked);
  if (
    action === 'drop' &&
    !(await confirmAction(`Drop stash@{${index}}? This cannot be undone.`, 'Drop'))
  ) {
    return false;
  }

  const run = {
    apply: () => ctx.git.stashApply(index),
    pop: () => ctx.git.stashPop(index),
    drop: () => ctx.git.stashDrop(index),
  }[action];
  const result = await run();
  ctx.notices.report(result, `Stash ${action} done.`);
  return result.ok;
}

export async function dropAllStashesPipeline(ctx: GitPipelineContext): Promise<boolean> {
  if (!(await confirmAction('Drop ALL stashes? This cannot be undone.', 'Drop All'))) return false;
  const result = await ctx.git.stashDropAll();
  ctx.notices.report(result, 'All stashes dropped.');
  return result.ok;
}
