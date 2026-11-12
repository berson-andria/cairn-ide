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
  M: { background: '#382f1c', color: '#e2c27b' },
  A: { background: '#1f2a1e', color: '#b9d2ae' },
  D: { background: '#3a1f1f', color: '#e8a5a5' },
  R: { background: '#2a2f3a', color: '#a5c7e8' },
  C: { background: '#2f2a3a', color: '#c7a5e8' },
  T: { background: '#3a2f2a', color: '#e8c7a5' },
  U: { background: '#2a2a2a', color: '#b0b0b0' },
  '!': { background: '#4a1d24', color: '#ff9aa5' },
};

/**
 * Colors for a badge, as an object for `[style]="statusStyle(file.status)"`.
 * (This replaces `statusClass`, which returned a half-built CSS string that only worked when concatenated
 * into a style attribute, and had no entry for conflicts.)
 */
export const statusStyle = (status: GitUiStatus): { background: string; color: string } =>
  COLORS[status] ?? COLORS.M;
