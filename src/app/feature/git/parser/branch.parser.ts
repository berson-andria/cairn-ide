import { Tracking } from './git-types';

export interface GitBranch extends Tracking {
  /** "main" or "origin/main" */
  name: string;
  fullName: string;
  remote: boolean;
  current: boolean;
  /** The branch it tracked was deleted on the remote. */
  gone: boolean;
  hash: string;
  subject: string;
}

/** Pass to `git branch -a`. Each parser here is paired with the exact --format string that produces its input. */
export const BRANCH_FORMAT =
  '--format=%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(objectname:short)%00%(contents:subject)';

export function parseBranches(stdout: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [head, fullName, name, upstream, track, hash, subject] = line.split('\0');
    // A detached HEAD shows up as "(HEAD detached at ...)" with no refname: it is not a branch.
    if (!fullName) continue;
    const remote = fullName.startsWith('refs/remotes/');
    if (!remote && !fullName.startsWith('refs/heads/')) continue;
    if (remote && fullName.endsWith('/HEAD')) continue; // origin/HEAD is an alias, not a branch

    branches.push({
      name,
      fullName,
      remote,
      current: head === '*',
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
      gone: (track ?? '').includes('gone'),
      hash: hash ?? '',
      subject: subject ?? '',
    });
  }
  return branches;
}
