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
  viewChildren,
} from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { SearchService } from '../search.service';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { Subject, Subscription, debounceTime, switchMap, tap } from 'rxjs';
import { SearchResult } from './result/result';
import { FormsModule } from '@angular/forms';
import { provideIcons } from '@ng-icons/core';
import {
  lucideLoader2,
  lucideRefreshCcw,
  lucideFilter,
  lucideCaseSensitive,
  lucideWholeWord,
  lucideUnlink2,
} from '@ng-icons/lucide';
import { normalizePath, samePath } from '../../../core/services/file-system/external-watcher.utils';
import { resolveNewPath } from '../../../shared/utils/node.utils';
import { EditorCommands } from '../../editor/editor.commands';

/** One line of the list: a file that was found, or the "create this path" action. */
type Row =
  | { kind: 'file'; result: FileNameSearchResult }
  | { kind: 'create'; label: string; folder: boolean; input: string };

/** "src/a", "a.ts", ".env" look like paths; a bare word like "mian" is more likely a typo. */
const looksLikePath = (q: string) =>
  /[\\/]/.test(q) || /\.[A-Za-z0-9]+$/.test(q) || q.startsWith('.');

@Component({
  selector: 'file-search',
  templateUrl: './file-search.html',
  styleUrl: './file-search.scss',
  imports: [SearchResult, FormsModule],
  providers: [
    provideIcons({
      lucideLoader2,
      lucideRefreshCcw,
      lucideFilter,
      lucideCaseSensitive,
      lucideWholeWord,
      lucideUnlink2,
    }),
  ],
})
export class FileSearch implements OnInit, OnDestroy {
  nodeStore = inject(WorkspaceNodeStore);
  command = inject(EditorCommands);
  searchService = inject(SearchService);
  private dialogRef = inject(DialogRef, { optional: true });

  rootPath = this.nodeStore.rootPath;
  searchResults = signal<FileNameSearchResult[]>([]);
  keyword: string = '';
  warningMessage = signal('');

  /** True from the first keystroke until the results for it arrived. Stale results must not be acted on. */
  private loading = signal(false);
  private query = signal('');
  private queuedEnter: 'open' | 'create' | null = null;

  // ───────────── the list: found files, then "create" ─────────────
  private resolved = computed(() => resolveNewPath(this.query().trim()));

  private createRow = computed<Extract<Row, { kind: 'create' }> | null>(() => {
    const root = this.rootPath();
    const path = this.resolved();
    if (!root || !path.ok || this.loading()) return null;

    // A file that is already in the results is opened, never "created".
    const absolute = normalizePath(`${root}\\${path.segments.join('\\')}`);
    if (this.searchResults().some((r) => samePath(r.path, absolute))) return null;
    return {
      kind: 'create',
      label: path.display,
      folder: path.isFolder,
      input: this.query().trim(),
    };
  });

  rows = computed<Row[]>(() => {
    const rows: Row[] = this.searchResults().map((result) => ({ kind: 'file', result }));
    const create = this.createRow();
    if (create) rows.push(create);
    return rows;
  });

  activeIndex = signal(-1);
  private rowEls = viewChildren<ElementRef<HTMLElement>>('row');
  rowKey = (row: Row) => (row.kind === 'file' ? row.result.path : '__create__');

  private searchTerms = new Subject<string>();
  private searchSubscription!: Subscription;

  constructor() {
    // New list -> select the best candidate again.
    effect(() => {
      const rows = this.rows();
      untracked(() => this.activeIndex.set(this.defaultIndex(rows)));
    });
    // Keep the selected row visible while arrowing through a long list.
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
    this.searchSubscription = this.searchTerms
      .pipe(
        debounceTime(250),
        // (no distinctUntilChanged: dropping a repeated query would leave `loading` stuck on)
        tap((query) => {
          if (!query.trim()) this.searchResults.set([]);
        }),
        // Never rejects: a rejection would end the whole pipeline and typing would stop searching.
        switchMap(async (query: string) => {
          if (!query.trim()) return [];
          const root = this.rootPath();
          if (!root) {
            this.warningMessage.set('You have to select a folder first.');
            return [];
          }
          try {
            return await this.searchService.searchWorkspaceFile(root, query);
          } catch (err) {
            console.error('File search failed:', err);
            return [];
          }
        }),
      )
      .subscribe((results) => {
        this.searchResults.set(results);
        this.loading.set(false);

        // Enter was pressed while this search was still running: act on what it found.
        const queued = this.queuedEnter;
        this.queuedEnter = null;
        if (queued) {
          this.activeIndex.set(this.defaultIndex(this.rows()));
          void this.activate(queued === 'create');
        }
      });
  }

  onValueChange(value: string) {
    this.query.set(value);
    this.warningMessage.set('');
    this.queuedEnter = null;
    this.loading.set(value.trim().length > 0);
    this.searchTerms.next(value);
  }

  // ───────────── keyboard ─────────────

  onKeydown(event: KeyboardEvent) {
    if (event.isComposing) return; // an IME is still composing a character
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
    if (this.loading()) {
      this.queuedEnter = forceCreate ? 'create' : 'open'; // results are stale: wait for them
      return;
    }
    await this.activate(forceCreate);
  }

  /** First file if there is one; the create row only when it's the sole row AND the input looks like a path. */
  private defaultIndex(rows: Row[]): number {
    if (rows[0]?.kind === 'file') return 0;
    if (rows[0]?.kind === 'create' && looksLikePath(this.query().trim())) return 0;
    return -1;
  }

  // ───────────── actions ─────────────

  async activate(forceCreate = false) {
    const rows = this.rows();
    const row = forceCreate ? rows.find((r) => r.kind === 'create') : rows[this.activeIndex()];
    if (!row) return;
    if (row.kind === 'file') return this.openFile(row.result);
    return this.create(row);
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

  ngOnDestroy(): void {
    if (this.searchSubscription) {
      this.searchSubscription.unsubscribe();
    }
  }
}
