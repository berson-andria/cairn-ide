export type GitChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted';

export interface GitFileStatus {
  /** Relative to the repository root, '/' separators (git's own style). */
  path: string;
  /** Previous path, for renames and copies. */
  origPath?: string;
  /** Change letter on the staged side ('.' = nothing staged). */
  index: string;
  /** Change letter on the working-tree side ('.' = nothing unstaged). */
  worktree: string;
  kind: GitChangeKind;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

const KIND_BY_LETTER: Record<string, GitChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

/** One badge kind per file. A new file stays "added" even if it was edited again after `git add`. */
function kindFor(index: string, worktree: string): GitChangeKind {
  if (index === 'A') return 'added';
  return KIND_BY_LETTER[worktree !== '.' ? worktree : index] ?? 'modified';
}

/** The first `count` space-separated fields, plus the rest of the line (a path, which may contain spaces). */
function takeFields(line: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const next = line.indexOf(' ', pos);
    if (next === -1) return { fields: [...fields, line.slice(pos)], rest: '' };
    fields.push(line.slice(pos, next));
    pos = next + 1;
  }
  return { fields, rest: line.slice(pos) };
}

function parseHeader(line: string, status: GitStatus): void {
  if (line.startsWith('# branch.head ')) {
    const name = line.slice('# branch.head '.length);
    status.detached = name === '(detached)';
    status.branch = status.detached ? null : name;
  } else if (line.startsWith('# branch.upstream ')) {
    status.upstream = line.slice('# branch.upstream '.length);
  } else if (line.startsWith('# branch.ab ')) {
    const m = /\+(\d+) -(\d+)/.exec(line);
    if (m) {
      status.ahead = Number(m[1]);
      status.behind = Number(m[2]);
    }
  }
}

/**
 * Parses the output of:  git status --porcelain=v2 --branch -z --untracked-files=all
 * With -z every record ends in NUL and paths are raw (no quoting, spaces and unicode are fine).
 * A rename record is followed by one extra NUL-terminated token holding the old path.
 */
export function parseStatusV2(stdout: string): GitStatus {
  const status: GitStatus = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = stdout.split('\0');

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith('# ')) {
      parseHeader(token, status);
      continue;
    }

    switch (token[0]) {
      case '1': {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const { fields, rest } = takeFields(token, 8);
        const [index, worktree] = [fields[1][0], fields[1][1]];
        status.files.push({
          path: rest,
          index,
          worktree,
          kind: kindFor(index, worktree),
          staged: index !== '.',
          unstaged: worktree !== '.',
        });
        break;
      }
      case '2': {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>   then NUL <origPath>
        const { fields, rest } = takeFields(token, 9);
        const [index, worktree] = [fields[1][0], fields[1][1]];
        status.files.push({
          path: rest,
          origPath: tokens[++i],
          index,
          worktree,
          kind: kindFor(index, worktree),
          staged: index !== '.',
          unstaged: worktree !== '.',
        });
        break;
      }
      case 'u': {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>   (merge conflict)
        const { fields, rest } = takeFields(token, 10);
        status.files.push({
          path: rest,
          index: fields[1][0],
          worktree: fields[1][1],
          kind: 'conflicted',
          staged: false,
          unstaged: true,
        });
        break;
      }
      case '?':
        status.files.push({
          path: token.slice(2),
          index: '.',
          worktree: '?',
          kind: 'untracked',
          staged: false,
          unstaged: true,
        });
        break;
      // '!' (ignored files) is never requested.
    }
  }
  return status;
}
