import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DIALOG_STYLES, plural } from './dialog-shared';

export interface MergeCandidate {
  name: string;
  /** Commits the candidate has that the target branch lacks. 0 = up to date. */
  ahead: number;
}

@Component({
  selector: 'app-merge-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    DIALOG_STYLES,
    `
      .list {
        max-height: 200px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-chip);
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
        padding: var(--space-8) var(--space-10);
        text-align: left;
      }
      .row:hover {
        background: var(--color-surface-hover);
      }
      .row.selected {
        background: var(--color-surface-raised-hover);
      }
      .empty {
        padding: var(--space-8) var(--space-10);
      }
    `,
  ],
  template: `
    <h2>Merge into {{ target() }}</h2>

    <div class="field">
      <label for="mb-search">Branch to merge</label>
      <div class="input-form">
        <input
          id="mb-search"
          type="text"
          placeholder="Search branches"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>
    </div>

    <div class="list scrolling-el" role="listbox" aria-label="Branches">
      @for (b of filtered(); track b.name) {
        <button
          type="button"
          class="row"
          role="option"
          [class.selected]="b.name === selectedName()"
          [attr.aria-selected]="b.name === selectedName()"
          (click)="picked.set(b.name)"
          (dblclick)="merge()"
        >
          <span>{{ b.name }}</span>
          <span class="hint">{{ aheadLabel(b.ahead) }}</span>
        </button>
      } @empty {
        <div class="empty hint">No branches match “{{ query() }}”.</div>
      }
    </div>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action" [disabled]="!selectedName()" (click)="merge()">
        Merge
      </button>
    </div>
  `,
})
export class MergeBranchDialogComponent {
  /** Branch being merged into (the current branch). */
  readonly target = input.required<string>();
  readonly branches = input<MergeCandidate[]>([]);

  readonly merged = output<string>();
  readonly cancelled = output<void>();

  protected readonly query = signal('');
  protected readonly picked = signal<string | null>(null);

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.branches().filter((b) => b.name.toLowerCase().includes(q));
  });

  /** The user's pick if still visible, otherwise the first visible branch. */
  protected readonly selectedName = computed(() => {
    const list = this.filtered();
    const pick = this.picked();
    if (pick && list.some((b) => b.name === pick)) return pick;
    return list[0]?.name ?? null;
  });

  protected aheadLabel(n: number): string {
    return n === 0 ? 'up to date' : `${n} ${plural(n, 'commit', 'commits')} ahead`;
  }

  protected merge(): void {
    const name = this.selectedName();
    if (name) this.merged.emit(name);
  }
}
