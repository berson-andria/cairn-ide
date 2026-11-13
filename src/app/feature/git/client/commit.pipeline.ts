import { confirmAction } from '../ui/git-dialogs';
import { GitPipelineContext } from './context';
import { confirmUnsaved } from './shared';
import { withRecovery } from './recovery';
import { fail } from '../services/git.service';

export type CommitMode = 'staged' | 'all' | 'amend';

/**
 * `draft` is text already typed in a commit box. Resolves to true when a commit was made, so the
 * caller can clear its box. Every prompt runs before anything touches the repository, so
 * cancelling at any point changes nothing.
 */
export async function commitPipeline(
  ctx: GitPipelineContext,
  mode: CommitMode,
  draft = '',
): Promise<boolean> {
  if (ctx.git.busy()) return false;
  const amend = mode === 'amend';

  // 1. Unsaved editors first: saving changes what git sees, and the checks below depend on it.
  if (!(await confirmUnsaved(ctx, 'commit'))) return false;

  // 2. What goes into the commit.
  let stageAll = false;
  if (!amend) {
    const hasStaged = ctx.git.staged().length > 0;
    const hasUnstaged = ctx.git.unstaged().length > 0;
    if (!hasStaged && !hasUnstaged) {
      ctx.notices.report(fail('Nothing to commit.'));
      return false;
    }
    if (mode === 'all') {
      stageAll = hasUnstaged;
    } else if (!hasStaged) {
      const ok = await confirmAction(
        'There are no staged changes. Stage all changes and commit them?',
        'Stage All & Commit',
      );
      if (!ok) return false;
      stageAll = true;
    }
  } else {
    const s = ctx.git.status();
    const pushed = !!s?.upstream && s.ahead === 0;
    if (
      pushed &&
      !(await confirmAction(
        'This commit is already pushed. Amending it means you will have to force push. Continue?',
        'Amend',
      ))
    ) {
      return false;
    }
  }

  // 3. The message: from the box if there is one, otherwise ask.
  const typed = draft.trim();
  const message = amend
    ? await ctx.dialogs.commitMessage({
        amend: true,
        initial: typed || (await ctx.git.lastCommitMessage()),
      })
    : typed || (await ctx.dialogs.commitMessage({ message: 'Enter a commit message.' }));
  if (!message?.trim()) return false; // cancelled

  // 4. Only now change anything. An identity problem asks for name and email, then retries.
  const result = await withRecovery(ctx, async () => {
    if (stageAll) {
      const staged = await ctx.git.stageAll();
      if (!staged.ok) return staged;
    }
    return ctx.git.commit(message.trim(), { amend });
  });
  ctx.notices.report(result, amend ? 'Commit amended.' : 'Committed.');
  return result.ok;
}
