// Types and constants shared by more than one parser. Parsers import from here, never from each other.

/** What happened to a file (the kinds that can appear in a commit). */
export type FileChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange';

/** Every kind a file can have in `git status`: a commit's kinds plus two that only exist in the working tree. */
export type GitChangeKind = FileChangeKind | 'untracked' | 'conflicted';

/** git's one-letter status -> kind. Used for `git status` and for `git show --name-status`. */
export const KIND_BY_LETTER: Record<string, FileChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
};

/** A path, plus where it came from if it was renamed or copied. */
export interface ChangedPath {
  /** Relative to the repository root, '/' separators (git's own style). For renames: the new path. */
  path: string;
  /** Previous path, for renames and copies. */
  origPath?: string;
}

/** Branch tracking info, shared by `git status` and branch lists. */
export interface Tracking {
  /** "origin/main" when the branch tracks one. */
  upstream: string | null;
  ahead: number;
  behind: number;
}
