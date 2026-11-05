import { Injectable, computed, effect, inject, untracked } from '@angular/core';

import { LspMonitor } from './lsp-monitor.service';
import { NodeStore } from '../../store/node.store';
import { DiagnosticsService, ProblemInput, Severity } from '../diagnostics.service';
import { OutputService } from '../../../feature/output/output.service';

/**
 * LSP positions: raw LSP is 0-based, the editor (Monaco) is 1-based.
 * Check one row of your console table against the editor. If the table says 4:10 and the cursor
 * is really at 5:11, set both to 1. If they already match, leave 0.
 */
const LINE_OFFSET = 0;
const COLUMN_OFFSET = 0;

const OWNER_PREFIX = 'lsp:';
export const LSP_CHANNEL = 'Language Servers';

export type Tone = 'ok' | 'busy' | 'error' | 'idle';

/**
 * Connects the LSP monitor to the tooling panel. It replaces the console.log effects:
 *   diagnosticsByFile -> Problems      (DiagnosticsService)
 *   events            -> Output        (channel "Language Servers")
 *   serverList        -> status bar    (servers / tone / summaryTitle)
 * Inject it once at startup (IdeShell does).
 */
@Injectable({ providedIn: 'root' })
export class LspBridgeService {
  private readonly lsp = inject(LspMonitor);
  private readonly store = inject(NodeStore);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly output = inject(OutputService);

  readonly servers = computed(() =>
    this.lsp.serverList().map((s) => ({
      id: s.id,
      status: String(s.status),
      message: s.message,
      openDocuments: s.openDocuments,
      exitCode: s.exitCode,
      tone: toneOf(String(s.status)),
    })),
  );

  /** Worst state across servers: error > busy > ok > idle. */
  readonly tone = computed<Tone>(() => {
    const tones = this.servers().map((s) => s.tone);
    return (['error', 'busy', 'ok'] as const).find((t) => tones.includes(t)) ?? 'idle';
  });

  readonly summaryTitle = computed(() =>
    this.servers()
      .map((s) => `${s.id}: ${s.status}${s.message ? ` (${s.message})` : ''}`)
      .join('\n'),
  );

  private lastEvent: unknown;

  constructor() {
    this.output.show(LSP_CHANNEL); // the channel exists (and is selectable) before the first event

    // 1. Diagnostics -> Problems. One bulk update per publishDiagnostics; files that were cleared disappear.
    effect(() => {
      const byFile = this.lsp.diagnosticsByFile();
      const root = this.store.rootPath();

      const entries: Record<string, ProblemInput[]> = {};
      for (const f of Object.values(byFile)) {
        if (f.items.length === 0) continue;
        entries[f.path] = f.items.map((i) => ({
          severity: toSeverity(i.severity),
          message: i.message,
          path: displayPath(f.path, root),
          file: f.path,
          line: i.line + LINE_OFFSET,
          column: i.column + COLUMN_OFFSET,
          source: i.source ?? i.serverId,
          code: toCode(i.code),
        }));
      }
      untracked(() => this.diagnostics.syncOwners(OWNER_PREFIX, entries));
    });

    // 2. Lifecycle events -> Output. Appends every event since the last run (the console version only logged the newest).
    effect(() => {
      const events = this.lsp.events();

      let from = 0;
      if (this.lastEvent !== undefined) {
        const at = (events as readonly unknown[]).lastIndexOf(this.lastEvent);
        // not found = the log was reset or rotated: only take the newest instead of replaying everything
        from = at >= 0 ? at + 1 : Math.max(0, events.length - 1);
      }
      const fresh = events.slice(from);
      if (fresh.length === 0) return;
      this.lastEvent = events.at(-1);

      untracked(() => {
        const time = new Date().toLocaleTimeString([], { hour12: false });
        for (const e of fresh) {
          this.output.append(
            LSP_CHANNEL,
            `${time}  ${e.serverId}  →  ${e.status}${e.message ? `: ${e.message}` : ''}`,
          );
        }
      });
    });
  }

  /** Status bar click: show the Language Servers log. */
  openLog(): void {
    this.output.show(LSP_CHANNEL);
  }
}

// ----------------------------------------------------------------------------- mapping helpers
function toSeverity(raw: unknown): Severity {
  if (typeof raw === 'number') return raw === 1 ? 'error' : raw === 2 ? 'warning' : 'info'; // LSP numeric severities
  const s = String(raw ?? '').toLowerCase();
  if (s.startsWith('err')) return 'error';
  if (s.startsWith('warn')) return 'warning';
  return 'info'; // information / hint
}

function toCode(raw: unknown): string | number | undefined {
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'value' in raw)
    return toCode((raw as { value: unknown }).value);
  return undefined;
}

/** Heuristic on the status text. Replace with a switch over your real status values. */
function toneOf(status: string): Tone {
  const s = status.toLowerCase();
  if (/(error|crash|fail)/.test(s)) return 'error';
  if (/(start|init|load|index|connect|restart|busy)/.test(s)) return 'busy';
  if (/(ready|running|active|ok|idle)/.test(s)) return 'ok';
  return 'idle';
}

/** file:///C:/a/b.ts -> C:/a/b.ts, then relative to the workspace root when it is inside it. */
function displayPath(path: string, root: string | null): string {
  let p = path;
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    } catch {
      /* keep the raw string */
    }
  }
  p = p.replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (p.toLowerCase().startsWith(r.toLowerCase() + '/')) p = p.slice(r.length + 1);
  }
  return p;
}
