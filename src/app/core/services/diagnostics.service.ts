import { Injectable, computed, signal } from '@angular/core';

export type Severity = 'error' | 'warning' | 'info';

export interface ProblemInput {
  severity: Severity;
  message: string;
  /** Path as it should be displayed (relative to the workspace reads best). */
  path: string;
  /** Full path / URI used to open the file when the row is clicked. Falls back to `path`. */
  file?: string;
  line: number;
  column: number;
  source?: string;
  code?: string | number;
}

export interface Problem extends ProblemInput {
  id: string;
}

/**
 * Collects problems from any producer (Monaco markers, a linter, a build...).
 * A producer owns a key ("owner", e.g. a file URI or "tsc") and replaces all of its problems at once.
 */
@Injectable({ providedIn: 'root' })
export class DiagnosticsService {
  private readonly byOwner = signal<ReadonlyMap<string, readonly Problem[]>>(new Map());

  readonly problems = computed(() => [...this.byOwner().values()].flat());
  readonly counts = computed(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const p of this.problems()) c[p.severity]++;
    return c;
  });

  /** The Problems list sets this when a row is clicked; the editor opens the file and goes to the position. */
  readonly revealRequest = signal<{ problem: Problem; n: number } | null>(null);
  private revealCount = 0;

  set(owner: string, problems: readonly ProblemInput[]): void {
    this.byOwner.update((map) => {
      const next = new Map(map);
      if (problems.length === 0) next.delete(owner);
      else next.set(owner, problems.map((p, i) => ({ ...p, id: `${owner}#${i}` })));
      return next;
    });
  }

  /**
   * Replaces EVERYTHING a producer published, in one update: owners that start with `prefix`
   * and are missing from `entries` are removed (e.g. a file whose diagnostics were cleared).
   * `entries` is keyed by file / owner name.
   */
  syncOwners(prefix: string, entries: Record<string, readonly ProblemInput[]>): void {
    this.byOwner.update((map) => {
      const next = new Map<string, readonly Problem[]>();
      for (const [owner, list] of map) if (!owner.startsWith(prefix)) next.set(owner, list);
      for (const [key, list] of Object.entries(entries)) {
        if (list.length === 0) continue;
        const owner = prefix + key;
        next.set(owner, list.map((p, i) => ({ ...p, id: `${owner}#${i}` })));
      }
      return next;
    });
  }

  clear(owner?: string): void {
    if (owner === undefined) this.byOwner.set(new Map());
    else this.set(owner, []);
  }

  reveal(problem: Problem): void {
    this.revealRequest.set({ problem, n: ++this.revealCount });
  }
}
