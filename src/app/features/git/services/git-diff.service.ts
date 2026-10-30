import { Injectable, inject } from '@angular/core';
import { EditorTabsStore } from '../../../core/store/editor-tabs.store';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { EditorCommands } from '../../editor/editor.commands';
import { DiffRequestInput, DiffSideInput, DiffSide } from '../../editor/features/diff-tab';
import { GitUiFile } from '../commit/commit';
import { GitFileStatus } from '../parser/git-status.parser';
import { GitService } from './git.service';

export type GitDiffMode = 'staged' | 'unstaged';

/**
 * Opens diffs. It only DESCRIBES the two sides: ModelSourceService reads their text from git when the tab
 * is shown, so nothing is read here. Every path in a request is ABSOLUTE.
 */
@Injectable({ providedIn: 'root' })
export class GitDiffService {
  private readonly git = inject(GitService);
  private readonly nodes = inject(WorkspaceNodeStore);
  private readonly tabs = inject(EditorTabsStore);
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
  requestForCommits(
    from: string,
    to: string,
    file: { path: string; oldPath?: string },
  ): DiffRequestInput | null {
    const path = this.git.absolutePathOf(file.path);
    if (!path) return null;
    const oldPath = file.oldPath ? this.git.absolutePathOf(file.oldPath) : null;
    return {
      original: { kind: 'commit', rev: from, path: oldPath ?? path },
      modified: { kind: 'commit', rev: to, path },
    };
  }

  // ───────────── for the git panel ─────────────

  /**
   * A click on a row shows what changed. Untracked and conflicted files have nothing to compare, so they just open.
   * Staged list: HEAD -> index. Unstaged list: index -> working file (the only editable one).
   */
  async openChange(file: GitUiFile, mode?: GitDiffMode): Promise<string | null> {
    const change = file.source;
    const path = this.git.absolutePathOf(change.path);
    if (!path) return `${change.path} is outside the repository.`;

    if (file.status === 'U' || file.status === '!') {
      const id = await this.commands.openPath(path);
      return id ? null : `Could not find ${change.path} in the workspace.`;
    }
    return this.open(this.requestForChange(change, path, mode));
  }

  private requestForChange(
    change: GitFileStatus,
    path: string,
    mode?: GitDiffMode,
  ): DiffRequestInput {
    const staged = mode ? mode === 'staged' : change.staged && !change.unstaged;

    if (staged) {
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
