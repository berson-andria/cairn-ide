import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { DIALOG_STYLES } from './dialog-shared';
import { injectDialogData } from './dialog-data';

export interface ChoiceOption {
  value: string;
  label: string;
  /** Small grey text after the label ("restore them later"). */
  hint?: string;
  /** Shown in the error colour; also turns the submit button red while selected. */
  danger?: boolean;
}

export interface ChoiceDialogData {
  message?: string;
  options: ChoiceOption[];
  /** Value selected at first. Default: the first option. */
  initial?: string;
  submitLabel: string;
  /** Legend read by screen readers. */
  legend?: string;
}

/**
 * "Choose what to do" dialog (radio buttons). Used for switching branch with uncommitted changes,
 * but works for any small set of strategies. Closes with the chosen `value`, or undefined.
 */
@Component({
  selector: 'app-choice-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  template: `
    @if (data.message) {
      <p>{{ data.message }}</p>
    }

    <fieldset class="fs">
      <legend class="sr-only">{{ data.legend ?? 'Choose an option' }}</legend>
      @for (o of data.options; track o.value) {
        <label class="check" [class.check--danger]="o.danger">
          <input
            type="radio"
            name="choice"
            [checked]="o.value === value()"
            (change)="value.set(o.value)"
          />
          {{ o.label }}
          @if (o.hint) {
            <span class="hint">{{ o.hint }}</span>
          }
        </label>
      }
    </fieldset>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancel()">Cancel</button>
      <button
        type="button"
        class="btn-action"
        [class.btn-danger]="selected()?.danger"
        (click)="submit()"
      >
        {{ data.submitLabel }}
      </button>
    </div>
  `,
})
export class ChoiceDialog {
  private readonly ref = inject<DialogRef<string | undefined>>(DialogRef);
  protected readonly data = injectDialogData<ChoiceDialogData>();

  protected readonly value = signal(this.data.initial ?? this.data.options[0]?.value ?? '');
  protected readonly selected = computed(() =>
    this.data.options.find((o) => o.value === this.value()),
  );

  protected submit(): void {
    this.ref.close(this.value());
  }

  protected cancel(): void {
    this.ref.close(undefined);
  }
}
