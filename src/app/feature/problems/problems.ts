import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Problem, Severity, DiagnosticsService } from '../../core/services/diagnostics.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAlertTriangle,
  lucideChevronDown,
  lucideChevronRight,
  lucideInfo,
  lucideOctagonX,
} from '@ng-icons/lucide';

/** One displayed row. `hint` rows are info items attached to the problem above them. */
interface Item {
  problem: Problem;
  hint: boolean;
}

interface FileGroup {
  path: string;
  name: string;
  dir: string;
  items: Item[];
  /** errors + warnings only (hints and loose info are not counted) */
  count: number;
}

interface Row {
  problem: Problem;
  hints: Problem[];
}

const GLYPH: Record<Severity, string> = {
  error: 'lucideOctagonX',
  warning: 'lucideAlertTriangle',
  info: 'lucideInfo',
};

const byPosition = (a: Problem, b: Problem) => a.line - b.line || a.column - b.column;

/** Same producer and (when both have one) the same code: the hint is about that problem. */
function sameOrigin(a: Problem, b: Problem): boolean {
  if ((a.source ?? '') !== (b.source ?? '')) return false;
  return a.code === undefined || b.code === undefined || a.code === b.code;
}

/** Attaches info items to the error/warning on the same line. Loose info stays a row of its own. */
function buildRows(problems: Problem[]): Row[] {
  const rows: Row[] = [];
  const primariesByLine = new Map<number, Row[]>();
  const infos: Problem[] = [];

  for (const p of [...problems].sort(byPosition)) {
    if (p.severity === 'info') {
      infos.push(p);
      continue;
    }
    const row: Row = { problem: p, hints: [] };
    rows.push(row);
    const sameLine = primariesByLine.get(p.line);
    if (sameLine) sameLine.push(row);
    else primariesByLine.set(p.line, [row]);
  }

  for (const h of infos) {
    const candidates = primariesByLine.get(h.line);
    const owner = candidates?.find((r) => sameOrigin(r.problem, h)) ?? candidates?.[0];
    if (owner) owner.hints.push(h);
    else rows.push({ problem: h, hints: [] }); // not about any problem: keep it standalone
  }

  return rows.sort((a, b) => byPosition(a.problem, b.problem));
}

function matches(p: Problem, query: string): boolean {
  return `${p.message} ${p.path} ${p.source ?? ''} ${p.code ?? ''}`.toLowerCase().includes(query);
}

@Component({
  selector: 'app-problems',
  template: `
    <div class="list scrolling-el">
      @for (g of groups(); track g.path) {
        <section>
          <button
            type="button"
            class="file"
            [attr.aria-expanded]="!collapsed().has(g.path)"
            (click)="toggleFile(g.path)"
          >
            <span class="chev">
              @if (collapsed().has(g.path)) {
                <ng-icon name="lucideChevronRight" />
              } @else {
                <ng-icon name="lucideChevronDown" />
              }
            </span>
            <span class="file__name">{{ g.name }}</span>
            <span class="file__dir">{{ g.dir }}</span>
            <span class="file__count">{{ g.count }}</span>
          </button>

          @if (!collapsed().has(g.path)) {
            @for (it of g.items; track it.problem.id) {
              <button
                type="button"
                class="item"
                [class.item--hint]="it.hint"
                (click)="open(it.problem)"
              >
                <span [class]="'glyph glyph--' + it.problem.severity">
                  <ng-icon [name]="glyph(it.problem.severity)" />
                </span>
                <span class="item__msg">{{ it.problem.message }}</span>
                <span class="item__meta">
                  @if (it.problem.source) {
                    {{ it.problem.source }}
                  }
                  @if (it.problem.code !== undefined) {
                    ({{ it.problem.code }})
                  }
                  [Ln {{ it.problem.line }}, Col {{ it.problem.column }}]
                </span>
              </button>
            }
          }
        </section>
      } @empty {
        <p class="empty">
          @if (diagnostics.problems().length === 0) {
            No problems have been detected.
          } @else {
            No problems match the filter.
          }
        </p>
      }
    </div>
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
        padding: 4px 8px;
      }
      .filter {
        flex: 1;
        min-width: 0;
      }
      .sev {
        display: flex;
        gap: 4px;
      }
      .sev__btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .sev__btn.is-off {
        opacity: 0.4;
      }
      .list {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: var(--space-2) 0;
      }
      .file,
      .item {
        display: flex;
        align-items: baseline;
        gap: var(--space-6);
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        &:hover {
          background-color: var(--color-surface-hover);
        }
      }
      .file {
        padding: var(--space-2) var(--space-8);
      }
      .chev {
        width: 1em;
      }
      .file__name {
        font-weight: var(--font-weight-semibold);
      }
      .file__dir {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file__count {
        padding: 0 var(--space-6);
        border-radius: var(--space-8);
        background: var(--color-surface-raised);
        font-size: var(--font-size-label);
      }
      .item {
        padding: var(--space-2) var(--space-8) var(--space-2) var(--space-24);
      }
      /* a hint belongs to the problem right above it */
      .item--hint {
        padding-left: 48px;
        opacity: 0.85;
      }
      .item__msg {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .item__meta {
        flex: none;
        color: var(--color-text-faint);
      }
      .glyph {
        flex: none;
        font-size: var(--font-size-label);
      }
      .glyph--error {
        color: var(--color-error-fg);
      }
      .glyph--warning {
        color: var(--color-warning-fg);
      }
      .glyph--info {
        color: var(--color-status-running);
      }
      .empty {
        display: inline-flex;
        align-items: center;
      }
    `,
  ],
  imports: [NgIcon],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideChevronRight,
      lucideOctagonX,
      lucideAlertTriangle,
      lucideInfo,
    }),
  ],
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Problems {
  protected readonly diagnostics = inject(DiagnosticsService);
  protected readonly counts = this.diagnostics.counts;

  protected readonly severities: { id: Severity; label: string }[] = [
    { id: 'error', label: 'errors' },
    { id: 'warning', label: 'warnings' },
    { id: 'info', label: 'info' },
  ];

  filter = input('');
  protected readonly visible = signal<Record<Severity, boolean>>({
    error: true,
    warning: true,
    info: true,
  });
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly groups = computed<FileGroup[]>(() => {
    const query = this.filter().trim().toLowerCase();
    const show = this.visible();
    const byPath = new Map<string, Problem[]>();

    for (const p of this.diagnostics.problems()) {
      let list = byPath.get(p.path);
      if (!list) byPath.set(p.path, (list = []));
      list.push(p);
    }

    const groups: FileGroup[] = [];

    for (const [path, problems] of byPath) {
      const items: Item[] = [];
      let count = 0;

      for (const row of buildRows(problems)) {
        if (!show[row.problem.severity]) continue; // hidden severity (hints follow their problem)
        const hints = show.info ? row.hints : [];
        if (query && !matches(row.problem, query) && !hints.some((h) => matches(h, query)))
          continue;

        items.push({ problem: row.problem, hint: false });
        for (const h of hints) items.push({ problem: h, hint: true });
        if (row.problem.severity !== 'info') count++;
      }

      if (items.length === 0) continue;

      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      groups.push({
        path,
        name: path.slice(cut + 1),
        dir: cut > 0 ? path.slice(0, cut) : '',
        items,
        count,
      });
    }

    return groups.sort((a, b) => a.path.localeCompare(b.path));
  });

  protected glyph(severity: Severity): string {
    return GLYPH[severity];
  }

  protected toggleSeverity(severity: Severity): void {
    this.visible.update((v) => ({ ...v, [severity]: !v[severity] }));
  }

  protected toggleFile(path: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  /** Called when a row (problem or hint) is clicked. Intentionally empty: it only exposes the location. */
  protected open(problem: Problem): void {
    this.diagnostics.reveal(problem);
  }
}
