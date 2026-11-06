import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DIALOG_STYLES } from './dialog-shared';

export interface CloneRepoResult {
  url: string;
  directory: string;
}

@Component({
  selector: 'app-clone-repo-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [DIALOG_STYLES],
  template: `
    <h2>Clone repository</h2>

    <div class="field">
      <label for="cr-url">Repository URL</label>
      <div class="input-form">
        <input
          id="cr-url"
          type="text"
          placeholder="https://github.com/owner/repo.git"
          [value]="url()"
          (input)="url.set($any($event.target).value)"
          (keydown.enter)="submit()"
        />
      </div>
    </div>

    <div class="field">
      <label for="cr-dir">Clone into</label>
      <div class="input-form">
        <input
          id="cr-dir"
          type="text"
          [value]="directory()"
          (input)="directoryOverride.set($any($event.target).value)"
          (keydown.enter)="submit()"
        />
      </div>
    </div>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action" [disabled]="!canSubmit()" (click)="submit()">
        Clone
      </button>
    </div>
  `,
})
export class CloneRepoDialogComponent {
  /** Pre-filled destination folder. */
  readonly defaultDirectory = input('~/dev');

  readonly cloned = output<CloneRepoResult>();
  readonly cancelled = output<void>();

  protected readonly url = signal('');
  protected readonly directoryOverride = signal<string | null>(null);
  protected readonly directory = computed(() => this.directoryOverride() ?? this.defaultDirectory());

  protected readonly canSubmit = computed(() => !!this.url().trim() && !!this.directory().trim());

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.cloned.emit({ url: this.url().trim(), directory: this.directory().trim() });
  }
}
