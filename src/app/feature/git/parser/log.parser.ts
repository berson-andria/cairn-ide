import { ChangedPath, FileChangeKind, KIND_BY_LETTER } from './git-types';

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

// ───────────── commit details ─────────────

export interface CommitFile extends ChangedPath {
  status: FileChangeKind;
}

export interface CommitDetails extends GitCommit {
  /** Full message, subject included. */
  message: string;
  files: CommitFile[];
}

/** Header fields are NUL-separated; %x01 marks the end of the header (a message body can't contain it). */
export const COMMIT_DETAILS_FORMAT = '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%B%x01';

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
    const letter = tokens[i]?.[0] ?? '';
    const status = KIND_BY_LETTER[letter];
    if (!status) {
      i++; // not a status token: skip it instead of getting out of step
      continue;
    }
    if (letter === 'R' || letter === 'C') {
      const origPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (path !== undefined) files.push({ status, path, origPath });
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
