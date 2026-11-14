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
// Paste into parser/log.parser.ts, right after parseLog(). Nothing else in that file changes.

// ───────────── graph ─────────────

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface GraphRef {
  name: string;
  kind: RefKind;
  /** The branch (or detached HEAD) that is checked out right now. */
  current: boolean;
}

/** A history commit plus what the graph needs: its parents and the branches/tags pointing at it. */
export interface GraphCommit extends GitCommit {
  parents: string[];
  refs: GraphRef[];
}

/**
 * LOG_FORMAT's five fields first, then parents and ref names, so parseLog still reads the
 * first five. Run it with `--decorate=full`: that is what tells local branches, remote
 * branches and tags apart in %D.
 */
export const GRAPH_FORMAT = `${LOG_FORMAT}%x00%P%x00%D`;

function parseRefs(raw: string): GraphRef[] {
  if (!raw) return [];
  const refs: GraphRef[] = [];
  for (const part of raw.split(', ')) {
    if (part.startsWith('HEAD -> refs/heads/')) {
      refs.push({ name: part.slice('HEAD -> refs/heads/'.length), kind: 'local', current: true });
    } else if (part === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head', current: true }); // detached
    } else if (part.startsWith('tag: refs/tags/')) {
      refs.push({ name: part.slice('tag: refs/tags/'.length), kind: 'tag', current: false });
    } else if (part.startsWith('refs/heads/')) {
      refs.push({ name: part.slice('refs/heads/'.length), kind: 'local', current: false });
    } else if (part.startsWith('refs/remotes/')) {
      const name = part.slice('refs/remotes/'.length);
      if (!name.endsWith('/HEAD')) refs.push({ name, kind: 'remote', current: false });
    }
    // anything else (refs/stash, notes...) is not shown
  }
  const order: Record<RefKind, number> = { head: 0, local: 1, remote: 2, tag: 3 };
  return refs.sort(
    (a, b) => Number(b.current) - Number(a.current) || order[a.kind] - order[b.kind],
  );
}

export function parseGraphLog(stdout: string): GraphCommit[] {
  const commits: GraphCommit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [hash, shortHash, author, date, subject, parents, decorations] = line.split('\0');
    if (!hash) continue;
    commits.push({
      hash,
      shortHash,
      author,
      date,
      subject: subject ?? '',
      parents: parents ? parents.split(' ') : [],
      refs: parseRefs(decorations ?? ''),
    });
  }
  return commits;
}
