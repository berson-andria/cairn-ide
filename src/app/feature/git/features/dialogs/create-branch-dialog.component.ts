import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DIALOG_STYLES } from './dialog-shared';

export interface CreateBranchResult {
  name: string;
  from: string;
  checkout: boolean;
}

@Component({
  selector: 'app-create-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [DIALOG_STYLES],
  template: `
    <h2>Create branch from…</h2>

    <div class="field">
      <label for="cb-name">Branch name</label>
      <div class="input-form" [class.invalid]="exists()">
        <input
          id="cb-name"
          type="text"
          placeholder="e.g. feature/login"
          [value]="name()"
          [attr.aria-invalid]="exists()"
          [attr.aria-describedby]="exists() ? 'cb-name-error' : null"
          (input)="name.set($any($event.target).value)"
          (keydown.enter)="submit()"
        />
      </div>
      @if (exists()) {
        <div class="error" id="cb-name-error" role="alert">
          A branch named “{{ trimmedName() }}” already exists.
        </div>
      }
    </div>

    <div class="field">
      <label for="cb-from">Create from</label>
      <div class="input-form">
        <input
          id="cb-from"
          type="text"
          [value]="from()"
          (input)="fromOverride.set($any($event.target).value)"
        />
      </div>
    </div>

    <label class="check">
      <input
        type="checkbox"
        [checked]="checkout()"
        (change)="checkout.set($any($event.target).checked)"
      />
      Check out the new branch
    </label>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action" [disabled]="!canSubmit()" (click)="submit()">
        Create Branch
      </button>
    </div>
  `,
})
export class CreateBranchDialogComponent {
  /** Names of existing local and remote branches, used for the duplicate check. */
  readonly existingBranches = input<string[]>([]);
  /** Initial value of "Create from". */
  readonly defaultBase = input('main');

  readonly created = output<CreateBranchResult>();
  readonly cancelled = output<void>();

  protected readonly name = signal('');
  protected readonly checkout = signal(true);
  protected readonly fromOverride = signal<string | null>(null);
  protected readonly from = computed(() => this.fromOverride() ?? this.defaultBase());

  protected readonly trimmedName = computed(() => this.name().trim());
  protected readonly exists = computed(
    () => !!this.trimmedName() && this.existingBranches().includes(this.trimmedName()),
  );
  protected readonly canSubmit = computed(
    () => !!this.trimmedName() && !this.exists() && !!this.from().trim(),
  );

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.created.emit({
      name: this.trimmedName(),
      from: this.from().trim(),
      checkout: this.checkout(),
    });
  }
}
