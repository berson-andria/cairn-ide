import type { DestroyRef, WritableSignal } from '@angular/core';
import type { GitResult } from '../services/git.service';

/** One line of feedback shown under the commit box: what failed (git's own words) or what just happened. */
export interface GitNotice {
  kind: 'error' | 'info';
  text: string;
}

/**
 * Owns a notice signal and its auto-dismiss timer.
 * Pass the component's DestroyRef so a pending timer is cleared when the component goes away:
 *   private notices = new GitNoticeManager(this.notice, inject(DestroyRef));
 */
export class GitNoticeManager {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly notice: WritableSignal<GitNotice | null>,
    destroyRef?: DestroyRef,
  ) {
    destroyRef?.onDestroy(() => this.clear());
  }

  /** Shows the error from a failed result, or `success` (auto-dismissed) when it worked. */
  report(result: GitResult, success?: string) {
    clearTimeout(this.timer);
    if (!result.ok) {
      this.notice.set({ kind: 'error', text: result.error || 'Git reported an error.' });
      return;
    }
    if (success) {
      this.info(success);
    } else {
      this.notice.set(null);
    }
  }

  /** Shows a message that disappears by itself after 4 seconds. */
  info(text: string) {
    clearTimeout(this.timer);
    this.notice.set({ kind: 'info', text });
    this.timer = setTimeout(() => this.notice.set(null), 4000);
  }

  /** Shows an error that stays until dismissed. */
  error(text: string) {
    clearTimeout(this.timer);
    this.notice.set({ kind: 'error', text });
  }

  /** Runs a git action and reports its result. */
  async runAction(action: () => Promise<GitResult>, success: string) {
    this.report(await action(), success);
  }

  /** Cancels a pending auto-dismiss. */
  clear() {
    clearTimeout(this.timer);
  }
}
