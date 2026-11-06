import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { DIALOG_STYLES, plural } from './dialog-shared';

export type SwitchStrategy = 'stash' | 'carry' | 'discard';

@Component({
  selector: 'app-switch-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Switch to {{ target() }}?</h2>

    <p>
      You have {{ changeCount() }} uncommitted {{ plural(changeCount(), 'change', 'changes') }}.
    </p>

    <fieldset class="fs">
      <legend class="sr-only">What to do with your changes</legend>

      <label class="check">
        <input
          type="radio"
          name="switch-strategy"
          [checked]="strategy() === 'stash'"
          (change)="strategy.set('stash')"
        />
        Stash and switch <span class="hint">restore them later</span>
      </label>

      <label class="check">
        <input
          type="radio"
          name="switch-strategy"
          [checked]="strategy() === 'carry'"
          (change)="strategy.set('carry')"
        />
        Bring changes along <span class="hint">may conflict</span>
      </label>

      <label class="check check--danger">
        <input
          type="radio"
          name="switch-strategy"
          [checked]="strategy() === 'discard'"
          (change)="strategy.set('discard')"
        />
        Discard changes and switch
      </label>
    </fieldset>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action" (click)="confirmed.emit(strategy())">
        Switch Branch
      </button>
    </div>
  `,
  styles: [
    DIALOG_STYLES,
    `
      .fs {
        margin: 0;
        padding: 0;
        border: 0;
      }
    `,
  ],
})
export class SwitchBranchDialogComponent {
  /** Branch being checked out. */
  readonly target = input.required<string>();
  readonly changeCount = input.required<number>();

  readonly confirmed = output<SwitchStrategy>();
  readonly cancelled = output<void>();

  protected readonly strategy = signal<SwitchStrategy>('stash');
  protected readonly plural = plural;
}
