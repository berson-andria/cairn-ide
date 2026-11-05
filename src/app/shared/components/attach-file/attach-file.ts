import { CommonModule } from '@angular/common';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { DialogRef } from '@angular/cdk/dialog';
import { Subject, debounceTime, switchMap, tap } from 'rxjs';
import { NodeStore } from '../../../core/store/node.store';
import { SearchService } from '../../../feature/search/search.service';

/** Minimal file data returned to the caller; no search or editor state leaks out. */
export interface SelectedFile {
  fileName: string;
  path: string;
}

@Component({
  selector: 'app-attach-file',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './attach-file.html',
  styleUrl: './attach-file.scss',
})
export class AttachFile implements OnInit {
  private readonly nodeStore = inject(NodeStore);
  private readonly searchService = inject(SearchService);
  private readonly dialogRef = inject(DialogRef<SelectedFile[] | undefined>, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private readonly searchTerms = new Subject<string>();

  readonly rootPath = this.nodeStore.rootPath;
  readonly results = signal<SelectedFile[]>([]);
  readonly selected = signal<Record<string, SelectedFile>>({});
  readonly isSearching = signal(false);
  readonly warning = signal('');
  keyword = '';

  get selectedFiles(): SelectedFile[] {
    return Object.values(this.selected());
  }

  ngOnInit(): void {
    if (!this.rootPath()) this.warning.set('Open a project folder to select files.');

    this.searchTerms
      .pipe(
        debounceTime(250),
        tap((query) => {
          if (!query.trim()) this.results.set([]);
        }),
        switchMap(async (query) => {
          if (!query.trim()) return { query, files: [] as SelectedFile[] };
          const root = this.rootPath();
          if (!root) {
            this.warning.set('Open a project folder to select files.');
            return { query, files: [] as SelectedFile[] };
          }
          this.warning.set('');
          const files = await this.searchService.searchWorkspaceFile(root, query);
          return { query, files };
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ query, files }) => {
        if (query !== this.keyword) return;
        this.results.set(files.map(({ fileName, path }) => ({ fileName, path })));
        this.isSearching.set(false);
      });
  }

  onValueChange(query: string): void {
    this.keyword = query;
    this.results.set([]);
    this.warning.set('');
    this.isSearching.set(!!query.trim());
    this.searchTerms.next(query);
  }

  isSelected(path: string): boolean {
    return !!this.selected()[path];
  }

  toggleFile(file: SelectedFile, checked: boolean): void {
    this.selected.update((selected) => {
      if (!checked) {
        const next = { ...selected };
        delete next[file.path];
        return next;
      }
      return { ...selected, [file.path]: { fileName: file.fileName, path: file.path } };
    });
  }

  relativePath(path: string): string {
    const root = this.rootPath();
    if (!root) return path;
    const normalizedRoot = root.replace(/[\\/]+$/, '');
    if (path.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
      return path.slice(normalizedRoot.length).replace(/^[\\/]/, '');
    }
    return path;
  }

  cancel(): void {
    this.dialogRef?.close(undefined);
  }

  confirm(): void {
    this.dialogRef?.close(this.selectedFiles.map(({ fileName, path }) => ({ fileName, path })));
  }
}
