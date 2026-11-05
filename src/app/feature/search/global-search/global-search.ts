import {
  Component,
  computed,
  effect,
  inject,
  OnDestroy,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import { LineMatch, SearchResult } from './result/result';
import { NodeStore } from '../../../core/store/node.store';
import { ReplaceService } from '../../../core/services/replace.service';
import { compilePattern, countMatches } from '../../../shared/utils/replace.utils';
import { ask } from '@tauri-apps/plugin-dialog';
import { FormsModule } from '@angular/forms';
import {
  debounceTime,
  distinctUntilChanged,
  map,
  Subject,
  Subscription,
  switchMap,
  tap,
} from 'rxjs';
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
} from '@ng-icons/lucide';
import { SearchService } from '../search.service';

import { FileSearchResult } from '../search.model';
import { TabStore } from '../../../core/store/tab.store';

interface SearchCriteria {
  query: string;
  include: string;
  exclude: string;
  onlyPaths: string[] | null;
}

@Component({
  selector: 'search-panel',
  templateUrl: './global-search.html',
  styleUrl: './global-search.scss',
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
    }),
  ],
})
export class GlobalSearch implements OnInit, OnDestroy {
  private readonly tabStore = inject(TabStore);
  readonly nodeStore = inject(NodeStore);
  searchService = inject(SearchService);
  replaceService = inject(ReplaceService);

  rootPath = this.nodeStore.rootPath;
  searchResults = signal<FileSearchResult[]>([]);
  keyword: string = '';

  // replace
  showReplace = signal(false);
  replacement = signal('');
  isReplacing = signal(false);
  private query = signal('');
  /** The search text compiled for replacing (the search itself runs in Rust). */
  compiled = computed(() => compilePattern(this.query().trim()));
  canReplace = computed(
    () => !!this.compiled().re && this.searchResults().length > 0 && !this.isReplacing(),
  );

  // filters
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
  warningMessage = signal('');
  searched = signal(false); // true once a search has completed, so "no results" isn't shown before the first one

  /** Every input (query, filters) just pings this; the pipeline below reads the current values. */
  private trigger$ = new Subject<void>();
  private searchSubscription!: Subscription;

  constructor() {
    // Opening or closing a tab changes what "open editors only" means: search again.
    effect(() => {
      this.tabStore.openTabs();
      untracked(() => {
        if (this.openEditorsOnly()) this.trigger();
      });
    });
  }

  ngOnInit(): void {
    if (!this.rootPath()) {
      this.warningMessage.set('You have to select a folder first.');
    }
    this.searchSubscription = this.trigger$
      .pipe(
        debounceTime(250),
        map(() => this.criteria()),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap((c) => {
          this.isSearching.set(c.query.length > 0);
          if (!c.query) {
            this.searchResults.set([]);
            this.warningMessage.set('');
            this.searched.set(false);
          }
        }),
        // switchMap drops the answer of a superseded search (and the Rust side stops early).
        switchMap((c) => this.run(c)),
      )
      .subscribe((results) => {
        this.isSearching.set(false);
        this.searchResults.set(results);
        this.searched.set(true);
      });
  }

  onValueChange(value: string) {
    this.keyword = value;
    this.query.set(value);
    this.trigger();
  }

  trigger() {
    this.trigger$.next();
  }

  // ───────────── replace ─────────────

  async replaceAll() {
    const re = this.compiled().re;
    const results = this.searchResults();
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

    // Drop what was replaced from the list. (Re-running the search would bring open files back,
    // because the search reads disk and those edits are not saved yet.)
    this.searchResults.update((list) =>
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

  private criteria(): SearchCriteria {
    return {
      query: this.keyword.trim(),
      include: this.include().trim(),
      exclude: this.exclude().trim(),
      onlyPaths: this.openEditorsOnly() ? this.openFilePaths() : null,
    };
  }

  private openFilePaths(): string[] {
    const nodes = this.nodeStore.nodes();
    return this.tabStore
      .openTabs()
      .map((id) => nodes[id]?.path)
      .filter((p): p is string => !!p);
  }

  /** Never rejects: a rejection would kill the whole pipeline and typing would stop searching. */
  private async run(c: SearchCriteria): Promise<FileSearchResult[]> {
    if (!c.query) return [];
    const root = this.rootPath();
    if (!root) {
      this.warningMessage.set('You have to select a folder first.');
      return [];
    }
    if (c.onlyPaths && c.onlyPaths.length === 0) {
      this.warningMessage.set('No files are open in the editor.');
      return [];
    }
    try {
      this.warningMessage.set('');
      return await this.searchService.seachWorkspaceKeyword(root, c.query, {
        include: c.include,
        exclude: c.exclude,
        onlyPaths: c.onlyPaths,
      });
    } catch (err) {
      // Rust reports bad globs / bad regexes as readable strings.
      this.warningMessage.set(typeof err === 'string' ? err : 'Search failed.');
      return [];
    }
  }

  reload() {}

  ngOnDestroy(): void {
    if (this.searchSubscription) {
      this.searchSubscription.unsubscribe();
    }
  }
}
