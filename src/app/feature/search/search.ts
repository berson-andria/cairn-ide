import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { SearchService } from './search.service';
import { FileSearchResult, FileNameSearchResult, LineMatch, SearchFilters } from './search.model';
import { NodeStore } from '../../core/store/node.store';
import { ReplaceService } from '../../core/services/replace.service';
import { compilePattern, countMatches } from '../../shared/utils/replace.utils';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  debounceTime,
  distinctUntilChanged,
  map,
  Subject,
  Subscription,
  switchMap,
  tap,
} from 'rxjs';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCaseSensitive,
  lucideLoader2,
  lucideFilter,
  lucideUnlink2,
  lucideRefreshCcw,
  lucideWholeWord,
  lucideReplace,
  lucideReplaceAll,
  lucideFileText,
  lucideHash,
  lucideAtSign,
  lucideChevronRight,
} from '@ng-icons/lucide';
import { EditorCommands } from '../editor/editor.commands';
import { normalizePath, samePath } from '../../core/services/file-system/external-watcher.utils';
import { resolveNewPath } from '../../shared/utils/node.utils';
import { SearchResult } from './result/result';
import { TabStore } from '../../core/store/tab.store';

type SearchMode = 'file' | 'text' | 'tasks' | 'code' | 'commands';

interface SearchCriteria {
  mode: SearchMode;
  query: string;
  include: string;
  exclude: string;
  onlyPaths: string[] | null;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** One line of the list: a file that was found, or the "create this path" action. */
type Row =
  | { kind: 'file'; result: FileNameSearchResult }
  | { kind: 'text'; result: FileSearchResult }
  | { kind: 'task'; result: unknown }
  | { kind: 'code'; result: unknown }
  | { kind: 'command'; result: unknown }
  | { kind: 'create'; label: string; folder: boolean; input: string };

const looksLikePath = (q: string) =>
  /[\\/]/.test(q) || /\.[A-Za-z0-9]+$/.test(q) || q.startsWith('.');

@Component({
  selector: 'unified-search',
  templateUrl: './search.html',
  styleUrl: './search.scss',
  imports: [SearchResult, FormsModule, NgIcon],
  providers: [
    provideIcons({
      lucideLoader2,
      lucideRefreshCcw,
      lucideFilter,
      lucideCaseSensitive,
      lucideWholeWord,
      lucideUnlink2,
      lucideReplace,
      lucideReplaceAll,
      lucideFileText,
      lucideHash,
      lucideAtSign,
      lucideChevronRight,
    }),
  ],
})
export class Search implements OnInit, OnDestroy {
  private readonly tabStore = inject(TabStore);
  readonly nodeStore = inject(NodeStore);
  searchService = inject(SearchService);
  replaceService = inject(ReplaceService);
  command = inject(EditorCommands);
  private dialogRef = inject(DialogRef, { optional: true });

  rootPath = this.nodeStore.rootPath;
  keyword = signal('');
  warningMessage = signal('');

  // Search results by mode
  fileSearchResults = signal<FileNameSearchResult[]>([]);
  textSearchResults = signal<FileSearchResult[]>([]);
  taskSearchResults = signal<unknown[]>([]);
  codeSearchResults = signal<unknown[]>([]);
  commandSearchResults = signal<unknown[]>([]);

  // Mode detection
  currentMode = computed(() => this.detectMode(this.keyword()));

  cleanKeyword = computed(() => this.cleanQuery(this.keyword()));

  // Replace (text search only)
  showReplace = signal(false);
  replacement = signal('');
  isReplacing = signal(false);
  private query = signal('');
  caseSensitive = signal(false);
  wholeWord = signal(false);
  compiled = computed(() =>
    compilePattern(this.query().trim(), {
      caseSensitive: this.caseSensitive(),
      wholeWord: this.wholeWord(),
    }),
  );
  canReplace = computed(
    () =>
      this.currentMode() === 'text' &&
      !!this.compiled().re &&
      this.textSearchResults().length > 0 &&
      !this.isReplacing(),
  );

  // Filters (text search only)
  showFilters = signal(false);
  include = signal('');
  exclude = signal('');
  openEditorsOnly = signal(false);
  activeFilterCount = computed(
    () =>
      (this.include().trim() ? 1 : 0) +
      (this.exclude().trim() ? 1 : 0) +
      (this.openEditorsOnly() ? 1 : 0),
  );

  isSearching = signal(false);
  searched = signal(false);

  // File search list
  private resolved = computed(() =>
    resolveNewPath(
      this.keyword()
        .trim()
        .replace(/^[/@#>]\s?/, ''),
    ),
  );

  private createRow = computed<Extract<Row, { kind: 'create' }> | null>(() => {
    const root = this.rootPath();
    const path = this.resolved();
    const mode = this.currentMode();

    // Create row only available in file mode
    if (mode !== 'file' || !root || !path.ok || this.isSearching()) return null;

    const absolute = normalizePath(`${root}\\${path.segments.join('\\')}`);
    if (this.fileSearchResults().some((r) => samePath(r.path, absolute))) return null;

    return {
      kind: 'create',
      label: path.display,
      folder: path.isFolder,
      input: this.keyword()
        .trim()
        .replace(/^[/@#>]\s?/, ''),
    };
  });

  rows = computed<Row[]>(() => {
    const mode = this.currentMode();
    const rows: Row[] = [];

    if (mode === 'file') {
      rows.push(...this.fileSearchResults().map((result) => ({ kind: 'file' as const, result })));
      const create = this.createRow();
      if (create) rows.push(create);
    } else if (mode === 'text') {
      rows.push(
        ...this.textSearchResults().map((result) => ({
          kind: 'text' as const,
          result,
        })),
      );
    } else if (mode === 'tasks') {
      rows.push(...this.taskSearchResults().map((result) => ({ kind: 'task' as const, result })));
    } else if (mode === 'code') {
      rows.push(...this.codeSearchResults().map((result) => ({ kind: 'code' as const, result })));
    } else if (mode === 'commands') {
      rows.push(
        ...this.commandSearchResults().map((result) => ({
          kind: 'command' as const,
          result,
        })),
      );
    }

    return rows;
  });

  activeIndex = signal(-1);
  private rowEls = viewChildren<ElementRef<HTMLElement>>('row');

  @ViewChild('searchInput', { static: false }) searchInput!: ElementRef<HTMLInputElement>;

  rowKey = (row: Row) => {
    if (row.kind === 'file') return row.result.path;
    if (row.kind === 'create') return '__create__';
    if (row.kind === 'text') return row.result.path;
    return `${row.kind}-${JSON.stringify(row.result)}`;
  };

  private searchTerms = new Subject<void>();
  private searchSubscription!: Subscription;

  constructor() {
    // Opening/closing tabs changes what "open editors only" means: search again
    effect(() => {
      this.tabStore.openTabs();
      untracked(() => {
        if (this.openEditorsOnly() && this.currentMode() === 'text') this.trigger();
      });
    });

    // New list -> select the best candidate
    effect(() => {
      this.rows();
      untracked(() => this.activeIndex.set(this.defaultIndex()));
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
    if (!this.rootPath()) {
      this.warningMessage.set('You have to select a folder first.');
    }

    // Focus the search input when component initializes
    setTimeout(() => this.focusSearchInput(), 0);

    this.searchSubscription = this.searchTerms
      .pipe(
        debounceTime(250),
        map(() => this.criteria()),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap((c) => {
          this.isSearching.set(this.hasQuery(c.query));
          if (!this.hasQuery(c.query)) {
            this.fileSearchResults.set([]);
            this.textSearchResults.set([]);
            this.taskSearchResults.set([]);
            this.codeSearchResults.set([]);
            this.commandSearchResults.set([]);
            this.warningMessage.set('');
            this.searched.set(false);
          }
        }),
        switchMap((c) => this.run(c)),
      )
      .subscribe((results) => {
        this.isSearching.set(false);
        if (results.mode === 'file') {
          this.fileSearchResults.set(results.data as FileNameSearchResult[]);
        } else if (results.mode === 'text') {
          this.textSearchResults.set(results.data as FileSearchResult[]);
        } else if (results.mode === 'tasks') {
          this.taskSearchResults.set(results.data as unknown[]);
        } else if (results.mode === 'code') {
          this.codeSearchResults.set(results.data as unknown[]);
        } else if (results.mode === 'commands') {
          this.commandSearchResults.set(results.data as unknown[]);
        }
        this.searched.set(true);
      });
  }

  detectMode(input: string): SearchMode {
    const trimmed = input.trim();
    if (trimmed.startsWith('/')) return 'text';
    if (trimmed.startsWith('#')) return 'tasks';
    if (trimmed.startsWith('@')) return 'code';
    if (trimmed.startsWith('>')) return 'commands';
    return 'file';
  }

  onValueChange(value: string) {
    this.keyword.set(value);
    this.query.set(this.cleanQuery(value));
    this.warningMessage.set('');
    this.trigger();
  }

  cleanQuery(input: string): string {
    return input.replace(/^[/@#>]\s?/, '');
  }

  toggleCaseSensitive() {
    this.caseSensitive.update((v) => !v);
    this.trigger();
  }

  toggleWholeWord() {
    this.wholeWord.update((v) => !v);
    this.trigger();
  }

  trigger() {
    this.searchTerms.next();
  }

  // ───────────── Text search: replace ─────────────

  async replaceAll() {
    const re = this.compiled().re;
    const results = this.textSearchResults();
    if (!re || !results.length || this.isReplacing()) return;

    const matches = results.reduce(
      (total, r) => total + r.matches.reduce((n, line) => n + countMatches(line.text, re), 0),
      0,
    );
    const s = (n: number) => (n === 1 ? '' : 's');
    const confirmed = await ask(
      `Replace ${matches} match${matches === 1 ? '' : 'es'} in ${results.length} file${s(results.length)} with "${this.replacement()}"?\n\n` +
        'Files open in the editor are changed but not saved. All other files are written to disk.',
      { title: 'Replace in files', kind: 'warning', okLabel: 'Replace', cancelLabel: 'Cancel' },
    );
    if (confirmed)
      await this.applyReplace(results.map((r) => ({ path: r.path, lines: r.matches })));
  }

  replaceInFile(result: FileSearchResult) {
    return this.applyReplace([{ path: result.path, lines: result.matches }]);
  }

  replaceInLine(result: FileSearchResult, line: LineMatch) {
    return this.applyReplace([{ path: result.path, lines: [line] }]);
  }

  private async applyReplace(targets: { path: string; lines: LineMatch[] }[]) {
    const re = this.compiled().re;
    if (!re || this.isReplacing()) return;

    this.isReplacing.set(true);
    const done = new Map<string, Set<number>>();
    const problems: string[] = [];
    let skipped = 0;
    try {
      for (const target of targets) {
        const outcome = await this.replaceService.replaceLines(
          target.path,
          target.lines.map((l) => ({ lineNumber: l.lineNumber, text: l.text })),
          re,
          this.replacement(),
        );
        if (outcome.error) problems.push(outcome.error);
        skipped += outcome.skipped.length;
        done.set(target.path, new Set(outcome.replaced));
      }
    } finally {
      this.isReplacing.set(false);
    }

    this.textSearchResults.update((list) =>
      list
        .map((r) => {
          const gone = done.get(r.path);
          return gone ? { ...r, matches: r.matches.filter((m) => !gone.has(m.lineNumber)) } : r;
        })
        .filter((r) => r.matches.length > 0),
    );

    if (skipped) {
      problems.push(
        `${skipped} match${skipped === 1 ? ' was' : 'es were'} skipped because the file changed since the search. Search again to refresh.`,
      );
    }
    this.warningMessage.set(problems.join(' '));
  }

  // ───────────── Keyboard navigation (file & placeholder modes) ─────────────

  onKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const mode = this.currentMode();

    // Only file mode has keyboard navigation
    if (mode !== 'file') return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        return this.move(+1);
      case 'ArrowUp':
        event.preventDefault();
        return this.move(-1);
      case 'Enter':
        event.preventDefault();
        return void this.onEnter(event.shiftKey);
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

  private async onEnter(forceCreate: boolean) {
    if (this.isSearching()) return;
    await this.activate(forceCreate);
  }

  private defaultIndex(): number {
    const rows = this.rows();
    const mode = this.currentMode();

    if (mode === 'file') {
      if (rows[0]?.kind === 'file') return 0;
      if (rows[0]?.kind === 'create' && looksLikePath(this.keyword().trim())) return 0;
    }
    return -1;
  }

  // ───────────── Actions ─────────────

  async activate(forceCreate = false) {
    const rows = this.rows();
    const mode = this.currentMode();
    const row = forceCreate ? rows.find((r) => r.kind === 'create') : rows[this.activeIndex()];
    if (!row) return;

    if (row.kind === 'file') return this.openFile(row.result);
    if (row.kind === 'create') return this.create(row);
    // Placeholder for other modes
  }

  private async openFile(result: FileNameSearchResult) {
    this.dialogRef?.close();
    const fileId = await this.nodeStore.resolveFileId(result.path);
    if (!fileId) return;
    this.nodeStore.revealInExplorer(fileId);
    await this.command.openFile(fileId);
  }

  async create(row: Extract<Row, { kind: 'create' }>) {
    const { error, fileId } = await this.nodeStore.createPathFromSearch(row.input);
    if (error) {
      this.warningMessage.set(error);
      return;
    }
    this.nodeStore.revealInExplorer(fileId!);
    await this.command.openFile(fileId!);
    this.dialogRef?.close();
  }

  // ───────────── Private helpers ─────────────

  private criteria(): SearchCriteria {
    const cleanQuery = this.keyword()
      .trim()
      .replace(/^[/@#>]\s?/, '');
    return {
      mode: this.currentMode(),
      query: cleanQuery,
      include: this.include().trim(),
      exclude: this.exclude().trim(),
      onlyPaths: this.openEditorsOnly() ? this.openFilePaths() : null,
      caseSensitive: this.caseSensitive(),
      wholeWord: this.wholeWord(),
    };
  }

  private hasQuery(query: string): boolean {
    return query.trim().length > 0;
  }

  private openFilePaths(): string[] {
    const nodes = this.nodeStore.nodes();
    return this.tabStore
      .openTabs()
      .map((id) => nodes[id]?.path)
      .filter((p): p is string => !!p);
  }

  private async run(
    c: SearchCriteria,
  ): Promise<{ mode: SearchMode; data: FileNameSearchResult[] | FileSearchResult[] | unknown[] }> {
    if (!this.hasQuery(c.query)) return { mode: c.mode, data: [] };

    const root = this.rootPath();
    if (!root) {
      this.warningMessage.set('You have to select a folder first.');
      return { mode: c.mode, data: [] };
    }

    try {
      this.warningMessage.set('');

      if (c.mode === 'file') {
        return {
          mode: 'file',
          data: await this.searchService.searchWorkspaceFile(root, c.query),
        };
      } else if (c.mode === 'text') {
        if (c.onlyPaths && c.onlyPaths.length === 0) {
          this.warningMessage.set('No files are open in the editor.');
          return { mode: 'text', data: [] };
        }
        return {
          mode: 'text',
          data: await this.searchService.seachWorkspaceKeyword(root, c.query, {
            include: c.include,
            exclude: c.exclude,
            onlyPaths: c.onlyPaths,
            caseSensitive: c.caseSensitive,
            wholeWord: c.wholeWord,
          }),
        };
      } else if (c.mode === 'tasks') {
        // Placeholder: return empty for now
        this.warningMessage.set('Task search is not yet implemented.');
        return { mode: 'tasks', data: [] };
      } else if (c.mode === 'code') {
        // Placeholder: return empty for now
        this.warningMessage.set('Code search is not yet implemented.');
        return { mode: 'code', data: [] };
      } else if (c.mode === 'commands') {
        // Placeholder: return empty for now
        this.warningMessage.set('Command search is not yet implemented.');
        return { mode: 'commands', data: [] };
      }

      return { mode: c.mode, data: [] };
    } catch (err) {
      this.warningMessage.set(typeof err === 'string' ? err : 'Search failed.');
      return { mode: c.mode, data: [] };
    }
  }

  ngOnDestroy(): void {
    if (this.searchSubscription) {
      this.searchSubscription.unsubscribe();
    }
  }

  private focusSearchInput(): void {
    if (this.searchInput?.nativeElement) {
      this.searchInput.nativeElement.focus();
      this.searchInput.nativeElement.select();
    }
  }
}
