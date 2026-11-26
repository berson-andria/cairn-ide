import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFileText,
  lucideListChecks,
  lucideLoader2,
  lucideSearch,
  lucideStickyNote,
} from '@ng-icons/lucide';
import {
  Subject,
  Subscription,
  debounceTime,
  distinctUntilChanged,
  map,
  switchMap,
  tap,
} from 'rxjs';
import { samePath } from '../../../core/services/file-system/external-watcher.utils';
import { SearchService } from '../../../feature/search/search.service';
import { FileNameSearchResult, FileSearchResult } from '../../../feature/search/search.model';
import type { NoteItem } from '../../../feature/notes/note.service';
import type { TaskItem } from '../../../feature/tasks/task.service';
import {
  PickerConfig,
  PickResult,
  PickSource,
  SOURCE_LABEL,
  SOURCE_PLACEHOLDER,
} from './picker.model';
import { FileIcon } from '../file-icon';

type Row =
  | { kind: 'file'; key: string; path: string; name: string; dir: string }
  | {
      kind: 'text';
      key: string;
      path: string;
      name: string;
      dir: string;
      lineNumber: number;
      text: string;
    }
  | { kind: 'note'; key: string; note: NoteItem }
  | { kind: 'task'; key: string; task: TaskItem };

const MAX_TEXT_ROWS = 300;
const isRemote = (s: PickSource) => s === 'file' || s === 'text';

function splitPath(root: string | null | undefined, path: string) {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const r = root ? norm(root).replace(/\/+$/, '') : '';
  const p = norm(path);
  const rel = r && p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p;
  const i = rel.lastIndexOf('/');
  return { name: i < 0 ? rel : rel.slice(i + 1), dir: i < 0 ? '' : rel.slice(0, i) };
}

@Component({
  selector: 'picker',
  templateUrl: './picker.html',
  styleUrl: './picker.scss',
  imports: [FormsModule, NgIcon, FileIcon],
  providers: [
    provideIcons({
      lucideFileText,
      lucideListChecks,
      lucideLoader2,
      lucideSearch,
      lucideStickyNote,
    }),
  ],
})
export class Picker implements OnInit, OnDestroy {
  /**
   * Set by DialogWrapper (Object.assign onto the instance), after construction and before
   * ngOnInit. Keep it a plain property: a signal/input here would be overwritten.
   */
  config: PickerConfig = { sources: ['file'] };

  private readonly searchService = inject(SearchService);
  private readonly dialogRef = inject(DialogRef, { optional: true });

  readonly labels = SOURCE_LABEL;
  readonly placeholders = SOURCE_PLACEHOLDER;
  readonly icons: Record<PickSource, string> = {
    file: 'lucideFileText',
    text: 'lucideSearch',
    note: 'lucideStickyNote',
    task: 'lucideListChecks',
  };

  readonly rootPath = () => this.config.rootPath ?? null;
  readonly sources = signal<PickSource[]>(['file']);
  readonly source = signal<PickSource>('file');
  readonly keyword = signal('');
  readonly isSearching = signal(false);
  readonly searched = signal(false);
  readonly warningMessage = signal('');
  readonly activeIndex = signal(-1);

  private readonly fileHits = signal<FileNameSearchResult[]>([]);
  private readonly textHits = signal<FileSearchResult[]>([]);

  readonly rows = computed<Row[]>(() => {
    const q = this.keyword().trim().toLowerCase();
    const root = this.rootPath();
    const ex = this.config.exclude;
    const skipPath = (p: string) => !!ex?.paths?.some((x) => samePath(x, p));

    switch (this.source()) {
      case 'file':
        return this.fileHits()
          .filter((h) => !skipPath(h.path))
          .map((h) => ({
            kind: 'file' as const,
            key: h.path,
            path: h.path,
            ...splitPath(root, h.path),
          }));

      case 'text': {
        const out: Row[] = [];
        for (const hit of this.textHits()) {
          if (skipPath(hit.path)) continue;
          const parts = splitPath(root, hit.path);
          for (const m of hit.matches) {
            if (out.length >= MAX_TEXT_ROWS) return out;
            out.push({
              kind: 'text',
              key: `${hit.path}:${m.lineNumber}`,
              path: hit.path,
              ...parts,
              lineNumber: m.lineNumber,
              text: m.text.trim(),
            });
          }
        }
        return out;
      }

      case 'note': {
        const hidden = new Set(ex?.noteIds ?? []);
        return (this.config.items?.notes ?? [])
          .filter((n) => !hidden.has(n.id))
          .filter(
            (n) =>
              !q || n.content.toLowerCase().includes(q) || (n.type ?? '').toLowerCase().includes(q),
          )
          .map((note) => ({ kind: 'note' as const, key: `note-${note.id}`, note }));
      }

      case 'task': {
        const hidden = new Set(ex?.taskIds ?? []);
        return (this.config.items?.tasks ?? [])
          .filter((t) => !hidden.has(t.id))
          .filter(
            (t) =>
              !q ||
              t.title.toLowerCase().includes(q) ||
              (t.description ?? '').toLowerCase().includes(q),
          )
          .map((task) => ({ kind: 'task' as const, key: `task-${task.id}`, task }));
      }
    }
  });

  readonly hint = computed(() => {
    if (isRemote(this.source()) && !this.keyword().trim()) {
      return `Type to search ${this.labels[this.source()].toLowerCase()}.`;
    }
    return this.rows().length ? '↑↓ move · Enter select' : '';
  });

  readonly emptyMessage = computed(() => {
    if (this.warningMessage() || this.rows().length || this.isSearching()) return '';
    if (isRemote(this.source())) return this.searched() ? 'No results found.' : '';
    return this.keyword().trim()
      ? 'No results found.'
      : `No ${this.labels[this.source()].toLowerCase()} yet.`;
  });

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly rowEls = viewChildren<ElementRef<HTMLElement>>('rowEl');
  private readonly terms = new Subject<void>();
  private sub?: Subscription;

  constructor() {
    // New list -> select the first candidate
    effect(() => {
      const count = this.rows().length;
      untracked(() => this.activeIndex.set(count ? 0 : -1));
    });

    // Keep the selected row visible
    effect(() => {
      const i = this.activeIndex();
      untracked(() =>
        setTimeout(() => this.rowEls()[i]?.nativeElement.scrollIntoView({ block: 'nearest' })),
      );
    });
  }

  ngOnInit(): void {
    const allowed = this.config.sources?.length ? this.config.sources : (['file'] as PickSource[]);
    this.sources.set(allowed);
    this.source.set(allowed[0]);

    if (allowed.some(isRemote) && !this.rootPath()) {
      this.warningMessage.set('You have to select a folder first.');
    }

    setTimeout(() => this.searchInput()?.nativeElement.focus());

    this.sub = this.terms
      .pipe(
        debounceTime(250),
        map(() => ({ source: this.source(), query: this.keyword().trim() })),
        distinctUntilChanged((a, b) => a.source === b.source && a.query === b.query),
        tap((c) => {
          this.isSearching.set(isRemote(c.source) && !!c.query);
          if (!c.query) {
            this.fileHits.set([]);
            this.textHits.set([]);
            this.searched.set(false);
            if (this.rootPath()) this.warningMessage.set('');
          }
        }),
        switchMap((c) => this.run(c)),
      )
      .subscribe(({ source, data }) => {
        this.isSearching.set(false);
        if (source === 'file') this.fileHits.set(data as FileNameSearchResult[]);
        if (source === 'text') this.textHits.set(data as FileSearchResult[]);
        this.searched.set(true);
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  // ───────────── Input ─────────────

  onValueChange(value: string) {
    this.keyword.set(value);
    this.trigger();
  }

  setSource(next: PickSource) {
    if (next === this.source()) return;
    this.source.set(next);
    this.searched.set(false);
    this.trigger();
    this.searchInput()?.nativeElement.focus();
  }

  private trigger() {
    this.terms.next();
  }

  onKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        return this.move(+1);
      case 'ArrowUp':
        event.preventDefault();
        return this.move(-1);
      case 'Enter':
        event.preventDefault();
        return this.pick(this.rows()[this.activeIndex()]);
    }
  }

  private move(delta: 1 | -1) {
    const count = this.rows().length;
    if (!count) return;
    const current = this.activeIndex();
    this.activeIndex.set(
      current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count,
    );
  }

  // ───────────── Selection ─────────────

  pick(row: Row | undefined) {
    if (!row || this.isSearching()) return;
    let result: PickResult;
    switch (row.kind) {
      case 'file':
      case 'text': {
        const node = this.config.items?.files.find((candidate) =>
          samePath(candidate.path, row.path),
        );
        if (!node) {
          this.warningMessage.set('The selected file is no longer in the workspace.');
          return;
        }
        result = {
          kind: 'file',
          id: node.id,
          path: row.path,
          ...(row.kind === 'text' ? { lineNumber: row.lineNumber } : {}),
        };
        break;
      }
      case 'note':
        result = { kind: 'note', id: row.note.id };
        break;
      case 'task':
        result = { kind: 'task', id: row.task.id };
        break;
    }
    this.dialogRef?.close(result);
  }

  // ───────────── Remote search (files, text) ─────────────

  private async run(c: {
    source: PickSource;
    query: string;
  }): Promise<{ source: PickSource; data: unknown[] }> {
    if (!c.query || !isRemote(c.source)) return { source: c.source, data: [] };

    const root = this.rootPath();
    if (!root) {
      this.warningMessage.set('You have to select a folder first.');
      return { source: c.source, data: [] };
    }

    try {
      this.warningMessage.set('');
      if (c.source === 'file') {
        return {
          source: 'file',
          data: await this.searchService.searchWorkspaceFile(root, c.query),
        };
      }
      return {
        source: 'text',
        data: await this.searchService.seachWorkspaceKeyword(root, c.query, {
          include: '',
          exclude: '',
          onlyPaths: null,
        }),
      };
    } catch (err) {
      this.warningMessage.set(typeof err === 'string' ? err : 'Search failed.');
      return { source: c.source, data: [] };
    }
  }
}
