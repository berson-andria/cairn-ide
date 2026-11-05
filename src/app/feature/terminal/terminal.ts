import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TerminalService, TerminalSession } from './terminal.service';
import { NodeStore } from '../../core/store/node.store';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTrash2 } from '@ng-icons/lucide';

@Component({
  selector: 'app-terminal',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideIcons({ lucideTrash2 })],
  template: `
    <div class="terminal-container">
      <div class="terminal-output">
        <!-- focusin/focusout bubble from xterm's hidden textarea: this drives the 'terminalFocus' context. -->
        <div #host class="body"></div>
      </div>
      @if (terminals.sessions().length > 1) {
        <div class="sessions-panel">
          <div class="sessions-list scrolling-el">
            @for (session of terminals.sessions(); track session.id) {
              <button
                class="session-item"
                [class.active]="session.id === terminals.activeId()"
                [class.exited]="session.exited()"
                (click)="terminals.activate(session.id)"
              >
                <span class="session-title">{{ session.title() }}</span>
                <button class="close-btn" (click)="close($event, session.id)" title="Close session">
                  <ng-icon name="lucideTrash2"></ng-icon>
                </button>
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      .terminal-container {
        display: flex;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
      }

      /* Right panel: Terminal output */
      .terminal-output {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      .body {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        margin-top: var(--space-8);
        margin-left: var(--space-8);
      }

      /* Right sidebar: Sessions list */
      .sessions-panel {
        display: flex;
        flex-direction: column;
        width: 240px;
        flex: none;
        border-left: 1px solid var(--color-divider);
        background: var(--color-surface-panel);
        overflow: hidden;
      }

      .sessions-list {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        gap: var(--space-2);
        padding: var(--space-4);
      }

      .session-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-8);
        padding: var(--space-2) var(--space-6);
        background: transparent;
        border-radius: var(--radius-chip);
        color: var(--color-text-muted);
        font-size: var(--font-size-ui);
        font-family: var(--font-sans);
        cursor: pointer;
        transition:
          background-color 0.15s ease-in-out,
          color 0.15s ease-in-out,
          border-color 0.15s ease-in-out;
      }

      .session-item:hover {
        background: var(--color-surface-hover);
        color: var(--color-text-secondary);
      }

      .session-item.active {
        background: var(--color-surface-raised);
        color: var(--color-text-primary);
        border-left: 2px solid var(--color-focus);
      }

      .session-item.exited .session-title {
        text-decoration: line-through;
        opacity: 0.6;
      }

      .session-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 24px;
        height: 24px;
        padding: 0;
        background: transparent;
        border: none;
        color: var(--color-text-muted);
        cursor: pointer;
        opacity: 0;
        transition:
          opacity 0.15s ease-in-out,
          color 0.15s ease-in-out;
        border-radius: var(--radius-chip);
      }

      .close-btn:hover {
        color: var(--color-error-fg);
      }

      .session-item:hover .close-btn {
        opacity: 1;
      }

      .new-session-btn {
        flex: none;
        padding: var(--space-8) var(--space-12);
        margin: var(--space-8);
        background: var(--color-surface-hover);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-chip);
        color: var(--color-text-primary);
        font-size: var(--font-size-ui);
        font-family: var(--font-sans);
        font-weight: var(--font-weight-medium);
        cursor: pointer;
        transition:
          background-color 0.15s ease-in-out,
          border-color 0.15s ease-in-out;
      }

      .new-session-btn:hover {
        background: var(--color-surface-raised-hover);
        border-color: var(--color-border-strong);
      }

      .new-session-btn:active {
        background: var(--color-surface-raised);
      }
    `,
  ],
})
export class Terminal {
  protected readonly terminals = inject(TerminalService);
  protected readonly nodeStore = inject(NodeStore);

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  private shown: TerminalSession | null = null;
  private resizeObserver?: ResizeObserver;
  private frame = 0;

  constructor() {
    // Show whichever session is active (the other sessions keep running, just detached).
    effect(() => {
      const session = this.terminals.activeSession();
      const host = this.host().nativeElement;
      if (!session) {
        this.terminals.create(this.nodeStore.rootPath());
      }
      untracked(() => {
        if (this.shown && this.shown !== session) this.terminals.detach(this.shown);
        this.shown = session;
        if (session) this.terminals.attach(session, host);
      });
    });

    afterNextRender(() => {
      // Same deferred-per-frame pattern as the Monaco editor (avoids the ResizeObserver loop error).
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.shown && this.terminals.fit(this.shown));
      });
      this.resizeObserver.observe(this.host().nativeElement);
    });

    inject(DestroyRef).onDestroy(() => {
      this.resizeObserver?.disconnect();
      cancelAnimationFrame(this.frame);
      if (this.shown) this.terminals.detach(this.shown);
      // layoutService: commented out as it isn't fully integrated to the redesign yet
      // this.keys.setContext('terminalFocus', false);
    });
  }

  protected onTabsWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    (event.currentTarget as HTMLElement).scrollLeft += event.deltaY;
    event.preventDefault();
  }

  protected close(event: Event, id: string): void {
    event.stopPropagation();
    // layoutService: commented out as it isn't fully integrated to the redesign yet
    // Goes through ToolingService: closing the last session also closes the panel.
    void this.terminals.close(id);
  }
}
