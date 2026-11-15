import { Injectable, inject } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { firstValueFrom } from 'rxjs';
import { DialogService } from '../dialog/dialog.service';
import { MissingLanguageDialogData } from './missing-language-dialog';

export type SymbolKind = 'function' | 'method' | 'struct' | 'enum' | 'trait';

export interface CodeSymbol {
  id: string;
  file: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  signature: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  parent: string | null;
  bodyHash: string;
  summary: string | null;
  summaryHash: string | null;
}

/** `exact` is false when the name matched several candidates. */
export interface CodeLink {
  symbol: CodeSymbol;
  exact: boolean;
}

export type CodeMapNode =
  | { type: 'folder'; name: string; path: string; children: CodeMapNode[] }
  | { type: 'file'; name: string; path: string; lang: string; symbols: CodeSymbol[] };

export interface IndexProgress {
  done: number;
  total: number;
}

export interface IndexStats {
  scanned: number;
  parsed: number;
  unchanged: number;
  skipped: number;
  removed: number;
  symbols: number;
}
export interface MissingLanguage {
  name: string;
  /// How many files are waiting for it.
  files: number;
}

/** Thin wrapper over the Rust code map commands. */
@Injectable({ providedIn: 'root' })
export class CodeMapService {
  private readonly dialog = inject(DialogService);
  private readonly promptedThisSession = new Set<string>();
  private promptInFlight?: Promise<void>;

  open(root: string, onProgress?: (p: IndexProgress) => void): Promise<IndexStats> {
    const channel = new Channel<IndexProgress>();
    if (onProgress) channel.onmessage = onProgress;
    return invoke<IndexStats>('codemap_open', { root, onProgress: channel }).then(async (stats) => {
      void this.promptForMissingLanguages();
      return stats;
    });
  }

  close(): Promise<void> {
    return invoke('codemap_close');
  }

  /** Paths reported by the file watcher (absolute; files or folders). */
  updateFiles(paths: string[]): Promise<IndexStats> {
    return invoke<IndexStats>('codemap_update_files', { paths }).then(async (stats) => {
      if (stats.parsed > 0) void this.promptForMissingLanguages();
      return stats;
    });
  }

  tree(): Promise<CodeMapNode> {
    return invoke<CodeMapNode>('codemap_tree');
  }

  symbolsInFile(file: string): Promise<CodeSymbol[]> {
    return invoke<CodeSymbol[]>('codemap_symbols_in_file', { file });
  }

  callers(id: string): Promise<CodeLink[]> {
    return invoke<CodeLink[]>('codemap_callers', { id });
  }

  callees(id: string): Promise<CodeLink[]> {
    return invoke<CodeLink[]>('codemap_callees', { id });
  }

  search(query: string, limit?: number): Promise<CodeSymbol[]> {
    return invoke<CodeSymbol[]>('codemap_search', { query, limit });
  }

  symbolSource(id: string): Promise<string> {
    return invoke<string>('codemap_symbol_source', { id });
  }

  missingLanguage() {
    return invoke<MissingLanguage[]>('codemap_missing_languages', {});
  }

  installLanguages(names: string[]) {
    return invoke<IndexStats>('codemap_install_languages', { names });
  }

  private promptForMissingLanguages(): Promise<void> {
    if (this.promptInFlight) return this.promptInFlight;

    this.promptInFlight = this.missingLanguage()
      .then(async (missing) => {
        const askAbout = missing.filter(
          ({ name }) => !this.promptedThisSession.has(name) && !this.isLanguageDismissed(name),
        );
        if (!askAbout.length) return;

        askAbout.forEach(({ name }) => this.promptedThisSession.add(name));
        const data: MissingLanguageDialogData = { languages: askAbout };
        const { MissingLanguageDialog } = await import('./missing-language-dialog');
        const ref = this.dialog.open<'installed' | undefined>(MissingLanguageDialog, {
          title: 'Language support is missing',
          data,
          width: 'min(460px, 90vw)',
        });
        await firstValueFrom(ref.closed, { defaultValue: undefined });
      })
      .catch((error) => console.error('Could not check for missing code map languages:', error))
      .finally(() => {
        this.promptInFlight = undefined;
      });

    return this.promptInFlight;
  }

  isLanguageDismissed(name: string): boolean {
    try {
      return localStorage.getItem(this.dismissedKey(name)) === 'true';
    } catch {
      return false;
    }
  }

  setLanguageDismissed(name: string, dismissed: boolean): void {
    try {
      if (dismissed) localStorage.setItem(this.dismissedKey(name), 'true');
      else localStorage.removeItem(this.dismissedKey(name));
    } catch {
      // If storage is unavailable, the prompt still works for this session.
    }
  }

  private dismissedKey(name: string): string {
    return `cairn.codemap.dismissed-language.${name}`;
  }
}
