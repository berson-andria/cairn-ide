import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NoticeManager } from './notification.service';

/**
 * Renders every current notice as a small stack, bottom-right. Mount this ONCE for the whole
 * app (the app shell / root component) — not per feature, since NoticeManager is a singleton
 * and every report() anywhere in the app lands in the same list.
 */
@Component({
  selector: 'notice-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      position: fixed;
      right: var(--space-16);
      bottom: var(--space-32);
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      z-index: 2000;
      pointer-events: none;
    }
    .notice {
      display: flex;
      align-items: center;
      gap: var(--space-10);
      max-width: 360px;
      padding: var(--space-10) var(--space-12);
      border-radius: var(--radius-chip);
      background: var(--color-surface-raised);
      color: var(--color-text-primary);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      pointer-events: auto;
    }
    .notice.error {
      border-left: 3px solid var(--color-error-fg);
    }
    .notice.info {
      border-left: 3px solid var(--color-action);
    }
    .text {
      flex: 1;
      font-size: var(--font-size-ui);
      white-space: pre-line; /* withRecovery's ssh message has a blank line in it */
    }
    .close {
      opacity: 0.6;
      padding: 0 var(--space-4);
    }
    .close:hover {
      opacity: 1;
    }
  `,
  template: `
    @for (n of notices.notices(); track n.id) {
      <div class="notice" [class]="n.kind" role="status">
        <span class="text">{{ n.text }}</span>
        <button type="button" class="close" (click)="notices.dismiss(n.id)" aria-label="Dismiss">
          ✕
        </button>
      </div>
    }
  `,
})
export class NoticeList {
  protected readonly notices = inject(NoticeManager);
}
