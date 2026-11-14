import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTrash } from '@ng-icons/lucide';
import {
  AstAnchor,
  NoteAnchor,
  NoteItem,
  NoteStatus,
  TaskAnchor,
} from '../note.service';
import { NoteService } from '../note.service';

@Component({
  selector: 'note, note-item',
  standalone: true,
  imports: [NgIcon],
  providers: [provideIcons({ lucideTrash })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="note-card"
      [class.note-card--selected]="isSelected()"
      [class.note-card--dashed]="isDashed()"
      [class.note-card--completed]="isCompleted()"
      tabindex="0"
      role="button"
      (click)="onSelect()"
      (keydown.enter)="onSelect()"
      (keydown.space)="onSelect()"
    >
      <div class="note-card__content">
        @if (displayType()) {
          <span class="note-card__type">{{ displayType() }} · </span>
        }
        <span class="note-card__text">{{ displayContent() }}</span>
        <ng-content />
      </div>

      <div class="note-card__footer">
        @if (displayAnchors().length > 0) {
          <div class="note-card__anchors">
            @for (anch of displayAnchors(); track $index) {
              @if (anch.kind === 'task') {
                <button
                  type="button"
                  class="chip chip--task"
                  [title]="anch.title ? anch.title : anch.label"
                  (click)="onAnchorClick($event, anch)"
                >
                  <span class="chip__label">{{ anch.label }}</span>
                </button>
              } @else if (anch.kind === 'ast') {
                <button
                  type="button"
                  class="chip chip--ast"
                  [class.chip--lost]="isAstLost(anch)"
                  [title]="anch.path"
                  (click)="onAnchorClick($event, anch)"
                >
                  <span class="chip__label">{{ isAstLost(anch) ? 'anchor lost' : anch.label }}</span>
                </button>
              }
            }
          </div>
        } @else {
          <span class="note-card__inbox">Inbox</span>
        }

        @if (isCompleted()) {
          <span class="note-card__completed-badge">Completed</span>
        }
        @if (note()) {
          <button
            type="button"
            class="icon-btn note-card__delete"
            aria-label="Delete note"
            title="Delete note"
            (click)="deleteNote($event)"
          >
            <ng-icon name="lucideTrash" />
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin: 0 var(--space-10) var(--space-8);
    }

    .note-card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-control);
      padding: var(--space-9) var(--space-10);
      font-size: var(--font-size-small);
      line-height: var(--line-height-ui);
      background: transparent;
      color: var(--color-text-primary);
      cursor: pointer;
      user-select: text;
      transition:
        background-color 0.15s ease,
        border-color 0.15s ease,
        opacity 0.15s ease;

      &:hover:not(.note-card--selected) {
        background-color: var(--color-surface-hover);
        border-color: var(--color-border-strong);
      }

      &:focus-visible {
        outline: 2px solid var(--color-focus);
        outline-offset: 1px;
      }

      &--selected {
        border-color: var(--color-text-primary);
        background-color: var(--color-surface-raised);
      }

      &--dashed {
        border-style: dashed;
      }

      &--completed {
        opacity: 0.75;
        border-color: var(--color-border);

        .note-card__text {
          color: var(--color-text-muted);
        }
      }
    }

    .note-card__content {
      word-break: break-word;
    }

    .note-card__type {
      color: var(--color-text-secondary);
      font-weight: var(--font-weight-medium);
    }

    .note-card__text {
      color: var(--color-text-primary);
    }

    .note-card__footer {
      margin-top: var(--space-6);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }

    .note-card__anchors {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-4);
    }

    .note-card__inbox {
      font-size: var(--font-size-label);
      color: var(--color-text-muted);
    }

    .note-card__completed-badge {
      font-size: var(--font-size-micro);
      color: var(--color-text-faint);
      text-transform: uppercase;
      letter-spacing: var(--letter-spacing-label);
    }

    .note-card__delete {
      align-self: center;
      flex: none;
      margin-left: auto;
      margin-right: var(--space-6);
      color: var(--color-error-fg);
    }

    .note-card__delete:hover:not(:disabled) {
      background: var(--color-error-bg);
      color: var(--color-error-fg);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      padding: 1px var(--space-6);
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-chip);
      font-size: var(--font-size-label);
      color: var(--color-text-secondary);
      background: transparent;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      transition:
        border-color 0.15s ease,
        color 0.15s ease,
        background-color 0.15s ease;

      &:hover {
        border-color: var(--color-text-primary);
        color: var(--color-text-primary);
        background-color: var(--color-surface-hover);
      }

      &--task {
        border-color: var(--color-border-strong);
      }

      &--ast {
        border-color: var(--color-border-strong);
      }

      &--lost {
        border-style: dashed;
        color: var(--color-status-blocked);
        border-color: var(--color-status-blocked);

        &:hover {
          color: var(--color-status-blocked);
          border-color: var(--color-status-blocked);
        }
      }
    }
  `,
})
export class Note {
  private readonly noteService = inject(NoteService);
  note = input<NoteItem>();
  content = input<string>('');
  type = input<string>('');
  status = input<NoteStatus>('open');
  anchors = input<NoteAnchor[]>([]);
  selected = input<boolean>(false);

  select = output<void>();
  anchorClick = output<NoteAnchor>();
  taskClick = output<TaskAnchor>();
  astClick = output<AstAnchor>();

  displayContent = computed(() => this.note()?.content ?? this.content());
  displayType = computed(() => this.note()?.type ?? this.type());

  displayAnchors = computed<NoteAnchor[]>(() => {
    const item = this.note();
    if (item) {
      return item.anchors ?? [];
    }
    return this.anchors();
  });

  hasLostAnchor = computed(() =>
    this.displayAnchors().some((a) => a.kind === 'ast' && (a.lost || a.label === 'anchor lost'))
  );

  isCompleted = computed(() =>
    (this.note() ? this.note()!.status : this.status()) === 'completed'
  );

  isSelected = computed(() => this.selected());
  isDashed = computed(() => this.hasLostAnchor());

  isAstLost(anchor: AstAnchor): boolean {
    return !!anchor.lost || anchor.label === 'anchor lost';
  }

  onSelect(): void {
    this.select.emit();
  }

  deleteNote(event: MouseEvent): void {
    event.stopPropagation();
    const note = this.note();
    if (note) this.noteService.delete(note.id);
  }

  onAnchorClick(event: MouseEvent, anchor: NoteAnchor): void {
    event.stopPropagation();
    this.anchorClick.emit(anchor);
    if (anchor.kind === 'task') {
      this.taskClick.emit(anchor);
    } else {
      this.astClick.emit(anchor);
    }
  }
}
