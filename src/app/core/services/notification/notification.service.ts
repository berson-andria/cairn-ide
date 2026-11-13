import { Injectable, computed, signal } from '@angular/core';

export type NoticeKind = 'error' | 'info';

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

/**
 * Anything shaped like this can be reported directly — GitResult qualifies structurally, and so
 * does any other result object with at least these two fields. This service never imports
 * GitService or any feature-specific result type: that's what makes it reusable outside git.
 */
export interface ActionOutcome {
  ok: boolean;
  error?: string;
}

const AUTO_DISMISS_MS = 4000;

/**
 * App-wide notice/toast service. Was git-only (GitNoticeManager, one signal per component,
 * constructed with `new` and a DestroyRef); now it's a singleton any feature calls directly.
 *
 * `notices()` is every notice currently visible, oldest first — render it as a toast stack
 * anywhere once (e.g. in the app shell). `latest()` is for a surface that only ever shows one
 * line, such as an inline status strip under a specific control.
 *
 * report()/info()/error() keep the same names GitNoticeManager had, so pipelines that already
 * call `ctx.notices.report(result, 'Done.')` need no change beyond injecting this instead.
 */
@Injectable({ providedIn: 'root' })
export class NoticeManager {
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  readonly notices = signal<Notice[]>([]);
  readonly latest = computed<Notice | null>(() => {
    const list = this.notices();
    return list.length ? list[list.length - 1] : null;
  });

  /**
   * Shows the error from a failed outcome, or `success` (auto-dismissed) when it worked.
   * Shows nothing on a silent success (no `success` given) — unlike the old GitNoticeManager,
   * this never clears other notices, since a global service may be showing several at once for
   * entirely unrelated things.
   */
  report(outcome: ActionOutcome, success?: string): void {
    if (!outcome.ok) {
      this.error(outcome.error || 'Something went wrong.');
      return;
    }
    if (success) this.info(success);
  }

  /** Shows a message that disappears by itself after 4 seconds. Returns its id, for an early dismiss(). */
  info(text: string): number {
    return this.show('info', text, AUTO_DISMISS_MS);
  }

  /** Shows an error that stays until dismissed. */
  error(text: string): number {
    return this.show('error', text, null);
  }

  /** Removes one notice before its timer would have (or an error, which has none). */
  dismiss(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.notices.update((list) => list.filter((n) => n.id !== id));
  }

  /** Removes everything currently shown. */
  clear(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.notices.set([]);
  }

  private show(kind: NoticeKind, text: string, autoDismissMs: number | null): number {
    const id = this.nextId++;
    this.notices.update((list) => [...list, { id, kind, text }]);
    if (autoDismissMs !== null) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), autoDismissMs));
    }
    return id;
  }
}
