import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  effect,
  inject,
} from '@angular/core';
import { LayoutService } from '../../core/services/layout.service';

import { TerminalService } from './terminal/terminal.service';
import { Terminal } from './terminal/terminal';
import { Problems } from './problems/problems';
import { OutputPanel } from './output/output';
import { ToolingService, ToolId } from './tooling.service';
import { DiagnosticsService } from '../../core/services/diagnostics.service';

/**
 * Bottom panel: a slim rail on the left switches between Problems / Output / Terminal,
 * the selected tool fills the rest. No second header row, so short panels keep their height,
 * and the terminal keeps its own tab row.
 * All three tools stay mounted (inactive ones are display:none) so xterm, scroll positions and filters survive switching.
 */
@Component({
  selector: 'app-tooling',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Terminal, Problems, OutputPanel],
  template: `
    <nav class="rail" aria-label="Panel views">
      @for (t of tools; track t.id) {
        <button
          type="button"
          class="rail__btn"
          [class.is-active]="tooling.active() === t.id"
          [attr.aria-pressed]="tooling.active() === t.id"
          [attr.aria-label]="t.label"
          [title]="t.label"
          (click)="tooling.open(t.id)"
        >
          @switch (t.id) {
            @case ('problems') {
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
                />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              @if (counts().error > 0) {
                <span class="badge badge--error">{{
                  counts().error > 99 ? '99+' : counts().error
                }}</span>
              } @else if (counts().warning > 0) {
                <span class="badge badge--warning">{{
                  counts().warning > 99 ? '99+' : counts().warning
                }}</span>
              }
            }
            @case ('output') {
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M4 6h16" />
                <path d="M4 12h10" />
                <path d="M4 18h14" />
              </svg>
            }
            @case ('terminal') {
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m4 17 6-6-6-6" />
                <path d="M12 19h8" />
              </svg>
            }
          }
        </button>
      }
    </nav>

    <div class="view">
      <div
        class="pane"
        [class.is-hidden]="tooling.active() !== 'problems'"
        [attr.aria-hidden]="tooling.active() !== 'problems'"
      >
        <app-problems />
      </div>
      <div
        class="pane"
        [class.is-hidden]="tooling.active() !== 'output'"
        [attr.aria-hidden]="tooling.active() !== 'output'"
      >
        <app-output />
      </div>
      <div
        class="pane"
        [class.is-hidden]="tooling.active() !== 'terminal'"
        [attr.aria-hidden]="tooling.active() !== 'terminal'"
      >
        <app-terminal />
        @if (tooling.terminalError(); as error) {
          @if (terminals.sessions().length === 0) {
            <div class="error" role="alert">
              <p>Could not start a shell.</p>
              <code>{{ error }}</code>
              <button type="button" (click)="tooling.newTerminal()">Retry</button>
            </div>
          }
        }
      </div>
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

      .rail {
        flex: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        width: 36px;
        padding: 6px 0;
        overflow-y: auto; /* very short panel: the rail scrolls instead of being cut */
        scrollbar-width: none;
        border-right: 1px solid var(--agent-panel-border, #3e4452);
      }
      .rail__btn {
        position: relative;
        display: grid;
        place-items: center;
        flex: none;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #7f848e;
        cursor: pointer;
      }
      .rail__btn:hover {
        color: #abb2bf;
      }
      .rail__btn.is-active {
        background: #2c313c; /* same as the active terminal tab */
        color: #abb2bf;
      }
      .rail__btn:focus-visible {
        outline: 2px solid #4aa5f0;
        outline-offset: -2px;
      }

      .badge {
        position: absolute;
        top: -2px;
        right: -4px;
        min-width: 14px;
        padding: 0 3px;
        border-radius: 7px;
        font-size: 10px;
        line-height: 14px;
        text-align: center;
        color: #181a1c;
      }
      .badge--error {
        background: #e05561;
      }
      .badge--warning {
        background: #d18f52;
      }

      .view {
        position: relative;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .pane {
        position: absolute;
        inset: 0;
      }
      .pane.is-hidden {
        display: none;
      }

      .error {
        position: absolute;
        inset: 30px 0 0 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 16px;
        text-align: center;
        color: #abb2bf;
        background: var(--base-bg);
      }
      .error p {
        margin: 0;
      }
      .error code {
        max-width: 100%;
        font-size: 12px;
        color: #e05561;
        overflow-wrap: anywhere;
      }
      .error button {
        margin-top: 4px;
        padding: 3px 12px;
        border: 1px solid #3e4452;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
    `,
  ],
})
export class ToolingPanel {
  protected readonly tooling = inject(ToolingService);
  protected readonly terminals = inject(TerminalService);
  private readonly layout = inject(LayoutService);
  private readonly injector = inject(Injector);
  protected readonly counts = inject(DiagnosticsService).counts;

  protected readonly tools: { id: ToolId; label: string }[] = [
    { id: 'problems', label: 'Problems' },
    { id: 'output', label: 'Output' },
    { id: 'terminal', label: 'Terminal' },
  ];

  constructor() {
    // Put the keyboard focus in the shell whenever the terminal becomes the visible tool.
    effect(() => {
      const terminalVisible =
        !this.layout.isTerminalPanelCollapesed() && this.tooling.active() === 'terminal';
      if (terminalVisible) {
        afterNextRender(() => this.terminals.activeSession()?.term.focus(), {
          injector: this.injector,
        });
      }
    });
  }
}
