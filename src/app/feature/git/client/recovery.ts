import { GitResult } from '../services/git.service';
import { GitPipelineContext } from './context';

/**
 * Runs a git action. If it fails because git doesn't know who you are, asks for the identity
 * and retries once. Logins and passphrases go through askpass, so there is no 'auth' case.
 * A plain function, not a method on GitDialogService: retrying is orchestration, not dialog I/O.
 *
 * Generic over T (extends GitResult) so a call like `clone()`, which returns
 * `GitResult & { path?: string }`, keeps that extra field on the way out instead of being
 * widened to plain GitResult.
 */
export async function withRecovery<T extends GitResult>(
  ctx: GitPipelineContext,
  action: () => Promise<T>,
): Promise<T> {
  const result = await action();

  if (result.code === 'identity') {
    const current = await ctx.git.getIdentity();
    if (!(await ctx.dialogs.identity(current))) {
      return { ...result, error: 'Cancelled: git needs your name and email first.' } as T;
    }
    return action();
  }

  if (result.code === 'ssh') {
    return {
      ...result,
      error: `${result.error}\n\nCheck that this key is added to your account and loaded (ssh-add).`,
    } as T;
  }

  return result;
}
