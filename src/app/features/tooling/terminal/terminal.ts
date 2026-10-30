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
// Adjust these two imports to your folders.
import { TerminalService, TerminalSession } from './terminal.service';
import { KeybindingService } from '../../../core/services/command/keybinding.service';
import { ToolingService } from '../tooling.service';

@Component({
  selector: 'app-terminal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tabs">
      <div class="tab-list" #tabList (wheel)="onTabsWheel($event)">
        @for (s of terminals.sessions(); track s.id) {
          <button
            class="tab"
            [class.active]="s.id === terminals.activeId()"
            [class.exited]="s.exited()"
            (click)="terminals.activate(s.id)"
          >
            <span class="title">{{ s.title() }}</span>
            <span class="close" (click)="close($event, s.id)">×</span>
          </button>
        }
      </div>
      <button class="new" title="New terminal" (click)="create()">+</button>
    </div>

    <!-- focusin/focusout bubble from xterm's hidden textarea: this is what drives the 'terminalFocus' context. -->
    <div
      #host
      class="body"
      (focusin)="keys.setContext('terminalFocus', true)"
      (focusout)="keys.setContext('terminalFocus', false)"
    ></div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        background: var(--base-bg);
        overflow: hidden;
      }
      .tabs {
        display: flex;
        align-items: center;
        flex: none;
        gap: 2px;
        padding: 0 6px;
        height: 30px;
        border-bottom: 1px solid #3e4452;
      }
      .tab {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex: 0 1 200px; /* start at 200px, shrink as tabs are added... */
        min-width: 90px; /* ...until here, then the list scrolls instead */
        padding: 2px 8px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #7f848e;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .tab.active {
        background: #2c313c;
        color: #abb2bf;
      }
      .tab.exited .title {
        text-decoration: line-through;
      }

      .title {
        flex: 1;
        min-width: 0; /* lets the ellipsis kick in while the tab shrinks */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .close {
        opacity: 0.6;
        flex: none;
      }
      .close:hover {
        opacity: 1;
      }
      .new {
        flex: none;
        margin-left: 4px;
        border: 0;
        background: transparent;
        color: #abb2bf;
        font-size: 16px;
        cursor: pointer;
      }
      .tab-list {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 0 1 auto; /* as wide as its tabs, but allowed to shrink so "+" stays in view */
        min-width: 0; /* without this a flex child never shrinks below its content */
        height: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: thin; /* use "none" to hide it completely */
      }
      /* position:relative + absolutely placed terminals = the same "can't push its parent" setup as the editor */
      .body {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        margin-top: 0.25em;
        margin-left: 0.25em;
      }
    `,
  ],
})
export class Terminal {
  protected readonly terminals = inject(TerminalService);
  protected readonly keys = inject(KeybindingService);
  private readonly tooling = inject(ToolingService);

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly tabList = viewChild.required<ElementRef<HTMLElement>>('tabList');

  private shown: TerminalSession | null = null;
  private resizeObserver?: ResizeObserver;
  private frame = 0;

  constructor() {
    // Show whichever session is active (the other sessions keep running, just detached).
    effect(() => {
      const session = this.terminals.activeSession();
      const host = this.host().nativeElement;
      untracked(() => {
        if (this.shown && this.shown !== session) this.terminals.detach(this.shown);
        this.shown = session;
        if (session) this.terminals.attach(session, host);
      });
      requestAnimationFrame(() =>
        this.tabList()
          .nativeElement.querySelector('.tab.active')
          ?.scrollIntoView({ inline: 'nearest', block: 'nearest' }),
      );
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
      this.keys.setContext('terminalFocus', false);
    });
  }

  protected onTabsWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    (event.currentTarget as HTMLElement).scrollLeft += event.deltaY;
    event.preventDefault();
  }

  protected create(): void {
    void this.tooling.newTerminal();
  }

  protected close(event: Event, id: string): void {
    event.stopPropagation();
    // Goes through ToolingService: closing the last session also closes the panel.
    void this.tooling.closeTerminal(id);
  }
}
