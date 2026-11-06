import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { DIALOG_STYLES, plural } from './dialog-shared';

export interface DiscardChangesResult {
  deleteUntracked: boolean;
}

@Component({
  selector: 'app-discard-changes-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [DIALOG_STYLES],
  template: `
    <h2>Discard all changes?</h2>

    <p>
      {{ fileCount() }} {{ fileCount() === 1 ? 'file' : 'files' }} with changes will be reverted to
      the last commit. This can’t be undone.
    </p>

    @if (untrackedCount() > 0) {
      <label class="check">
        <input
          type="checkbox"
          [checked]="deleteUntracked()"
          (change)="deleteUntracked.set($any($event.target).checked)"
        />
        Also delete {{ untrackedCount() }} untracked {{ untrackedLabel() }}
      </label>
    }

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action btn-danger" (click)="confirm()">
        Discard {{ fileCount() }} {{ fileCount() === 1 ? 'File' : 'Files' }}
      </button>
    </div>
  `,
})
export class DiscardChangesDialogComponent {
  readonly fileCount = input.required<number>();
  readonly untrackedCount = input(0);

  readonly confirmed = output<DiscardChangesResult>();
  readonly cancelled = output<void>();

  protected readonly deleteUntracked = signal(false);

  protected untrackedLabel(): string {
    return plural(this.untrackedCount(), 'file', 'files');
  }

  protected confirm(): void {
    this.confirmed.emit({ deleteUntracked: this.deleteUntracked() });
  }
}
