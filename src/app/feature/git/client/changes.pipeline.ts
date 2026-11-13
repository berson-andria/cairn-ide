import { GitFileStatus } from '../parser/status.parser';
import { confirmAction } from '../ui/git-dialogs';
import { GitPipelineContext } from './context';

/** Throws away unstaged changes. Staged changes are untouched (unstage them first to discard those too). */
export async function discardPipeline(
  ctx: GitPipelineContext,
  files: GitFileStatus[] = [],
): Promise<void> {
  const count = ctx.git.unstaged().length;
  if (!count) return;
  const ok = await confirmAction(
    `Discard changes in ${count} file(s)? This cannot be undone.`,
    'Discard',
  );
  if (!ok) return;
  files = files.length > 0 ? files : ctx.git.unstaged();
  const result = await ctx.git.discard(files);
  ctx.notices.report(result, 'Changes discarded.');
}

/** Keeps the commit's changes staged, so nothing is lost. */
export async function undoLastCommitPipeline(ctx: GitPipelineContext): Promise<void> {
  if (!(await confirmAction('Undo the last commit? Its changes stay staged.', 'Undo Commit')))
    return;
  const result = await ctx.git.undoLastCommit();
  ctx.notices.report(result, 'Last commit undone.');
}
