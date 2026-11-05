// Parsers for the other git outputs the UI needs. Each is paired with the exact --format string that
// produces what it parses, so the two can't drift apart.

// ───────────── branches ─────────────

export interface GitBranch {
  /** "main" or "origin/main" */
  name: string;
  fullName: string;
  remote: boolean;
  current: boolean;
  /** "origin/main" for a local branch that tracks one. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The branch it tracked was deleted on the remote. */
  gone: boolean;
  hash: string;
  subject: string;
}

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
// ───────────── blame ─────────────

export interface BlameCommit {
  hash: string;
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  summary: string;
  /** The all-zero "commit" git uses for lines that are not committed yet (also for unsaved buffer text). */
  uncommitted: boolean;
}

export interface BlameLine {
  hash: string;
  /** The line as git saw it, without its line ending. Compared with the editor's text to spot edits made since. */
  text: string;
}

export interface FileBlame {
  commits: Map<string, BlameCommit>;
  /** Index = line number - 1. */
  lines: BlameLine[];
}

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * Parses `git blame --porcelain`. Each line has a header ("<hash> <orig> <final> [<group size>]") and, after the
 * metadata, a content line starting with a TAB. Metadata (author, summary...) is only printed the FIRST time a
 * commit appears, so it is stored per commit and looked up by hash.
 */
export function parseBlame(stdout: string): FileBlame {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];
  let hash = '';
  let finalLine = 0;

  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('\t')) {
      lines[finalLine - 1] = { hash, text: raw.slice(1).replace(/\r$/, '') };
      continue;
    }
    const header = BLAME_HEADER.exec(raw);
    if (header) {
      hash = header[1];
      finalLine = Number(header[2]);
      if (!commits.has(hash)) {
        commits.set(hash, {
          hash,
          author: '',
          email: '',
          time: 0,
          summary: '',
          uncommitted: /^0+$/.test(hash),
        });
      }
      continue;
    }
    const commit = commits.get(hash);
    if (!commit) continue;
    if (raw.startsWith('author ')) commit.author = raw.slice('author '.length);
    else if (raw.startsWith('author-mail '))
      commit.email = raw.slice('author-mail '.length).replace(/^<|>$/g, '');
    else if (raw.startsWith('author-time ')) commit.time = Number(raw.slice('author-time '.length));
    else if (raw.startsWith('summary ')) commit.summary = raw.slice('summary '.length);
  }
  return { commits, lines };
}

// ───────────── stashes ─────────────

export interface GitStash {
  index: number;
  /** "stash@{0}" */
  ref: string;
  message: string;
  /** "3 hours ago" */
  age: string;
}

export const STASH_FORMAT = '--format=%gd%x00%gs%x00%cr';

export function parseStashes(stdout: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [ref, message, age] = line.split('\0');
    const index = /stash@\{(\d+)\}/.exec(ref ?? '')?.[1];
    if (index === undefined) continue;
    stashes.push({ index: Number(index), ref, message: message ?? '', age: age ?? '' });
  }
  return stashes;
}
export interface GitStash {
  index: number;
  /** "stash@{0}" */
  ref: string;
  message: string;
  /** "3 hours ago" */
  age: string;
}

// ───────────── history ─────────────

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601 */
  date: string;
  subject: string;
}

export const LOG_FORMAT = '--format=%H%x00%h%x00%an%x00%aI%x00%s';

export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [hash, shortHash, author, date, subject] = line.split('\0');
    if (hash) commits.push({ hash, shortHash, author, date, subject: subject ?? '' });
  }
  return commits;
}
export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601 */
  date: string;
  subject: string;
}
// ───────────── commit details ─────────────

export type CommitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange';

export interface CommitFile {
  status: CommitFileStatus;
  /** Repository-relative path, "/" separators (the new path for renames). */
  path: string;
  /** Only for renamed/copied: the path in the parent commit. */
  oldPath?: string;
}

export interface CommitDetails {
  hash: string;
  shortHash: string;
  author: string;
  /** ISO 8601 */
  date: string;
  subject: string;
  /** Full message, subject included. */
  message: string;
  files: CommitFile[];
}

/** Header fields are NUL-separated; %x01 marks the end of the header (a message body can't contain it). */
export const COMMIT_DETAILS_FORMAT = '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%B%x01';

const STATUS_BY_LETTER: Record<string, CommitFileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

/** Parses `git show -z --name-status <COMMIT_DETAILS_FORMAT>`. */
export function parseCommitDetails(stdout: string): CommitDetails | null {
  const split = stdout.indexOf('\x01');
  if (split < 0) return null;

  const [hash, shortHash, author, date, subject, message] = stdout.slice(0, split).split('\0');
  if (!hash) return null;

  // After the header: "\n" or "\0", then "<status>\0<path>\0" (renames/copies: "<status>\0<old>\0<new>\0").
  const tokens = stdout
    .slice(split + 1)
    .replace(/^[\r\n\0]+/, '')
    .split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  const files: CommitFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const letter = tokens[i][0];
    const status = STATUS_BY_LETTER[letter];
    if (!status) {
      i++; // not a status token: skip it instead of getting out of step
      continue;
    }
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (path !== undefined) files.push({ status, path, oldPath });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path !== undefined) files.push({ status, path });
      i += 2;
    }
  }

  return {
    hash,
    shortHash,
    author,
    date,
    subject,
    message: (message ?? '').trim(),
    files,
  };
}
// Parsers for the other git outputs the UI needs. Each is paired with the exact --format string that
// produces what it parses, so the two can't drift apart.

// ───────────── branches ─────────────

export interface GitBranch {
  /** "main" or "origin/main" */
  name: string;
  fullName: string;
  remote: boolean;
  current: boolean;
  /** "origin/main" for a local branch that tracks one. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The branch it tracked was deleted on the remote. */
  gone: boolean;
  hash: string;
  subject: string;
}

// ───────────── blame ─────────────

export interface BlameCommit {
  hash: string;
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  summary: string;
  /** The all-zero "commit" git uses for lines that are not committed yet (also for unsaved buffer text). */
  uncommitted: boolean;
}

export interface BlameLine {
  hash: string;
  /** The line as git saw it, without its line ending. Compared with the editor's text to spot edits made since. */
  text: string;
}

export interface FileBlame {
  commits: Map<string, BlameCommit>;
  /** Index = line number - 1. */
  lines: BlameLine[];
}
