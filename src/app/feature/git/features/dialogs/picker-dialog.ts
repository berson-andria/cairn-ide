import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { DIALOG_STYLES } from './dialog-shared';
import { injectDialogData } from './dialog-data';

export interface PickerItem {
  value: string;
  label: string;
  /** Small grey text on the right ("2 commits ahead", "remote"...). */
  hint?: string;
}

export interface PickerDialogData {
  message?: string;
  items: PickerItem[];
  submitLabel: string;
  /** Show the search box. Default: only when there are more than 6 items. */
  searchable?: boolean;
  searchLabel?: string;
  placeholder?: string;
  emptyText?: string;
  danger?: boolean;
}

/**
 * One dialog for every "pick one from a list": merge / rebase / delete branch, checkout,
 * stash apply / pop / drop, remove remote, pull from, push to...
 * Closes with the picked item's `value`, or undefined when cancelled.
 */
@Component({
  selector: 'app-picker-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    DIALOG_STYLES,
    `
      .list {
        max-height: 200px;
        overflow-y: auto;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-chip);
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        padding: var(--space-4) var(--space-8);
        text-align: left;
        color: var(--color-text-primary);
        border-radius: var(--space-4);
      }
      .row:hover {
        background: var(--color-surface-raised);
      }
      .row.selected {
        background: var(--color-surface-raised);
      }
      .empty {
        padding: var(--space-8);
      }
    `,
  ],
  template: `
    @if (data.message) {
      <p>{{ data.message }}</p>
    }

    @if (searchable) {
      <div class="field">
        <label for="pk-search">{{ data.searchLabel ?? 'Search' }}</label>
        <div class="input-form">
          <input
            id="pk-search"
            type="text"
            [placeholder]="data.placeholder ?? ''"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
            (keydown.enter)="submit(); $event.preventDefault()"
            (keydown.arrowdown)="move(1, $event)"
            (keydown.arrowup)="move(-1, $event)"
          />
        </div>
      </div>
    }

    <div class="list scrolling-el" role="listbox">
      @for (item of filtered(); track item.value) {
        <button
          type="button"
          class="row"
          role="option"
          [class.selected]="item.value === selected()"
          [attr.aria-selected]="item.value === selected()"
          (click)="picked.set(item.value)"
          (dblclick)="submit()"
        >
          <span>{{ item.label }}</span>
          @if (item.hint) {
            <span class="hint">{{ item.hint }}</span>
          }
        </button>
      } @empty {
        <div class="empty hint">
          {{
            data.emptyText ?? (query() ? 'Nothing matches “' + query() + '”.' : 'Nothing to show.')
          }}
        </div>
      }
    </div>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancel()">Cancel</button>
      <button
        type="button"
        class="btn-action"
        [class.btn-danger]="data.danger"
        [disabled]="!selected()"
        (click)="submit()"
      >
        {{ data.submitLabel }}
      </button>
    </div>
  `,
})
export class PickerDialogComponent {
  private readonly ref = inject<DialogRef<string | undefined>>(DialogRef);
  protected readonly data = injectDialogData<PickerDialogData>();

  protected readonly searchable = this.data.searchable ?? this.data.items.length > 6;
  protected readonly query = signal('');
  protected readonly picked = signal<string | null>(null);

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.data.items.filter((i) => i.label.toLowerCase().includes(q));
  });

  /** The user's pick if still visible, otherwise the first visible item. */
  protected readonly selected = computed(() => {
    const list = this.filtered();
    const pick = this.picked();
    if (pick && list.some((i) => i.value === pick)) return pick;
    return list[0]?.value ?? null;
  });

  protected move(delta: number, event: Event): void {
    event.preventDefault();
    const list = this.filtered();
    if (!list.length) return;
    const index = list.findIndex((i) => i.value === this.selected());
    const next = Math.min(list.length - 1, Math.max(0, index + delta));
    this.picked.set(list[next].value);
  }

  protected submit(): void {
    const value = this.selected();
    if (value) this.ref.close(value);
  }

  protected cancel(): void {
    this.ref.close(undefined);
  }
}
