import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Problem, Severity, DiagnosticsService } from '../../core/services/diagnostics.service';

interface FileGroup {
  path: string;
  name: string;
  dir: string;
  items: Problem[];
}

const GLYPH: Record<Severity, string> = { error: '●', warning: '▲', info: '●' };

@Component({
  selector: 'app-problems',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- <div class="bar">
      <input
        class="filter"
        type="search"
        placeholder="Filter by text or file"
        aria-label="Filter problems"
        spellcheck="false"
        [value]="filter()"
        (input)="onFilter($event)"
      />
      <div class="sev">
        @for (s of severities; track s.id) {
          <button
            type="button"
            class="sev__btn"
            [class.is-off]="!visible()[s.id]"
            [attr.aria-pressed]="visible()[s.id]"
            [title]="'Show ' + s.label"
            (click)="toggleSeverity(s.id)"
          >
            <span class="glyph" [class]="'glyph glyph--' + s.id">{{ glyph(s.id) }}</span>
            {{ counts()[s.id] }}
          </button>
        }
      </div>
    </div> -->

    <div class="list">
      @for (g of groups(); track g.path) {
        <section>
          <button
            type="button"
            class="file"
            [attr.aria-expanded]="!collapsed().has(g.path)"
            (click)="toggleFile(g.path)"
          >
            <span class="chev">{{ collapsed().has(g.path) ? '▸' : '▾' }}</span>
            <span class="file__name">{{ g.name }}</span>
            <span class="file__dir">{{ g.dir }}</span>
            <span class="file__count">{{ g.items.length }}</span>
          </button>

          @if (!collapsed().has(g.path)) {
            @for (p of g.items; track p.id) {
              <button type="button" class="item" (click)="diagnostics.reveal(p)">
                <span [class]="'glyph glyph--' + p.severity">{{ glyph(p.severity) }}</span>
                <span class="item__msg">{{ p.message }}</span>
                <span class="item__meta">
                  @if (p.source) {
                    {{ p.source }}
                  }
                  @if (p.code !== undefined) {
                    ({{ p.code }})
                  }
                  [Ln {{ p.line }}, Col {{ p.column }}]
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
      .list {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 2px 0;
      }
      .file,
      .item {
        display: flex;
        align-items: baseline;
        gap: 6px;
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .file {
        padding: 3px 8px;
      }
      .file:hover,
      .item:hover {
        // background: #2c313c;
      }
      .chev {
        width: 1em;
      }
      .file__name {
        font-weight: 600;
      }
      .file__dir {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file__count {
        padding: 0 6px;
        border-radius: 8px;
        background: #2c313c;
        font-size: 11px;
      }
      .item {
        padding: 2px 8px 2px 28px;
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
        color: #7f848e;
      }
      .glyph {
        flex: none;
        font-size: 11px;
      }
      .glyph--error {
        color: #e05561;
      }
      .glyph--warning {
        color: #d18f52;
      }
      .glyph--info {
        color: #4aa5f0;
      }
      .empty {
        display: inline-flex;
        align-items: center;
      }
    `,
  ],
})
export class Problems {
  protected readonly diagnostics = inject(DiagnosticsService);
  protected readonly counts = this.diagnostics.counts;

  protected readonly severities: { id: Severity; label: string }[] = [
    { id: 'error', label: 'errors' },
    { id: 'warning', label: 'warnings' },
    { id: 'info', label: 'info' },
  ];

  protected readonly filter = signal('');
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
      if (!show[p.severity]) continue;
      if (
        query &&
        !`${p.message} ${p.path} ${p.source ?? ''} ${p.code ?? ''}`.toLowerCase().includes(query)
      )
        continue;
      let list = byPath.get(p.path);
      if (!list) byPath.set(p.path, (list = []));
      list.push(p);
    }

    return [...byPath.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, items]) => {
        const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return {
          path,
          name: path.slice(cut + 1),
          dir: cut > 0 ? path.slice(0, cut) : '',
          items: [...items].sort((a, b) => a.line - b.line || a.column - b.column),
        };
      });
  });

  protected glyph(severity: Severity): string {
    return GLYPH[severity];
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
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
}
