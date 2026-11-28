import { Injectable, NgZone, computed, effect, inject, signal } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ITheme, Terminal } from '@xterm/xterm';
import { SettingsService } from '../../feature/setting/settings.service';

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

// ───────────────────────── theme ─────────────────────────
// xterm takes static hex values, so the theme is rebuilt from the current token values
// (token.scss) and re-applied to every session whenever <html data-theme> changes.

type Mode = 'dark' | 'light';

const getMode = (): Mode =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

/** Fallbacks = the values in token.scss, used only if a variable can't be read. */
// xterm theme file: replace FALLBACKS with this. The ANSI table needs no change.
const FALLBACKS: Record<Mode, Record<string, string>> = {
  dark: {
    '--color-surface-panel': '#212225',
    '--color-border-strong': '#4a4b51',
    '--color-text-primary': '#e6e7e9',
    '--color-text-secondary': '#c5c7cb',
    '--color-text-muted': '#9fa2a8',
    '--color-text-faint': '#7c7f86',
  },
  light: {
    '--color-surface-panel': '#f2f2f3',
    '--color-surface-raised-hover': '#d8d8dc',
    '--color-border-strong': '#c2c2c8',
    '--color-text-primary': '#1c1d1f',
    '--color-text-secondary': '#44454a',
    '--color-text-muted': '#686a70',
    '--color-text-faint': '#85878d',
  },
};

/** ANSI hues stay One Dark (dark) / One Light (light). Neutrals come from the tokens. */
const ANSI: Record<Mode, Partial<ITheme>> = {
  dark: {
    red: '#e05561',
    green: '#8cc265',
    yellow: '#d18f52',
    blue: '#4aa5f0',
    magenta: '#c162de',
    cyan: '#42b3c2',
    brightRed: '#ff616e',
    brightGreen: '#a5e075',
    brightYellow: '#f0a45d',
    brightBlue: '#4dc4ff',
    brightMagenta: '#de73ff',
    brightCyan: '#4cd1e0',
  },
  light: {
    red: '#ca1243',
    green: '#4e8c3a',
    yellow: '#986801',
    blue: '#4078f2',
    magenta: '#a626a4',
    cyan: '#0184bc',
    brightRed: '#e45649',
    brightGreen: '#50a14f',
    brightYellow: '#c18401',
    brightBlue: '#5b8def',
    brightMagenta: '#c25dc0',
    brightCyan: '#2b9fcf',
  },
};

/** '#rrggbb' + 0..1 alpha -> '#rrggbbaa' */
const alpha = (hex: string, a: number): string =>
  hex.slice(0, 7) +
  Math.round(Math.min(Math.max(a, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');

function buildTheme(): ITheme {
  const mode = getMode();
  const cs = getComputedStyle(document.documentElement);
  const t = (name: string): string =>
    cs.getPropertyValue(name).trim() || FALLBACKS[mode][name] || '#000000';

  const background = t('--color-surface-panel'); // the bottom panel surface
  const textPrimary = t('--color-text-primary');
  const textSecondary = t('--color-text-secondary');
  const textMuted = t('--color-text-muted');
  const textFaint = t('--color-text-faint');
  const borderStrong = t('--color-border-strong');

  // ANSI "black/white" must stay visible on the background in both modes.
  const neutrals: Partial<ITheme> =
    mode === 'dark'
      ? {
          black: borderStrong,
          brightBlack: textFaint, // dim text, autosuggestions
          white: textSecondary,
          brightWhite: textPrimary,
        }
      : {
          black: textPrimary,
          brightBlack: textMuted,
          white: borderStrong,
          brightWhite: t('--color-surface-raised-hover'),
        };

  return {
    background,
    foreground: textPrimary,
    cursor: textPrimary,
    cursorAccent: background,
    selectionBackground: alpha(textMuted, 0.3),
    selectionInactiveBackground: alpha(textMuted, 0.18),
    ...ANSI[mode],
    ...neutrals,
  };
}

@Injectable({ providedIn: 'root' })
export class TerminalService {
  private readonly zone = inject(NgZone);
  private readonly settings = inject(SettingsService);
  private counter = 0;

  readonly sessions = signal<TerminalSession[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly activeSession = computed(
    () => this.sessions().find((s) => s.id === this.activeId()) ?? null,
  );

  constructor() {
    effect(() => {
      const fontSize = this.settings.get<number>('terminal.fontSize')();
      const cursor = this.settings.get<'block' | 'line' | 'underline'>('terminal.cursorStyle')();
      for (const session of this.sessions()) {
        session.term.options.fontSize = fontSize;
        session.term.options.cursorStyle = cursor === 'line' ? 'bar' : cursor;
      }
    });
    // Re-theme every open terminal when <html data-theme> changes. Lives as long as the app.
    this.zone.runOutsideAngular(() => {
      new MutationObserver(() => this.applyTheme()).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    });
  }

  /** Pushes the current theme to all sessions. Safe to call manually (e.g. after changing tokens). */
  applyTheme(): void {
    const theme = buildTheme();
    for (const s of this.sessions()) s.term.options.theme = theme;
  }

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
        shell: (shell ?? this.settings.get<string>('terminal.shell')()) || null,
        args: this.settings.get<string[]>('terminal.shellArgs')(),
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
    const cursor = this.settings.get<'block' | 'line' | 'underline'>('terminal.cursorStyle')();
    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: this.settings.get<number>('terminal.fontSize')(),
      cursorStyle: cursor === 'line' ? 'bar' : cursor,
      cursorBlink: true,
      scrollback: this.settings.get<number>('terminal.scrollback')(),
      theme: buildTheme(),
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
