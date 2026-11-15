import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { DIALOG_STYLES } from './dialog-shared';
import { injectDialogData } from './dialog-data';

export interface FormField {
  /** Key of this field in the result object. */
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  /** Optional fields don't block the submit button when empty. */
  optional?: boolean;
  /** Textarea instead of a single-line input (commit message). */
  multiline?: boolean;
  /** Password input: dots instead of text, no autofill, no spellcheck (tokens, passwords). */
  secret?: boolean;
  /** Return an error message, or null when valid. Runs on submit; may be async. */
  validate?: (value: string) => string | null | Promise<string | null>;
}

export interface FormDialogData {
  /** Short sentence above the fields. */
  message?: string;
  fields: FormField[];
  submitLabel: string;
  cancelLabel?: string;
  /** Red submit button, for destructive actions. */
  danger?: boolean;
}

/** Trimmed value of every field, by key. `undefined` when the dialog is cancelled. */
export type FormDialogResult = Record<string, string>;

/**
 * One dialog for every "type one or two values" case: clone, add remote, create / rename branch,
 * stash message, commit message...
 * Open it through GitDialogService.form(); it closes with the values or undefined.
 */
@Component({
  selector: 'app-form-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    DIALOG_STYLES,
    `
      textarea {
        display: block;
        width: 100%;
        box-sizing: border-box;
        min-height: 72px;
        padding: var(--space-6) var(--space-8);
        border: 0;
        outline: none;
        resize: vertical;
        background: transparent;
        color: inherit;
        font: inherit;
      }
    `,
  ],
  template: `
    @if (data.message) {
      <p>{{ data.message }}</p>
    }

    <form (submit)="onSubmit($event)" novalidate>
      @for (f of data.fields; track f.key) {
        <div class="field">
          <label [attr.for]="'fd-' + f.key">{{ f.label }}</label>
          <div class="input-form" [class.invalid]="!!errors()[f.key]">
            @if (f.multiline) {
              <textarea
                [id]="'fd-' + f.key"
                [placeholder]="f.placeholder ?? ''"
                [value]="values()[f.key]"
                (input)="setValue(f.key, $any($event.target).value)"
              ></textarea>
            } @else {
              <input
                [id]="'fd-' + f.key"
                [type]="f.secret ? 'password' : 'text'"
                [attr.autocomplete]="f.secret ? 'new-password' : null"
                [attr.spellcheck]="f.secret ? 'false' : null"
                [placeholder]="f.placeholder ?? ''"
                [value]="values()[f.key]"
                (input)="setValue(f.key, $any($event.target).value)"
              />
            }
          </div>
          @if (errors()[f.key]; as message) {
            <div class="error" role="alert">{{ message }}</div>
          }
        </div>
      }

      <div class="actions">
        <button type="button" class="btn-primary" (click)="cancel()">
          {{ data.cancelLabel ?? 'Cancel' }}
        </button>
        <button
          type="submit"
          class="btn-action"
          [class.btn-danger]="data.danger"
          [disabled]="!canSubmit()"
        >
          {{ data.submitLabel }}
        </button>
      </div>
    </form>
  `,
})
export class FormDialog {
  private readonly ref = inject<DialogRef<FormDialogResult | undefined>>(DialogRef);
  protected readonly data = injectDialogData<FormDialogData>();

  protected readonly values = signal<Record<string, string>>(
    Object.fromEntries(this.data.fields.map((f) => [f.key, f.value ?? ''])),
  );
  protected readonly errors = signal<Record<string, string>>({});
  private readonly checking = signal(false);

  protected readonly canSubmit = computed(
    () =>
      !this.checking() &&
      this.data.fields.every((f) => f.optional || this.values()[f.key].trim().length > 0),
  );

  protected setValue(key: string, value: string): void {
    this.values.update((v) => ({ ...v, [key]: value }));
    if (this.errors()[key]) this.errors.update(({ [key]: _gone, ...rest }) => rest);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault(); // Enter in an input lands here too
    if (!this.canSubmit()) return;

    const result: FormDialogResult = {};
    const errors: Record<string, string> = {};

    this.checking.set(true);
    for (const f of this.data.fields) {
      const raw = this.values()[f.key];
      const value = f.secret ? raw : raw.trim(); // a passphrase may start or end with a space
      result[f.key] = value;
      const message = f.validate && value ? await f.validate(value) : null;
      if (message) errors[f.key] = message;
    }
    this.checking.set(false);

    if (Object.keys(errors).length) {
      this.errors.set(errors);
      return; // stay open so it can be corrected
    }
    this.ref.close(result);
  }

  protected cancel(): void {
    this.ref.close(undefined);
  }
}
