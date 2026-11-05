import { EditorTabsStore } from '../../../core/store/editor-tabs.store';
import { Injectable, inject, effect, untracked } from '@angular/core';
import { getMonacoLanguage } from '../../../shared/utils/node.utils';
import { GitService } from '../../git/services/git.service';
import { EditorService, ModelSpec } from './editor.service';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { GitSide, DiffSide, sideModelId } from '../features/diff-tab';

/**
 * The one place that knows how something becomes a Monaco model: a working file (from the node store),
 * or a git side of a diff (HEAD, index, a commit). Also keeps the git sides that can change fresh.
 */
@Injectable({ providedIn: 'root' })
export class ModelSourceService {
  private readonly git = inject(GitService);
  private readonly nodes = inject(WorkspaceNodeStore);
  private readonly tabs = inject(EditorTabsStore);
  private readonly editor = inject(EditorService);

  /** Live models of the sides that can change under us (HEAD and index), so they can be refreshed. */
  private readonly changing = new Map<string, GitSide>();

  constructor() {
    // After staging, committing, switching branch... HEAD and the index may show different text.
    effect(() => {
      this.git.statusVersion();
      untracked(() => void this.reloadChanging());
    });
  }

  /** The model of a working file. Sync: its content must already be loaded (EditorCommands.openFile does that). */
  acquireFile(owner: string, fileId: string) {
    const node = this.nodes.nodes()[fileId];
    if (!node || !('content' in node)) return null;

    return this.editor.acquireModel(owner, {
      id: fileId,
      uri: node.path,
      content: node.content,
      language: getMonacoLanguage(node.name),
      onDirtyChange: (dirty) => this.tabs.setDirty(fileId, dirty),
    });
  }

  /** Gets or creates the model behind one side of a diff and registers `owner` (the diff tab) on it. */
  async acquire(owner: string, side: DiffSide) {
    const id = sideModelId(side);

    const existing = this.editor.retainModel(owner, id);
    if (existing) {
      this.track(id, side);
      return existing;
    }

    if (side.kind === 'worktree') {
      await this.nodes.fetchFileContent(side.fileId);
      return this.acquireFile(owner, side.fileId);
    }

    const modelId = this.editor.acquireModel(owner, await this.gitSpec(id, side));
    if (modelId) this.track(id, side);
    return modelId;
  }

  release(owner: string, side: DiffSide) {
    const id = sideModelId(side);
    if (this.editor.releaseModel(id, owner)) this.changing.delete(id);
  }

  // ───────────── internals ─────────────

  private async gitSpec(id: string, side: GitSide): Promise<ModelSpec> {
    return {
      id,
      uri: this.uriOf(side),
      content: (await this.read(side)) ?? '', // missing on this side (new, deleted, root commit) = empty
      language: getMonacoLanguage(side.path.split(/[\\/]/).pop() ?? side.path),
    };
  }

  private read(side: GitSide): Promise<string | null> {
    switch (side.kind) {
      case 'head':
        return this.git.readAtHead(side.path);
      case 'index':
        return this.git.readFromIndex(side.path);
      case 'commit': {
        const relative = this.git.repoPathOf(side.path);
        return relative ? this.git.readAtCommit(side.rev, relative) : Promise.resolve(null);
      }
      case 'empty':
        return Promise.resolve('');
    }
  }

  /** Unique per (what, where): Monaco refuses two live models with the same uri. */
  private uriOf(side: GitSide) {
    const relative = this.git.repoPathOf(side.path) ?? side.path;
    const ref = side.kind === 'commit' ? side.rev : side.kind;
    return { scheme: 'git', path: `/${relative}`, query: `ref=${ref}` };
  }

  /** A commit never changes, but HEAD and the index do. */
  private track(id: string, side: DiffSide) {
    if (side.kind === 'head' || side.kind === 'index') this.changing.set(id, side);
  }

  private async reloadChanging() {
    await Promise.all(
      [...this.changing].map(async ([id, side]) => {
        this.editor.updateSnapshot(id, (await this.read(side)) ?? '');
      }),
    );
  }
}
