import { ModelSourceService } from './../../features/editor/services/model-source.service';
import { Injectable, inject } from '@angular/core';
// Adjust these three paths to your folders.
import { WorkspaceNodeStore } from '../store/workspace/workspace.store';
import { nonGlobal } from '../../shared/utils/replace.utils';
import { findNodeByPath } from './file-system/external-watcher.utils';
import { FileSystemService } from './file-system/file-system.service';
import { EditorService } from '../../features/editor/services/editor.service';
import { EditorTabsStore } from '../store/editor-tabs.store';

export interface ReplaceLine {
  lineNumber: number;
  /** The line text as the search reported it; used to detect that the file changed since. */
  text: string;
}

export interface ReplaceOutcome {
  /** Line numbers that were rewritten. */
  replaced: number[];
  /** Line numbers left alone because the file no longer looks like it did during the search. */
  skipped: number[];
  error?: string;
}

/**
 * Rewrites the lines a search found. It never goes looking for new matches: only the listed
 * lines are touched, and each one is re-checked right before editing.
 *
 *  - File open in the editor -> edited through its Monaco model (undo works, the LSP is told, the tab
 *    becomes dirty). Nothing is saved, exactly like typing the change by hand.
 *  - Any other file          -> read, rewritten and saved on disk.
 */
@Injectable({ providedIn: 'root' })
export class ReplaceService {
  private readonly store = inject(WorkspaceNodeStore);
  private readonly editorService = inject(EditorService);
  private readonly tabStore = inject(EditorTabsStore);
  private readonly files = inject(FileSystemService);

  async replaceLines(
    path: string,
    lines: ReplaceLine[],
    re: RegExp,
    replacement: string,
  ): Promise<ReplaceOutcome> {
    const node = findNodeByPath(this.store.nodes(), path);
    const model = node ? this.editorService.getModel(node.id) : undefined;
    return node && model
      ? this.inModel(node.id, model, lines, re, replacement)
      : this.onDisk(path, lines, re, replacement);
  }

  private inModel(
    nodeId: string,
    model: any,
    lines: ReplaceLine[],
    re: RegExp,
    replacement: string,
  ): ReplaceOutcome {
    const probe = nonGlobal(re);
    const replaced: number[] = [];
    const skipped: number[] = [];
    const edits: { range: object; text: string }[] = [];

    for (const { lineNumber, text } of lines) {
      if (lineNumber < 1 || lineNumber > model.getLineCount()) {
        skipped.push(lineNumber);
        continue;
      }
      const current: string = model.getLineContent(lineNumber); // without its line ending
      if (!stillMatches(current, text, probe)) {
        skipped.push(lineNumber);
        continue;
      }
      edits.push({
        range: {
          startLineNumber: lineNumber,
          startColumn: 1,
          endLineNumber: lineNumber,
          endColumn: current.length + 1,
        },
        text: current.replace(re, replacement),
      });
      replaced.push(lineNumber);
    }

    if (edits.length) {
      model.pushStackElement(); // one undo step for the whole replace
      model.pushEditOperations([], edits, () => null);
      model.pushStackElement();
      // The editor's change listener only flags the tab that is currently shown. This file may not be.
      void this.tabStore.setDirty(nodeId, true);
    }
    return { replaced, skipped };
  }

  private async onDisk(
    path: string,
    lines: ReplaceLine[],
    re: RegExp,
    replacement: string,
  ): Promise<ReplaceOutcome> {
    const name = path.split(/[\\/]/).pop();
    let content: string;
    try {
      content = await this.files.getFileTextContent(path);
    } catch {
      return { replaced: [], skipped: [], error: `Could not read ${name}.` };
    }

    // Splitting with a capture group keeps every line ending: even indexes are lines, odd ones are their
    // exact "\n" or "\r\n". Joining puts the file back byte for byte except for the replaced text.
    const parts = content.split(/(\r?\n)/);
    const probe = nonGlobal(re);
    const replaced: number[] = [];
    const skipped: number[] = [];

    for (const { lineNumber, text } of lines) {
      const index = (lineNumber - 1) * 2;
      const current = parts[index];
      if (current === undefined || !stillMatches(current, text, probe)) {
        skipped.push(lineNumber);
        continue;
      }
      parts[index] = current.replace(re, replacement);
      replaced.push(lineNumber);
    }

    if (replaced.length) {
      try {
        await this.files.saveFile(path, parts.join(''));
      } catch {
        return {
          replaced: [],
          skipped: lines.map((l) => l.lineNumber),
          error: `Could not write ${name}.`,
        };
      }
    }
    return { replaced, skipped };
  }
}

/** The line must still match the pattern AND still contain what the search showed for it. */
function stillMatches(current: string, searched: string, probe: RegExp): boolean {
  const shown = searched.replace(/\r?\n$/, '').trim();
  return probe.test(current) && (shown === '' || current.includes(shown));
}
