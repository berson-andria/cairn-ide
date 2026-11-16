import { Component, inject } from '@angular/core';
import { DialogService } from '../../core/services/dialog/dialog.service';
import { NewTask } from './new/new-task';

@Component({
  selector: 'empty-task-list',
  template: `
    <div class="empty-state">
      <div class="empty-state__content">
        <svg width="56" height="54" viewBox="0 0 56 54" fill="none" aria-hidden="true">
          <rect x="8" y="36" width="40" height="14" rx="7" fill="var(--color-border)"></rect>
          <rect
            x="14"
            y="20"
            width="28"
            height="13"
            rx="6.5"
            fill="var(--color-border-strong)"
          ></rect>
          <rect
            x="21"
            y="6"
            width="15"
            height="11"
            rx="5.5"
            fill="var(--color-text-secondary)"
          ></rect>
        </svg>
        <div class="empty-state__title">No tasks yet</div>
        <div class="empty-state__description">
          Tasks are small pieces of work you can hand to the model, then review.
        </div>
        <button
          class="btn-action empty-state__button"
          type="button"
          (click)="createTask()"
        >
          New task
        </button>
        <button
          class="btn-primary empty-state__button empty-state__button--secondary"
          type="button"
        >
          Plan in Chat
        </button>
      </div>
    </div>
  `,
  styles: `
    :host {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
    }

    .empty-state {
      flex: 1;
      overflow: hidden;
      margin: auto 0;
    }

    .empty-state__content {
      text-align: center;
      margin: auto;
      padding: var(--space-8);
      max-width: 300px;
    }

    .empty-state__title {
      margin-top: var(--space-14);
      font-size: var(--font-size-prose);
      font-weight: var(--font-weight-medium);
    }

    .empty-state__description {
      margin: var(--space-8) 0 18px;
      color: var(--color-text-muted);
      font-size: var(--font-size-small);
      line-height: var(--line-height-prose);
    }

    .empty-state__button {
      width: 100%;
      border-radius: var(--radius-control);
    }

    .empty-state__button--secondary {
      margin-top: var(--space-8);
    }

    .empty-state__meta {
      margin-top: 14px;
      color: var(--color-text-muted);
      font-size: var(--font-size-label);
    }
  `,
})
export class EmptyTaskList {
  private readonly dialogService = inject(DialogService);

  createTask(): void {
    this.dialogService.open(NewTask, { width: 'min(92vw, 560px)' });
  }
}
