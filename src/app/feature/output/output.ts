import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { OutputService } from './output.service';

@Component({
  selector: 'app-output',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <select
        class="channel"
        aria-label="Output channel"
        [disabled]="output.names().length === 0"
        (change)="onChannel($event)"
      >
        @for (name of output.names(); track name) {
          <option [value]="name" [selected]="name === output.active()">{{ name }}</option>
        } @empty {
          <option>No channels</option>
        }
      </select>

      <span class="spacer"></span>
      <button
        type="button"
        class="btn"
        [attr.aria-pressed]="locked()"
        title="Lock scrolling"
        (click)="locked.set(!locked())"
      >
        Lock
      </button>
      <button
        type="button"
        class="btn"
        [disabled]="!output.activeText()"
        title="Clear output"
        (click)="output.clear()"
      >
        Clear
      </button>
    </div>

    @if (output.activeText()) {
      <pre #log class="log" (scroll)="onScroll()">{{ output.activeText() }}</pre>
    } @else {
      <p class="empty">No output yet.</p>
    }
  `,
  styles: [
    `
      :host {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
        height: 30px;
        padding: 0 8px;
        border-bottom: 1px solid #3e4452;
      }
      .spacer {
        flex: 1;
      }
      .channel {
        min-width: 9em;
        max-width: 50%;
        padding: 2px 6px;
        border: 1px solid #3e4452;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font: inherit;
        outline: none;
      }
      .channel:focus-visible {
        border-color: #4aa5f0;
      }
      .channel option {
        background: Canvas;
        color: CanvasText;
      }
      .btn {
        padding: 2px 8px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #7f848e;
        font: inherit;
        cursor: pointer;
      }
      .btn:hover:not(:disabled),
      .btn[aria-pressed='true'] {
        color: #abb2bf;
      }
      .btn[aria-pressed='true'] {
        background: #2c313c;
      }
      .btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .log {
        flex: 1;
        min-height: 0;
        margin: 0;
        padding: 6px 10px;
        overflow: auto;
        font-family: 'Cascadia Code', Consolas, 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre;
      }
      .empty {
        margin: 24px 0;
        text-align: center;
        color: #7f848e;
      }
    `,
  ],
})
export class OutputPanel {
  protected readonly output = inject(OutputService);
  protected readonly locked = signal(false);

  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  private readonly injector = inject(Injector);
  private stickToBottom = true;

  constructor() {
    // Follow new output while the user is at the bottom (and not locked).
    effect(() => {
      this.output.activeText();
      if (this.locked()) return;
      afterNextRender(
        () => {
          const el = this.log()?.nativeElement;
          if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
        },
        { injector: this.injector },
      );
    });
  }

  protected onChannel(event: Event): void {
    this.stickToBottom = true;
    this.output.active.set((event.target as HTMLSelectElement).value);
  }

  protected onScroll(): void {
    const el = this.log()?.nativeElement;
    if (el) this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }
}
