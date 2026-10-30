import { Injectable, computed, signal } from '@angular/core';
import type * as lsp from 'vscode-languageserver-types';
import { LspServerConfig, resolveCommand } from './lsp-servers';

const MAX_EVENTS = 200;
const MAX_LOG_LINES = 300;

export type ServerStatus =
  | 'starting' // spawning the process
  | 'initializing' // process is up, LSP `initialize` handshake in flight
  | 'running'
  | 'failed' // never became ready (message says whether spawn or handshake failed)
  | 'stopping'
  | 'stopped'
  | 'crashed'; // exited on its own after it had started

export type Severity = 'error' | 'warning' | 'info' | 'hint';
export type LogLevel = 'stderr' | 'error' | 'warning' | 'info' | 'log';

export interface ServerState {
  id: string;
  command: string;
  status: ServerStatus;
  /** Human-readable detail for the current status (error text on failure). */
  message?: string;
  exitCode?: number | null;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  openDocuments: number;
  /** Capabilities the server announced in the initialize response. */
  capabilities?: string[];
}

export interface FileDiagnostic {
  serverId: string;
  severity: Severity;
  message: string;
  source?: string;
  code?: string;
  /** 1-based, like Monaco. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface FileDiagnostics {
  uri: string;
  /** Filesystem path, for display. */
  path: string;
  items: FileDiagnostic[];
}

export interface LifecycleEvent {
  time: number;
  serverId: string;
  status: ServerStatus;
  message: string;
}

export interface ServerLogLine {
  time: number;
  level: LogLevel;
  text: string;
}

/** What an LspClient uses to report. Bound to one client instance (one "run" of a server). */
export interface LspServerHandle {
  initializing(): void;
  ready(capabilities: Record<string, unknown>): void;
  failed(error: unknown): void;
  stopping(): void;
  stopped(): void;
  exited(code: number | null): void;
  documents(count: number): void;
  log(level: LogLevel, text: string): void;
  diagnostics(uri: string, path: string, list: lsp.Diagnostic[]): void;
}

const SEVERITIES: Record<number, Severity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

@Injectable({ providedIn: 'root' })
export class LspMonitor {
  private readonly _servers = signal<Record<string, ServerState>>({});
  private readonly _files = signal<Record<string, FileDiagnostics>>({});
  private readonly _events = signal<LifecycleEvent[]>([]);
  private readonly _logs = signal<Record<string, ServerLogLine[]>>({});

  // config.id -> latest run number. A stale client (e.g. one still shutting down after
  // a restart) must not overwrite the status of the new one.
  private readonly runs = new Map<string, number>();
  private runCounter = 0;

  /** Record keyed by server id. */
  readonly servers = this._servers.asReadonly();
  readonly serverList = computed(() => Object.values(this._servers()));

  /** Record keyed by file URI (same string as `model.uri.toString()`). */
  readonly diagnosticsByFile = this._files.asReadonly();
  readonly filesWithProblems = computed(() => Object.values(this._files()));

  /** Lifecycle timeline, oldest first. */
  readonly events = this._events.asReadonly();
  /** stderr / window/logMessage output per server id. */
  readonly logs = this._logs.asReadonly();

  readonly totals = computed(() => {
    let errors = 0;
    let warnings = 0;
    const files = Object.values(this._files());
    for (const f of files) {
      for (const i of f.items) {
        if (i.severity === 'error') errors++;
        else if (i.severity === 'warning') warnings++;
      }
    }
    return { errors, warnings, files: files.length };
  });

  /** Diagnostics for one file. Reactive when read inside a computed/template. */
  diagnosticsFor(uri: string): FileDiagnostic[] {
    return this._files()[uri]?.items ?? [];
  }

  /** Called by LspClient's constructor; starts a new run for this server id. */
  track(config: LspServerConfig): LspServerHandle {
    const id = config.id;
    const run = ++this.runCounter;
    this.runs.set(id, run);
    const live = () => this.runs.get(id) === run;
    const status = () => this._servers()[id]?.status;

    this.removeServerDiagnostics(id); // leftovers from a previous run
    this._logs.update((l) => ({ ...l, [id]: [] }));

    const setStatus = (next: ServerStatus, message: string, extra: Partial<ServerState> = {}) => {
      if (!live()) return;
      this._servers.update((s) => ({ ...s, [id]: { ...s[id], status: next, message, ...extra } }));
      this._events.update((e) =>
        [...e, { time: Date.now(), serverId: id, status: next, message }].slice(-MAX_EVENTS),
      );
    };

    const command = resolveCommand(config);
    this._servers.update((s) => ({
      ...s,
      [id]: { id, command, status: 'starting', startedAt: Date.now(), openDocuments: 0 },
    }));
    setStatus('starting', `Spawning ${[command, ...config.args].join(' ')}`);

    return {
      initializing: () => setStatus('initializing', 'Process started, waiting for initialize response'),

      ready: (caps) =>
        setStatus('running', 'Ready', {
          readyAt: Date.now(),
          capabilities: Object.keys(caps ?? {}).filter((k) => !!caps[k]),
        }),

      failed: (error) => {
        const text = errorText(error);
        const phase =
          status() === 'initializing'
            ? 'Initialize handshake failed'
            : 'Could not start process (is it installed and on PATH?)';
        setStatus('failed', `${phase}: ${text}`, { endedAt: Date.now() });
        if (live()) this.appendLog(id, 'error', text);
        this.removeServerDiagnostics(id);
      },

      stopping: () => {
        if (status() === 'failed' || status() === 'crashed') return;
        setStatus('stopping', 'Shutting down');
      },

      stopped: () => {
        if (!live()) return;
        if (status() !== 'failed' && status() !== 'crashed') {
          setStatus('stopped', 'Stopped', { endedAt: Date.now() });
        }
        this.removeServerDiagnostics(id);
      },

      exited: (code) => {
        setStatus('crashed', `Server exited unexpectedly (code ${code ?? 'unknown'})`, {
          exitCode: code,
          endedAt: Date.now(),
        });
        if (live()) this.removeServerDiagnostics(id);
      },

      documents: (count) => {
        if (!live()) return;
        this._servers.update((s) => (s[id] ? { ...s, [id]: { ...s[id], openDocuments: count } } : s));
      },

      log: (level, text) => {
        if (live()) this.appendLog(id, level, text);
      },

      diagnostics: (uri, path, list) => {
        if (live()) this.setDiagnostics(id, uri, path, list);
      },
    };
  }

  // ───────────────────────── internals ─────────────────────────

  private appendLog(id: string, level: LogLevel, text: string): void {
    this._logs.update((all) => ({
      ...all,
      [id]: [...(all[id] ?? []), { time: Date.now(), level, text }].slice(-MAX_LOG_LINES),
    }));
  }

  /** Replaces what ONE server reported for ONE file (that's what publishDiagnostics means). */
  private setDiagnostics(
    serverId: string,
    uri: string,
    path: string,
    list: lsp.Diagnostic[],
  ): void {
    const mine: FileDiagnostic[] = list.map((d) => ({
      serverId,
      severity: SEVERITIES[d.severity ?? 1] ?? 'error',
      message: String(d.message),
      source: d.source,
      code: d.code !== undefined ? String(d.code) : undefined,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    }));

    this._files.update((files) => {
      const others = files[uri]?.items.filter((i) => i.serverId !== serverId) ?? [];
      const items = [...others, ...mine];
      if (!items.length) {
        if (!(uri in files)) return files;
        const { [uri]: _removed, ...rest } = files;
        return rest;
      }
      return { ...files, [uri]: { uri, path, items } };
    });
  }

  private removeServerDiagnostics(serverId: string): void {
    this._files.update((files) => {
      const next: Record<string, FileDiagnostics> = {};
      let changed = false;
      for (const [uri, f] of Object.entries(files)) {
        const items = f.items.filter((i) => i.serverId !== serverId);
        if (items.length !== f.items.length) changed = true;
        if (items.length) next[uri] = items.length === f.items.length ? f : { ...f, items };
      }
      return changed ? next : files;
    });
  }
}

function errorText(e: unknown): string {
  // Tauri rejects invoke() with the plain string from Rust's Err(String).
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
