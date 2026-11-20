import { effect, inject, Injectable, signal } from '@angular/core';
import { exists, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NodeStore } from '../store/node.store';
import type { Node } from '../store/node.state';
import { NoteStore } from '../store/note.store';
import { TabStore } from '../store/tab.store';
import type { Tab } from '../store/tab.store';
import { TaskStore } from '../store/task.store';
import type { DiffRequest, DiffSide, DiffTab } from '../../feature/editor/features/diff-tab';
import {
  type PersistedDiffSide,
  type PersistedWorkspaceTab,
  type WorkspaceStateFile,
  createWorkspaceRestorePlan,
  createWorkspaceStateFile,
  parseDiffRequest,
  parseWorkspaceStateFile,
  sortFolderPathsByDepth,
} from '../../shared/models/workspace-state.model';
import { NoticeManager } from './notification/notification.service';
import { WorkSyncService } from './tauri/work-sync.service';

const WORKSPACE_STATE_DIRECTORY = ['.cairn', 'cache'];
const WORKSPACE_STATE_FILE = 'workspace.json';
const SAVE_DEBOUNCE_MS = 500;

@Injectable({ providedIn: 'root' })
export class WorkspaceStateService {
  private readonly nodes = inject(NodeStore);
  private readonly tabs = inject(TabStore);
  private readonly tasks = inject(TaskStore);
  private readonly notes = inject(NoteStore);
  private readonly workSync = inject(WorkSyncService);
  private readonly notices = inject(NoticeManager);
  private readonly saveEnabled = signal(false);
  private readonly lastSerializedByPath = new Map<string, string>();
  private readonly reportedSkippedByPath = new Map<string, Set<string>>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private writeQueue: Promise<void> = Promise.resolve();
  private allowCloseOnce = false;
  private closeInProgress = false;

  constructor() {
    effect(() => {
      const rootPath = this.nodes.rootPath();
      const loading = this.nodes.isWorkspaceLoading();
      const explorerUiState = this.nodes.explorerUiState();
      const nodes = this.nodes.nodes();
      const openedTabs = this.tabs.openedTabs();
      const focusHistory = this.tabs.focusHistory();
      const diffTabs = this.tabs.diffTabs();
      if (!rootPath || loading || !this.saveEnabled()) return;

      const { file, skippedTypes } = createWorkspaceStateFile(
        rootPath,
        explorerUiState,
        nodes,
        openedTabs,
        focusHistory,
        diffTabs,
      );
      this.reportSkippedTypes(rootPath, skippedTypes);
      const content = JSON.stringify(file, null, 2);
      if (content === this.lastSerializedByPath.get(rootPath)) return;
      this.scheduleWrite(rootPath, file);
    });

    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (this.allowCloseOnce) {
          this.allowCloseOnce = false;
          return;
        }
        event.preventDefault();
        if (this.closeInProgress) return;
        this.closeInProgress = true;
        try {
          await this.flushCurrentProject();
          this.allowCloseOnce = true;
          await getCurrentWindow().close();
        } catch (error) {
          this.allowCloseOnce = false;
          this.notices.error(`Could not save workspace state before closing: ${String(error)}`);
        } finally {
          this.closeInProgress = false;
        }
      })
      .catch((error) => console.error('Could not register workspace-state close handler', error));
  }

  /** Flushes the outgoing project's last complete state before tabs or nodes are cleared. */
  async prepareProjectSwitch(): Promise<boolean> {
    this.saveEnabled.set(false);
    this.clearSaveTimer();
    const rootPath = this.nodes.rootPath();
    if (!rootPath) return true;
    const { file, skippedTypes } = this.createCurrentState(rootPath);
    this.reportSkippedTypes(rootPath, skippedTypes);
    try {
      await this.enqueueWrite(rootPath, file);
      return true;
    } catch (error) {
      this.notices.error(`Could not save workspace state: ${String(error)}`);
      this.saveEnabled.set(true);
      return false;
    }
  }

  /** Re-enables saves if the user cancelled the switch before the stores changed. */
  cancelProjectSwitch(): void {
    this.saveEnabled.set(true);
  }

  async restoreProject(rootPath: string, openCodeFile: (id: string) => Promise<void>): Promise<boolean> {
    this.saveEnabled.set(false);
    this.clearSaveTimer();
    if (this.nodes.rootPath() !== rootPath || this.nodes.isWorkspaceLoading()) return false;
    if (!(await this.workSync.waitForProjectLoaded(rootPath))) return false;

    const loaded = await this.readWorkspaceState(rootPath);
    const validFolderPaths = new Set<string>();
    for (const relativePath of sortFolderPathsByDepth(loaded.state?.expandedFolders ?? [])) {
      try {
        const node = await this.resolveNodePath(rootPath, relativePath);
        if (!node || !('children' in node)) continue;
        if (node.children === null) await this.nodes.fetchFolderContents(node.id);
        const current = this.nodes.nodes()[node.id];
        if (!current || !('children' in current) || current.children === null) continue;
        if (!this.nodes.explorerUiState()[node.id]?.isExpanded) {
          this.nodes.toggleFolderExpansion(node.id);
        }
        validFolderPaths.add(relativePath);
      } catch (error) {
        console.error(`Could not restore expanded folder "${relativePath}"`, error);
      }
    }

    const validTabIndexes = new Set<number>();
    const restoredTabs = new Map<number, Tab>();
    const restoredDiffs: Record<string, DiffTab> = {};
    for (const [savedIndex, tab] of (loaded.state?.tabs ?? []).entries()) {
      if (!tab) continue;
      try {
        const restored = await this.restoreTab(rootPath, tab, openCodeFile, restoredDiffs);
        if (!restored) continue;
        validTabIndexes.add(savedIndex);
        restoredTabs.set(savedIndex, restored);
      } catch (error) {
        console.error(`Could not restore ${tab.type} tab`, error);
      }
    }

    const state = loaded.state ?? emptyWorkspaceState();
    const plan = createWorkspaceRestorePlan(state, validTabIndexes, validFolderPaths);
    const openedTabs = plan.tabs.flatMap(({ savedIndex }) => {
      const tab = restoredTabs.get(savedIndex);
      return tab ? [tab] : [];
    });
    const focusHistory = plan.focus.flatMap((savedIndex) => {
      const tab = restoredTabs.get(savedIndex);
      return tab ? [tab] : [];
    });
    this.tabs.setRestoredTabs(openedTabs, focusHistory, restoredDiffs);
    if (!openedTabs.length) this.nodes.setActiveNode(null);

    if (loaded.raw !== null) {
      this.lastSerializedByPath.set(rootPath, loaded.raw);
    } else {
      this.lastSerializedByPath.set(rootPath, JSON.stringify(emptyWorkspaceState(), null, 2));
    }
    this.saveEnabled.set(true);
    return true;
  }

  private async restoreTab(
    rootPath: string,
    saved: PersistedWorkspaceTab,
    openCodeFile: (id: string) => Promise<void>,
    restoredDiffs: Record<string, DiffTab>,
  ): Promise<Tab | null> {
    switch (saved.type) {
      case 'CodeEditor': {
        const node = await this.resolveNodePath(rootPath, saved.ref);
        if (!node || !('content' in node)) return null;
        await openCodeFile(node.id);
        return this.tabs.getTab(node.id) ?? null;
      }
      case 'DiffEditor': {
        const request = await this.restoreDiffRequest(rootPath, saved.ref);
        if (!request) return null;
        const id = this.tabs.openDiff(request);
        const diff = this.tabs.diffTabs()[id];
        if (!diff) return null;
        restoredDiffs[id] = diff;
        return this.tabs.getTab(id) ?? null;
      }
      case 'Task': {
        const task = this.tasks.records()[saved.ref];
        if (!task) return null;
        const id = this.tabs.openTask(task.id, task.title, task.id);
        return this.tabs.getTab(id) ?? null;
      }
      case 'Note': {
        const note = this.notes.records()[saved.ref];
        if (!note) return null;
        const title = note.type
          ? `${note.type}: ${note.content.substring(0, 20)}...`
          : note.content.substring(0, 25);
        const id = this.tabs.openNote(note.id, title);
        return this.tabs.getTab(id) ?? null;
      }
      case 'Review':
      case 'Chat':
        this.reportSkippedTypes(rootPath, [saved.type]);
        return null;
    }
  }

  private async restoreDiffRequest(rootPath: string, ref: string): Promise<DiffRequest | null> {
    const persisted = parseDiffRequest(ref);
    if (!persisted) return null;
    const original = await this.restoreDiffSide(rootPath, persisted.original);
    const modified = await this.restoreDiffSide(rootPath, persisted.modified);
    return original && modified ? { original, modified } : null;
  }

  private async restoreDiffSide(
    rootPath: string,
    side: PersistedDiffSide,
  ): Promise<DiffSide | null> {
    const absolutePath = await join(rootPath, ...side.path.split('/'));
    if (side.kind === 'worktree') {
      const node = await this.resolveNodePath(rootPath, side.path);
      return node && 'content' in node
        ? { kind: 'worktree', fileId: node.id, path: node.path }
        : null;
    }
    if (side.kind === 'commit') return { ...side, path: absolutePath };
    return { ...side, path: absolutePath };
  }

  private async resolveNodePath(rootPath: string, relativePath: string): Promise<Node | undefined> {
    let parentPath = rootPath;
    let node: Node | undefined;
    const parts = relativePath.replace(/\\/g, '/').split('/');
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) {
        if (!node || !('children' in node)) return undefined;
        if (node.children === null) await this.nodes.fetchFolderContents(node.id);
      }
      parentPath = await join(parentPath, parts[index]);
      node = Object.values(this.nodes.nodes()).find((candidate) =>
        candidate.path.replace(/\\/g, '/').toLowerCase() === parentPath.replace(/\\/g, '/').toLowerCase(),
      );
      if (!node) return undefined;
    }
    return node;
  }

  private async readWorkspaceState(
    rootPath: string,
  ): Promise<{ raw: string | null; state: WorkspaceStateFile | null }> {
    try {
      const path = await this.workspaceStatePath(rootPath);
      if (!(await exists(path))) return { raw: null, state: null };
      const raw = await readTextFile(path);
      return { raw, state: parseWorkspaceStateFile(raw) };
    } catch (error) {
      this.notices.error(`Could not read workspace state: ${String(error)}`);
      return { raw: null, state: null };
    }
  }

  private workspaceStatePath(rootPath: string): Promise<string> {
    return join(rootPath, ...WORKSPACE_STATE_DIRECTORY, WORKSPACE_STATE_FILE);
  }

  private createCurrentState(rootPath: string) {
    return createWorkspaceStateFile(
      rootPath,
      this.nodes.explorerUiState(),
      this.nodes.nodes(),
      this.tabs.openedTabs(),
      this.tabs.focusHistory(),
      this.tabs.diffTabs(),
    );
  }

  private scheduleWrite(rootPath: string, file: WorkspaceStateFile): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.enqueueWrite(rootPath, file).catch((error) => {
        this.notices.error(`Could not save workspace state: ${String(error)}`);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  private async flushCurrentProject(): Promise<void> {
    this.clearSaveTimer();
    const rootPath = this.nodes.rootPath();
    if (!rootPath || !this.saveEnabled()) return;
    const { file, skippedTypes } = this.createCurrentState(rootPath);
    this.reportSkippedTypes(rootPath, skippedTypes);
    await this.enqueueWrite(rootPath, file);
  }

  private enqueueWrite(rootPath: string, file: WorkspaceStateFile): Promise<void> {
    const content = JSON.stringify(file, null, 2);
    const write = this.writeQueue.then(async () => {
      if (this.lastSerializedByPath.get(rootPath) === content) return;
      const directory = await join(rootPath, ...WORKSPACE_STATE_DIRECTORY);
      await mkdir(directory, { recursive: true });
      const path = await join(directory, WORKSPACE_STATE_FILE);
      const temporary = `${path}.tmp`;
      await writeTextFile(temporary, content);
      await rename(temporary, path);
      this.lastSerializedByPath.set(rootPath, content);
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private reportSkippedTypes(rootPath: string, types: readonly string[]): void {
    let reported = this.reportedSkippedByPath.get(rootPath);
    if (!reported) {
      reported = new Set<string>();
      this.reportedSkippedByPath.set(rootPath, reported);
    }
    for (const type of types) {
      if (reported.has(type)) continue;
      reported.add(type);
      this.notices.info(`Workspace restore skips ${type} tabs because they have no stable identifier.`);
    }
  }
}

function emptyWorkspaceState(): WorkspaceStateFile {
  return { schemaVersion: 1, expandedFolders: [], tabs: [], focus: [] };
}
