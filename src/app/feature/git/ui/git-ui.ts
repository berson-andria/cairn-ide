import type { GitFileStatus } from '../parser/status.parser';
import type { GitDiffMode } from '../services/git-diff.service';

/** The one-letter badge shown next to a file. 'U' = untracked, '!' = conflict. */
export type GitUiStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!';

/** One row in the Staged / Changes / Merge Conflicts lists. */
export interface GitUiFile {
  path: string;
  status: GitUiStatus;
  /** The git record this row stands for (what the actions operate on). */
  source: GitFileStatus;
  /**
   * The list this row is in. A file with both staged and unstaged changes has a row in EACH list,
   * backed by the same `source`, so only this tells them apart (it decides which diff opens).
   */
  mode: GitDiffMode;
}

/** The first line of git's output, for a one-line notice ("Already up to date." instead of a whole log). */
export const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? '';

const CHANGE_LETTERS = ['M', 'A', 'D', 'R', 'C', 'T'];

/** git's letter for one side of a change -> a badge letter (anything unexpected shows as 'M'). */
export const sideLetter = (letter: string): GitUiStatus =>
  (CHANGE_LETTERS.includes(letter) ? letter : 'M') as GitUiStatus;

const LABELS: Record<GitUiStatus, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Untracked',
  '!': 'Conflict',
};

export const statusLabel = (status: GitUiStatus): string => LABELS[status];

const COLORS: Record<GitUiStatus, { background: string; color: string }> = {
  M: {
    background: 'color-mix(in srgb, var(--color-warning-fg) 35%, transparent)',
    color: 'color-mix(in srgb, var(--color-warning-fg) 50%, var(--color-text-primary))',
  },
  A: {
    background: 'color-mix(in srgb, var(--color-status-done) 35%, transparent)',
    color: 'color-mix(in srgb, var(--color-status-done) 50%, var(--color-text-primary))',
  },
  D: {
    background: 'color-mix(in srgb, var(--color-status-blocked) 35%, transparent)',
    color: 'color-mix(in srgb, var(--color-status-blocked) 50%, var(--color-text-primary))',
  },
  R: {
    background: 'color-mix(in srgb, var(--color-status-running) 35%, transparent)',
    color: 'color-mix(in srgb, var(--color-status-running) 50%, var(--color-text-primary))',
  },
  C: {
    background: 'color-mix(in srgb, var(--hue-purple) 35%, transparent)',
    color: 'color-mix(in srgb, var(--hue-purple) 50%, var(--color-text-primary))',
  },
  T: {
    background: 'color-mix(in srgb, var(--hue-orange) 35%, transparent)',
    color: 'color-mix(in srgb, var(--hue-orange) 50%, var(--color-text-primary))',
  },
  U: {
    background: 'color-mix(in srgb, var(--color-status-done) 35%, transparent)',
    color: 'color-mix(in srgb, var(--color-status-done) 50%, var(--color-text-primary))',
  },
  '!': {
    background: 'color-mix(in srgb, var(--hue-red) 45%, transparent)',
    color: 'color-mix(in srgb, var(--hue-red) 50%, var(--color-text-primary))',
  },
};
export const statusStyle = (status: GitUiStatus | string): { background: string; color: string } =>
  COLORS[status] ?? COLORS.M;
