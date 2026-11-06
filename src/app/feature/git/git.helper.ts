import { inject, WritableSignal } from '@angular/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { firstValueFrom } from 'rxjs';
import { GitFileStatus } from './parser/git-status.parser';
import { GitResult, GitService } from './services/git.service';
import { DialogService } from '../../core/services/dialog/dialog.service';
import { GitIdentityDialog } from './git-identity-dialog';

export interface GitUiFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!';
  /** The git record this row stands for (what the actions operate on). */
  source: GitFileStatus;
}

const CHANGE_LETTERS = ['M', 'A', 'D', 'R', 'C', 'T'];

export const sideLetter = (c: string) =>
  (CHANGE_LETTERS.includes(c) ? c : 'M') as GitUiFile['status'];

export const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

export function confirm(message: string, okLabel: string) {
  return ask(message, {
    title: 'Source Control',
    kind: 'warning',
    okLabel,
    cancelLabel: 'Cancel',
  });
}

export function statusLabel(status: GitUiFile['status']): string {
  return {
    M: 'Modified',
    A: 'Added',
    D: 'Deleted',
    R: 'Renamed',
    C: 'Copied',
    T: 'Type changed',
    U: 'Untracked',
    '!': 'Conflict',
  }[status];
}

/**
 * Manages notice state and auto-dismiss timer for git operations.
 */
export class GitNoticeManager {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private notice: WritableSignal<{ kind: 'error' | 'info'; text: string } | null>) {}

  /**
   * Reports the result of a git operation, showing error or success message.
   */
  report(result: GitResult, success?: string) {
    clearTimeout(this.timer);
    if (!result.ok) {
      this.notice.set({ kind: 'error', text: result.error || 'Git reported an error.' });
      return;
    }
    if (success) {
      this.notice.set({ kind: 'info', text: success });
      this.timer = setTimeout(() => this.notice.set(null), 4000);
    } else {
      this.notice.set(null);
    }
  }

  /**
   * Runs a git action and reports the result.
   */
  async runAction(action: () => Promise<GitResult>, success: string) {
    this.report(await action(), success);
  }

  /**
   * Clears any active timer (useful for cleanup).
   */
  clear() {
    clearTimeout(this.timer);
  }
}

/**
 * Opens the git identity dialog.
 * @returns true if an identity was saved, false if the user cancelled.
 */
export async function openGitIdentityDialog(): Promise<boolean> {
  const git = inject(GitService);
  const dialog = inject(DialogService);

  const current = await git.getIdentity();
  const ref = dialog.open(GitIdentityDialog, {
    title: 'Your Git identity',
    data: current,
  });
  return !!(await firstValueFrom(ref.closed));
}

/**
 * Opens the git identity dialog and sets a notice on success.
 * @param notice Signal to set the success message
 * @returns true if an identity was saved, false if the user cancelled.
 */
export async function editGitIdentity(
  notice: WritableSignal<{ kind: 'error' | 'info'; text: string } | null>,
): Promise<boolean> {
  const result = await openGitIdentityDialog();
  if (result) {
    notice.set({ kind: 'info', text: 'Git identity saved.' });
  }
  return result;
}

export function statusClass(status: GitUiFile['status']): string {
  const map: Record<string, string> = {
    M: '#382f1c;color:#e2c27b',
    A: '#1f2a1e;color:#b9d2ae',
    D: '#3a1f1f;color:#e8a5a5',
    R: '#2a2f3a;color:#a5c7e8',
    C: '#2f2a3a;color:#c7a5e8',
    T: '#3a2f2a;color:#e8c7a5',
    U: '#2a2a2a;color:#b0b0b0',
  };
  return map[status] || map['M'];
}
