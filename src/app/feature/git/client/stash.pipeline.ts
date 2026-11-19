import { fail, StashScope } from '../services/git.service';
import type { GitStash } from '../parser/log.parser';
import { confirmAction } from '../ui/git-dialogs';
import { GitPipelineContext } from './context';
import { confirmUnsaved } from './shared';

export interface StashOptions {
  /** undefined = ask with the message dialog (palette/keyboard); '' = stash with git's default message. */
  message?: string;
  scope?: StashScope; // 'all' | 'staged'
  includeUntracked?: boolean;
  keepIndex?: boolean;
}

type StashAction = 'apply' | 'pop' | 'drop';

const STASHED_LABEL: Record<StashScope, string> = {
  all: 'Changes stashed.',
  staged: 'Staged changes stashed.',
};

const DONE_LABEL: Record<StashAction, string> = {
  apply: 'Stash applied.',
  pop: 'Stash popped.',
  drop: 'Stash dropped.',
};

export async function stashPipeline(
  ctx: GitPipelineContext,
  options: StashOptions = {},
): Promise<boolean> {
  if (ctx.git.busy()) return false;

  const scope = options.scope ?? 'all';
  const includeUntracked = options.includeUntracked ?? false;

  const staged = ctx.git.staged().length;
  const unstaged = ctx.git.unstaged().length;
  const available = scope === 'staged' ? staged : staged + unstaged;
  if (!available) {
    ctx.notices.report(
      fail(scope === 'staged' ? 'No staged changes to stash.' : 'No changes to stash.'),
    );
    return false;
  }

  if (!(await confirmUnsaved(ctx, 'stash'))) return false;

  const message =
    options.message ?? (await ctx.dialogs.stashMessage(scope, includeUntracked, options.keepIndex));
  if (message === undefined) return false;

  const result = await ctx.git.stash({
    message,
    scope,
    includeUntracked,
    keepIndex: options.keepIndex,
  });
  ctx.notices.report(result, STASHED_LABEL[scope]);
  return result.ok;
}

/** The one place pop/apply/drop run, whoever chose the stash (row button, latest, picker). */
export async function stashActPipeline(
  ctx: GitPipelineContext,
  action: StashAction,
  stash: GitStash,
): Promise<boolean> {
  if (ctx.git.busy()) return false;

  if (action === 'drop') {
    const name = stash.message || stash.ref;
    if (!(await confirmAction(`Drop "${name}"? This cannot be undone.`, 'Drop'))) return false;
  } else {
    const dirty = ctx.dirtyFileCount();
    if (
      dirty &&
      !(await confirmAction(
        `${dirty} file${dirty === 1 ? ' has' : 's have'} unsaved changes, and ${
          action === 'pop' ? 'popping' : 'applying'
        } a stash changes files on disk. Continue?`,
        action === 'pop' ? 'Pop' : 'Apply',
      ))
    ) {
      return false;
    }
  }

  const run = {
    apply: () => ctx.git.stashApply(stash.hash),
    pop: () => ctx.git.stashPop(stash.hash),
    drop: () => ctx.git.stashDrop(stash.hash),
  }[action];

  const result = await run();
  ctx.notices.report(result, DONE_LABEL[action]);
  return result.ok;
}

/** Latest stash, no picker, as in VS Code. */
export async function stashLatestPipeline(
  ctx: GitPipelineContext,
  action: 'apply' | 'pop',
): Promise<boolean> {
  const [latest] = await ctx.git.stashes();
  if (!latest) {
    ctx.notices.report(fail('No stashes.'));
    return false;
  }
  return stashActPipeline(ctx, action, latest);
}

const STASH_PICK_LABEL: Record<StashAction, string> = {
  apply: 'Apply',
  pop: 'Pop',
  drop: 'Drop',
};

export async function stashPickPipeline(
  ctx: GitPipelineContext,
  action: StashAction,
): Promise<boolean> {
  const label = STASH_PICK_LABEL[action];
  const stashes = await ctx.git.stashes();
  const picked = await ctx.dialogs.pick(`${label} stash`, {
    items: stashes.map((s) => ({
      value: s.hash,
      label: `${s.ref}: ${s.message}${s.branch ? ` (${s.branch})` : ''}`,
    })),
    submitLabel: label,
    danger: action === 'drop',
    emptyText: 'No stashes.',
  });
  if (picked === undefined) return false;

  const stash = stashes.find((s) => s.hash === picked);
  return stash ? stashActPipeline(ctx, action, stash) : false;
}

export async function dropAllStashesPipeline(ctx: GitPipelineContext): Promise<boolean> {
  if (!(await confirmAction('Drop ALL stashes? This cannot be undone.', 'Drop All'))) return false;
  const result = await ctx.git.stashDropAll();
  ctx.notices.report(result, 'All stashes dropped.');
  return result.ok;
}
