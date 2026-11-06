import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DIALOG_STYLES } from './dialog-shared';

export interface AddRemoteResult {
  name: string;
  url: string;
}

@Component({
  selector: 'app-add-remote-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [DIALOG_STYLES],
  template: `
    <h2>Add remote</h2>

    <div class="field">
      <label for="ar-name">Name</label>
      <div class="input-form">
        <input
          id="ar-name"
          type="text"
          [value]="name()"
          (input)="nameOverride.set($any($event.target).value)"
        />
      </div>
    </div>

    <div class="field">
      <label for="ar-url">URL</label>
      <div class="input-form">
        <input
          id="ar-url"
          type="text"
          placeholder="https://github.com/owner/repo.git"
          [value]="url()"
          (input)="url.set($any($event.target).value)"
          (keydown.enter)="submit()"
        />
      </div>
    </div>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action" [disabled]="!canSubmit()" (click)="submit()">
        Add Remote
      </button>
    </div>
  `,
})
export class AddRemoteDialogComponent {
  /** Pre-filled remote name. */
  readonly initialName = input('');

  readonly added = output<AddRemoteResult>();
  readonly cancelled = output<void>();

  protected readonly nameOverride = signal<string | null>(null);
  protected readonly name = computed(() => this.nameOverride() ?? this.initialName());
  protected readonly url = signal('');

  protected readonly canSubmit = computed(() => !!this.name().trim() && !!this.url().trim());

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.added.emit({ name: this.name().trim(), url: this.url().trim() });
  }
}
