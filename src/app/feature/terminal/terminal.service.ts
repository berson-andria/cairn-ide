import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

type PtyEvent = { event: 'data'; data: string } | { event: 'exit'; data: number | null };

export interface TerminalSession {
  /** Local id (stable even before the pty exists). */
  id: string;
  title: ReturnType<typeof signal<string>>;
  exited: ReturnType<typeof signal<boolean>>;
  term: Terminal;
  fit: FitAddon;
  /** Persistent DOM node. The panel moves it in and out of view; the shell keeps running meanwhile. */
  element: HTMLDivElement;
  ptyId?: string;
  opened: boolean;
  /** pty_write / pty_resize calls are chained so keystrokes can never arrive out of order. */
  queue: Promise<unknown>;
}

// One Dark Pro's terminal colors.
const THEME = {
  background: '#211e1a',
  foreground: '#e8e2d6',
  cursor: '#d8dde5d4',
  selectionBackground: '#abb2bf30',
  black: '#3f4451',
  red: '#e05561',
  green: '#8cc265',
  yellow: '#d18f52',
  blue: '#4aa5f0',
  magenta: '#c162de',
  cyan: '#42b3c2',
  white: '#d7dae0',
  brightBlack: '#4f5666',
  brightRed: '#ff616e',
  brightGreen: '#a5e075',
  brightYellow: '#f0a45d',
  brightBlue: '#4dc4ff',
  brightMagenta: '#de73ff',
  brightCyan: '#4cd1e0',
  brightWhite: '#e6e6e6',
};

@Injectable({ providedIn: 'root' })
export class TerminalService {
  private readonly zone = inject(NgZone);
  private counter = 0;

  readonly sessions = signal<TerminalSession[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly activeSession = computed(
    () => this.sessions().find((s) => s.id === this.activeId()) ?? null,
  );

  /** Starts a shell. `cwd` null = the user's home. */
  async create(cwd: string | null, shell?: string): Promise<TerminalSession> {
    const session = this.zone.runOutsideAngular(() => this.buildSession());

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (e) => {
      if (e.event === 'data') session.term.write(e.data);
      else this.onExit(session, e.data);
    };

    try {
      session.ptyId = await invoke<string>('pty_spawn', {
        cwd,
        shell: shell ?? null,
        args: null,
        cols: session.term.cols,
        rows: session.term.rows,
        onEvent: channel,
      });
    } catch (err) {
      session.term.dispose();
      throw err;
    }

    this.sessions.update((list) => [...list, session]);
    this.activeId.set(session.id);
    return session;
  }

  activate(id: string): void {
    this.activeId.set(id);
  }

  async close(id: string): Promise<void> {
    const session = this.sessions().find((s) => s.id === id);
    if (!session) return;

    const remaining = this.sessions().filter((s) => s.id !== id);
    this.sessions.set(remaining);
    if (this.activeId() === id) this.activeId.set(remaining.at(-1)?.id ?? null);

    if (session.ptyId && !session.exited())
      await invoke('pty_kill', { id: session.ptyId }).catch(() => {});
    session.element.remove();
    session.term.dispose();
  }

  clearSessions() {
    this.sessions.set([]);
  }

  attach(session: TerminalSession, host: HTMLElement): void {
    host.appendChild(session.element);
    this.fit(session); // opens the terminal as soon as there is room for it
    if (session.opened) session.term.focus();
  }
  detach(session: TerminalSession): void {
    session.element.remove();
  }

  fit(session: TerminalSession): void {
    const host = session.element.parentElement;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;

    if (!session.opened) {
      session.term.open(session.element);
      session.opened = true;
      session.term.focus();
    }
    try {
      session.fit.fit();
    } catch {
      /* renderer not ready yet; the next resize will fit */
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private buildSession(): TerminalSession {
    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));

    const element = document.createElement('div');
    element.style.cssText = 'position:absolute; inset:0;';

    const session: TerminalSession = {
      id: `term-${++this.counter}`,
      title: signal(`Terminal ${this.counter}`),
      exited: signal(false),
      term,
      fit,
      element,
      opened: false,
      queue: Promise.resolve(),
    };

    // keystrokes -> shell
    term.onData((data) => {
      if (session.ptyId && !session.exited())
        this.enqueue(session, 'pty_write', { id: session.ptyId, data });
    });
    // size changes -> shell
    term.onResize(({ cols, rows }) => {
      if (session.ptyId && !session.exited())
        this.enqueue(session, 'pty_resize', { id: session.ptyId, cols, rows });
    });
    // the shell can set its own title (PowerShell shows the current path)
    term.onTitleChange((t) => this.zone.run(() => t && session.title.set(t)));

    // Windows Terminal behaviour: Ctrl+C copies when text is selected, otherwise it is SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        e.ctrlKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'c' &&
        term.hasSelection()
      ) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });

    return session;
  }

  private enqueue(session: TerminalSession, cmd: string, args: Record<string, unknown>): void {
    session.queue = session.queue.then(() => invoke(cmd, args)).catch(() => {});
  }

  private onExit(session: TerminalSession, code: number | null): void {
    this.zone.run(() => session.exited.set(true));
    session.term.write(
      `\r\n\x1b[2m[process exited${code != null ? ` with code ${code}` : ''}]\x1b[0m\r\n`,
    );
  }
}
