import { Component, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBoneFracture } from '@ng-icons/lucide';
import { WorkflowService } from '../../../core/services/runs/workflow.service';
import { TitleCasePipe } from '@angular/common';
import { DialogRef } from '@angular/cdk/dialog';

@Component({
  template: `
    <div class="container">
      <div class="row">
        <div class="header">
          <span class="icon">
            <ng-icon name="lucideBoneFracture" />
          </span>
          <h2>No Workflow Entry Point.</h2>
        </div>
        <p>
          <span
            >This project has a workflow files/folder, but it has no <code>main.py</code> entry
            point. <br />
            Cairn needs <code>.cairn/workflows/main.py</code> to start a run.
          </span>
        </p>
        <div class="solution">Use another workflow or edit local workflow:</div>
        <div class="options">
          @for (option of workflow.status()?.sources; track $index) {
            @if (option.status === 'ok') {
              <div
                class="option"
                [class.active]="choice() === option.source"
                (click)="choseOption(option.source)"
              >
                <span>{{ option.source | titlecase }}</span>
                <span class="action">Use</span>
              </div>
            }
          }
          <div
            class="option"
            [class.active]="choice() === 'project'"
            (click)="choseOption('project')"
          >
            <span>Local</span>
            <span class="action">Setup (Create & Edit Local workflow)</span>
          </div>
        </div>
      </div>
      <div class="btn-group">
        <button class="btn-primary" (click)="cancel()">Cancel</button>
        <button class="btn-action" [disabled]="!choice()">Confirm</button>
      </div>
    </div>
  `,
  styles: `
    .container {
      padding: var(--space-8) var(--space-10);
      color: var(--color-text-secondary);
    }
    .header {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--space-12);
      color: var(--color-text-primary);
      span.icon {
        padding: var(--space-4);
        border-radius: var(--radius-chip);
        background: var(--color-error-bg);
        color: var(--color-error-fg);
        ng-icon {
          font-size: var(--font-size-section-title);
        }
      }
    }
    p {
      file-icon {
        margin: var(--space-4);
      }
    }
    code {
      background-color: var(--color-surface-raised-hover);
      padding: 0 var(--space-2);
      border-radius: var(--radius-chip);
      color: var(--color-text-primary);
      font-weight: bold;
    }
    .options {
      background: var(--color-surface-base);
      margin: var(--space-10) 0;
      border-radius: var(--radius-chip);
      border: 1px solid var(--color-border);
      padding: var(--space-4);
    }
    .option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-6);
      border-radius: var(--radius-chip);
      cursor: pointer;
      &.active {
        background: var(--color-surface-hover);
      }
      &:hover {
        background-color: var(--color-surface-hover);
      }
    }
    .btn-group {
      display: flex;
      justify-content: end;
      gap: var(--space-10);
      margin-top: var(--space-16);
    }
    .action {
      color: var(--color-text-muted);
    }
  `,
  imports: [NgIcon, TitleCasePipe],
  providers: [provideIcons({ lucideBoneFracture })],
})
export class NoEntry {
  readonly workflow = inject(WorkflowService);
  private readonly ref = inject<DialogRef>(DialogRef);

  choice = signal<string | null>(null);
  cancel() {
    this.ref.close();
  }
  choseOption(option: string) {
    this.choice.set(option);
  }

  confirm() {}
}
