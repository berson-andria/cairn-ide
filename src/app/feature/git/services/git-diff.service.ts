import { Injectable, inject } from '@angular/core';
import { NodeStore } from '../../../core/store/node.store';
import { EditorCommands } from '../../editor/editor.commands';
import { DiffRequestInput, DiffSideInput, DiffSide } from '../../editor/features/diff-tab';
import { GitFileStatus } from '../parser/status.parser';
import { ChangedPath } from '../parser/git-types';
import { GitService } from './git.service';
import { TabStore } from '../../../core/store/tab.store';

export type GitDiffMode = 'staged' | 'unstaged';

/**
 * Opens diffs. It only DESCRIBES the two sides: ModelSourceService reads their text from git when the tab
 * is shown, so nothing is read here. Every path in a request is ABSOLUTE.
 */
@Injectable({ providedIn: 'root' })
export class GitDiffService {
  private readonly git = inject(GitService);
  private readonly nodes = inject(NodeStore);
  private readonly tabs = inject(TabStore);
  private readonly commands = inject(EditorCommands);

  // ───────────── for any component ─────────────

  /**
   * Opens a diff tab for any two sides (HEAD, index, a commit, the working file, nothing).
   * Returns an error message to show, or null.
   */
  async open(request: DiffRequestInput): Promise<string | null> {
    const original = await this.resolve(request.original);
    const modified = await this.resolve(request.modified);
    if ('error' in original) return original.error;
    if ('error' in modified) return modified.error;

    this.tabs.openDiff({ original, modified });
    return null;
  }

  /**
   * A file between two commits, for the graph. `from` is the older one: pass `${hash}^` to compare a commit with
   * its parent. `file.path` is repo-relative, as in CommitFile. Null if the file is outside the repository.
   */
  requestForCommits(from: string, to: string, file: ChangedPath): DiffRequestInput | null {
    const path = this.git.absolutePathOf(file.path);
    if (!path) return null;
    const origPath = file.origPath ? this.git.absolutePathOf(file.origPath) : null;
    return {
      original: { kind: 'commit', rev: from, path: origPath ?? path },
      modified: { kind: 'commit', rev: to, path },
    };
  }

  // ───────────── for the git panel ─────────────

  /**
   * A click on a row shows what changed. Untracked and conflicted files have nothing to compare, so they just open.
   * `mode` is the LIST the row was clicked in, not a guess from the file's flags: a file with both staged and
   * unstaged changes appears in both lists, and each row must open its own diff.
   * Staged list: HEAD -> index. Unstaged list: index -> working file (the only editable one).
   */
  async openChange(change: GitFileStatus, mode: GitDiffMode): Promise<string | null> {
    const path = this.git.absolutePathOf(change.path);
    if (!path) return `${change.path} is outside the repository.`;

    if (change.kind === 'untracked' || change.kind === 'conflicted') {
      const id = await this.commands.openPath(path);
      return id ? null : `Could not find ${change.path} in the workspace.`;
    }
    return this.open(this.requestForChange(change, path, mode));
  }

  private requestForChange(
    change: GitFileStatus,
    path: string,
    mode: GitDiffMode,
  ): DiffRequestInput {
    if (mode === 'staged') {
      return {
        original: { kind: 'head', path: this.before(change, 'index', path) },
        modified: { kind: 'index', path },
      };
    }
    return {
      original: { kind: 'index', path: this.before(change, 'worktree', path) },
      // Deleted in the working tree: there is no file to open or edit.
      modified: change.worktree === 'D' ? { kind: 'empty', path } : { kind: 'worktree', path },
    };
  }

  /** The path of the "before" side: the old name if this side of the change is a rename or a copy. */
  private before(change: GitFileStatus, side: 'index' | 'worktree', path: string): string {
    const letter = side === 'index' ? change.index : change.worktree;
    const renamed = (letter === 'R' || letter === 'C') && change.origPath;
    return (renamed && this.git.absolutePathOf(change.origPath!)) || path;
  }

  // ───────────── internals ─────────────

  /** A working file needs its node id (the editor shares one model per file). */
  private async resolve(side: DiffSideInput): Promise<DiffSide | { error: string }> {
    if (side.kind !== 'worktree') return side;
    const fileId = await this.nodes.resolveFileId(side.path);
    if (fileId) return { kind: 'worktree', fileId, path: side.path };
    const name = side.path.split(/[\\/]/).pop() ?? side.path;
    return { error: `Could not find ${name} in the workspace.` };
  }
}
