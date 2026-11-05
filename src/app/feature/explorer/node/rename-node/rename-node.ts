import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NodeStore } from '../../../../core/store/node.store';
import { KeybindingService } from '../../../../core/services/command/keybinding.service';
import { validateNodeName } from '../../../../shared/utils/node.utils';
// Adjust to wherever KeybindingService lives.

/**
 * Replaces a node's name while it is being renamed (store.renamingNodeId === nodeId).
 *   Enter  -> commit        Esc -> cancel        blur -> commit if valid, otherwise cancel
 * It also sets the 'renaming' context so Ctrl+A / Ctrl+C / Delete etc. go to the text field
 * instead of the explorer shortcuts.
 */
@Component({
  selector: 'rename-node',
  standalone: true,
  template: `
    <input
      #field
      type="text"
      spellcheck="false"
      autocomplete="off"
      [value]="initialName"
      [class.is-danger]="!!error()"
      (input)="onInput()"
      (keydown.enter)="onEnter($event)"
      (keydown.escape)="cancel()"
      (blur)="onBlur()"
      (click)="$event.stopPropagation()"
      (dblclick)="$event.stopPropagation()"
    />
    @if (error()) {
      <span class="alert">{{ error() }}</span>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      flex: 1;
      min-width: 0;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      height: 18px;
      padding: 0 4px;
      font: inherit;
      background: var(--color-surface-base);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-chip);
      outline: none;
    }
    input.is-danger {
      border-color: #d73445;
    }
    .alert {
      position: absolute;
      top: 105%;
      left: 0;
      z-index: 200;
      max-width: 280px;
      padding: 0.5em;
      background-color: #9f2732;
      border: 1px solid #ff001b;
      border-radius: 0.25em;
      color: white;
      font-size: smaller;
    }
  `,
})
export class RenameNode implements OnInit {
  private readonly store = inject(NodeStore);
  private readonly keys = inject(KeybindingService);

  readonly nodeId = input.required<string>();
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected initialName = '';
  protected readonly error = signal<string | null>(null);

  private readonly node = computed(() => this.store.nodes()[this.nodeId()]);
  private readonly isFolder = computed(() => !!this.node() && 'children' in this.node());
  private finished = false; // set once committed/cancelled so late blur events do nothing
  private busy = false;

  constructor() {
    this.keys.setContext('renaming', true);
    inject(DestroyRef).onDestroy(() => this.keys.setContext('renaming', false));

    afterNextRender(() => {
      const el = this.field().nativeElement;
      el.focus();
      // Select the name without its extension ("main" of "main.ts"), like VS Code.
      const dot = el.value.lastIndexOf('.');
      el.setSelectionRange(0, !this.isFolder() && dot > 0 ? dot : el.value.length);
    });
  }

  ngOnInit(): void {
    this.initialName = this.node().name;
  }

  protected onInput(): void {
    this.error.set(this.validate(this.field().nativeElement.value));
  }

  protected onEnter(event: Event): void {
    if ((event as KeyboardEvent).isComposing) return; // IME confirming a character
    event.preventDefault();
    void this.commit(false);
  }

  protected onBlur(): void {
    if (this.finished || this.busy) return;
    const value = this.field().nativeElement.value;
    if (value.trim() === this.initialName || this.validate(value)) this.cancel();
    else void this.commit(true);
  }

  protected cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.store.cancelRename();
  }

  private async commit(fromBlur: boolean): Promise<void> {
    if (this.finished || this.busy) return;
    this.busy = true;
    const err = await this.store.commitRename(this.nodeId(), this.field().nativeElement.value);
    this.busy = false;

    if (!err) {
      this.finished = true; // the store cleared renamingNodeId; this component is about to go away
      return;
    }
    if (fromBlur) {
      this.cancel();
      return;
    }
    this.error.set(err);
    this.field().nativeElement.focus();
  }

  /** Same rules the store enforces, so the message appears while typing instead of only on Enter. */
  private validate(name: string): string | null {
    const invalid = validateNodeName(name);
    if (invalid) return invalid;
    const self = this.node();
    const clash = this.store
      .getNodesByParentId(self.parentId)
      .some((n) => n.id !== self.id && n.name.toLowerCase() === name.trim().toLowerCase());
    return clash ? `"${name.trim()}" already exists in this folder.` : null;
  }
}
