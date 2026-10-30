import { computed, inject, Injectable, signal } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { GitService } from './git.service';
import { FileBlame } from '../parser/git-parsers';

const STORAGE_KEY = 'cairn.git.blame';
/** Beyond this, blame costs more than it is worth and is skipped for the file. */
const MAX_LINES = 20_000;
const MAX_CHARS = 2_000_000;

const readSetting = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'; // on unless switched off
  } catch {
    return true;
  }
};

@Injectable({ providedIn: 'root' })
export class GitBlameService {
  private git = inject(GitService);

  readonly enabled = signal(readSetting());
  /** Changes whenever the repository does (commit, checkout, pull...): the blame on screen may be outdated. */
  readonly repoVersion = computed(() => this.git.statusVersion());
  /** The latest blame per model (by URI): what the hover provider reads. */
  private results = new Map<string, FileBlame>();

  toggle(): void {
    const next = !this.enabled();
    this.enabled.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable: the setting just lasts for this session */
    }
  }

  /** A tracked file inside the repository, of a size git can blame quickly. */
  isEligible(model: Monaco.editor.ITextModel): boolean {
    if (model.isDisposed() || model.uri.scheme !== 'file') return false;
    if (model.getLineCount() > MAX_LINES || model.getValueLength() > MAX_CHARS) return false;
    const path = model.uri.fsPath;
    if (!this.git.repoPathOf(path)) return false; // outside the repository
    return this.git.fileStatusFor(path)?.kind !== 'untracked'; // untracked: there is no history to show
  }

  /** Blames the editor's current text (so unsaved edits are accounted for) and remembers the answer. */
  async blame(model: Monaco.editor.ITextModel): Promise<{ blame: FileBlame | null; ms: number }> {
    const started = performance.now();
    const blame = await this.git.blame(model.uri.fsPath, model.getValue());
    const key = model.uri.toString();
    if (blame && !model.isDisposed()) this.results.set(key, blame);
    else this.results.delete(key);
    return { blame: blame, ms: performance.now() - started };
  }

  peek(model: Monaco.editor.ITextModel): FileBlame | null {
    return this.results.get(model.uri.toString()) ?? null;
  }

  forget(model: Monaco.editor.ITextModel | null): void {
    if (model) this.results.delete(model.uri.toString());
  }
}
