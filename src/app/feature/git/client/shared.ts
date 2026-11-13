import { GitPipelineContext } from './context';

/**
 * Offers to save open editors before an action that reads the files on disk (commit, stash).
 * Resolves to false when the user cancels.
 */
export async function confirmUnsaved(
  ctx: GitPipelineContext,
  action: 'commit' | 'stash',
): Promise<boolean> {
  const count = ctx.dirtyFileCount();
  if (!count) return true;
  const choice = await ctx.dialogs.unsavedChoice(count, action);
  if (!choice) return false;
  if (choice === 'save') {
    await ctx.saveAllOpenFiles();
    await ctx.git.refresh(); // the file watcher may not have caught up yet
  }
  return true;
}
