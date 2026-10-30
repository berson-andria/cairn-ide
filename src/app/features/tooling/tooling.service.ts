import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { TerminalService } from '../../features/tooling/terminal/terminal.service';
import { LayoutService } from '../../core/services/layout.service';
import { WorkspaceNodeStore } from '../../core/store/workspace/workspace.store';

export type ToolId = 'problems' | 'output' | 'terminal';

/**
 * Owns the bottom panel's behaviour: which tool is shown, and the terminal-session policy.
 *
 * POLICY (one place, so every entry point behaves the same: button, shortcut, settings, restored layout)
 *   1. Whenever the panel is visible on the Terminal tool, there is at least one session.
 *      -> opening the panel, or switching to the Terminal tool, with no session creates one.
 *   2. Closing the LAST session closes the panel (VS Code does the same). Other tools are untouched.
 *   3. Hiding the panel never kills shells: sessions keep running and are re-attached on reopen.
 */
@Injectable({ providedIn: 'root' })
export class ToolingService {
  private readonly layout = inject(LayoutService);
  private readonly terminals = inject(TerminalService);
  private readonly store = inject(WorkspaceNodeStore);

  readonly active = signal<ToolId>('terminal');
  readonly isOpen = computed(() => !this.layout.isTerminalPanelCollapesed());
  /** Set when a shell could not be started; the Terminal tool shows it with a Retry button. */
  readonly terminalError = signal<string | null>(null);

  private creating = false;

  constructor() {
    // Rule 1. State based, so it also covers a layout restored from settings and any toggle elsewhere.
    effect(() => {
      const terminalVisible = this.isOpen() && this.active() === 'terminal';
      const noSession = this.terminals.sessions().length === 0;
      if (terminalVisible && noSession) untracked(() => void this.newTerminal());
    });
  }

  /** Show a tool and make sure the panel is open. */
  open(tool: ToolId): void {
    this.active.set(tool);
    this.layout.isTerminalPanelCollapesed.set(false);
  }

  /** Ctrl+` style: hide when that tool is already showing, otherwise show it. */
  toggle(tool: ToolId): void {
    if (this.isOpen() && this.active() === tool) this.hide();
    else this.open(tool);
  }

  hide(): void {
    this.layout.isTerminalPanelCollapesed.set(true);
  }

  async newTerminal(): Promise<void> {
    if (this.creating) return; // guards double clicks and the effect above
    this.creating = true;
    this.terminalError.set(null);
    try {
      await this.terminals.create(this.store.rootPath());
    } catch (err) {
      console.error('Could not start a terminal', err);
      this.terminalError.set(String(err));
    } finally {
      this.creating = false;
    }
  }

  /** Rule 2. Always close sessions through this method, never through TerminalService.close directly. */
  async closeTerminal(id: string): Promise<void> {
    const sessions = this.terminals.sessions();
    const isLast = sessions.length === 1 && sessions[0].id === id;

    // Collapse BEFORE the list empties (and before any await), otherwise rule 1 would
    // see "visible + no session" for a moment and immediately spawn a replacement shell.
    if (isLast) this.hide();

    await this.terminals.close(id);
  }
}
