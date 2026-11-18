import { Injectable, inject } from '@angular/core';
import { EditorService } from '../../../feature/editor/services/editor.service';
import { FileNode } from '../../store/node.state';
import { classifyWatchEvent, findNodeByPath } from './external-watcher.utils';
import { FileSystemService } from './file-system.service';
import { NodeStore } from '../../store/node.store';
import { TabStore } from '../../store/tab.store';
import { fsEvents$ } from './fs-events';
import { CodeMapService } from '../codemap/codemap.service';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

@Injectable({ providedIn: 'root' })
export class WorkspaceWatcherService {
  private readonly fileService = inject(FileSystemService);
  private readonly nodes = inject(NodeStore);
  private readonly tabs = inject(TabStore);
  private readonly editor = inject(EditorService);
  private readonly codemap = inject(CodeMapService);

  private readonly pendingCodeMapPaths = new Set<string>();
  private codeMapTimer: ReturnType<typeof setTimeout> | null = null;
  private codeMapChain: Promise<void> = Promise.resolve();

  /** Events are handled one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();
  /** Indexing starts after the filesystem watcher so events can queue while the initial scan runs. */
  private codemapReady: Promise<void> = Promise.resolve();
  /** Files with a "reload?" dialog open, so one outside edit asks only once. */
  private readonly openConflicts = new Set<string>();
  private unlistenChanged?: UnlistenFn;
  private unlistenError?: UnlistenFn;
  private startGeneration = 0;

  /** Starts watching `rootPath`. If FileSystemService can stop the previous watcher, do that first. */
  async start(rootPath: string): Promise<void> {
    const generation = ++this.startGeneration;
    void this.attachWatcher(rootPath, generation);
    this.codemapReady = this.codemap.open(rootPath).then(
      () => undefined,
      (error) => {
        console.error('Could not open the code map for this workspace:', error);
      },
    );
  }

  async stop(): Promise<void> {
    ++this.startGeneration;
    this.unlistenChanged?.();
    this.unlistenChanged = undefined;
    this.unlistenError?.();
    this.unlistenError = undefined;
    await this.fileService.stopWorkspaceWatcher().catch((error) => console.error('Could not stop the workspace watcher:', error));
  }

  private async attachWatcher(rootPath: string, generation: number): Promise<void> {
    try {
      const changed = await listen<{ events: { kind: string; paths: string[] }[]; overflow: boolean }>('fs:changed', ({ payload }) => {
        if (generation !== this.startGeneration) return;
        if (payload.overflow) {
          this.enqueueOverflow(rootPath);
          return;
        }
        for (const event of payload.events) {
          const type = event.kind === 'create' ? { create: { kind: 'any' } }
            : event.kind === 'remove' ? { remove: { kind: 'any' } }
              : event.kind === 'modify' ? { modify: { kind: 'data' } }
                : event.kind === 'rename' ? { modify: { kind: 'rename', mode: event.paths.length > 1 ? 'both' : 'any' } }
                  : 'other';
          this.enqueue({ type, paths: event.paths });
        }
      });
      const watchError = await listen<{ message: string }>('fs:watch-error', ({ payload }) => console.error('Workspace watcher error:', payload.message));
      if (generation !== this.startGeneration) {
        changed(); watchError(); return;
      }
      this.unlistenChanged?.(); this.unlistenError?.();
      this.unlistenChanged = changed;
      this.unlistenError = watchError;
      await this.fileService.startWorkspaceWatcher(rootPath);
    } catch (error) {
      console.error(`Failed to start the file watcher for path: ${rootPath}`, error);
    }
  }

  private enqueueOverflow(rootPath: string): void {
    fsEvents$.next();
    this.queue = this.queue.then(async () => {
      await this.nodes.loadFolder(rootPath);
      this.codemapReady = this.codemap.open(rootPath).then(() => undefined, (error) => console.error('Could not reopen the code map after watcher overflow:', error));
      await this.codemapReady;
    }).catch((error) => console.error('Filesystem overflow refresh failed:', error));
  }

  private enqueue(event: { type: unknown; paths: string[] }) {
    // Notify all subscribers (like GitService) that a file system event occurred
    fsEvents$.next();
    if (classifyWatchEvent(event.type).action !== 'ignore') this.queueCodeMap(event.paths);
    this.queue = this.queue
      .then(() => this.process(event))
      .catch((err) => console.error('External watcher event failed', event, err));
  }

  private queueCodeMap(paths: string[]) {
    for (const p of paths) this.pendingCodeMapPaths.add(p);
    if (this.codeMapTimer) clearTimeout(this.codeMapTimer);
    this.codeMapTimer = setTimeout(() => {
      const batch = [...this.pendingCodeMapPaths];
      this.pendingCodeMapPaths.clear();
      this.codeMapTimer = null;
      this.codeMapChain = this.codeMapChain
        .then(() => this.codemapReady)
        .then(() => this.codemap.updateFiles(batch))
        .then(() => undefined)
        .catch((error) => console.error('Could not update the code map:', error));
    }, 400);
  }

  private async process(event: { type: unknown; paths: string[] }) {
    const { action, entry, mode } = classifyWatchEvent(event.type);
    const [first, second] = event.paths;
    if (!first) return;

    switch (action) {
      case 'create':
        for (const p of event.paths) await this.nodes.applyCreated(p, entry);
        break;
      case 'remove':
        for (const p of event.paths) this.nodes.applyRemoved(p);
        break;
      case 'modify':
        for (const p of event.paths) await this.onModify(p);
        break;
      case 'rename':
        if (second) await this.onRename(first, second);
        else if (mode === 'from') this.nodes.applyRemoved(first);
        else if (mode === 'to') await this.nodes.applyCreated(first);
        else if (await this.fileService.pathExists(first)) await this.nodes.applyCreated(first);
        else this.nodes.applyRemoved(first);
        break;
    }
  }

  private async onRename(from: string, to: string) {
    const recheck = await this.nodes.applyRenamed(from, to);
    if (recheck) await this.onModify(recheck);
  }

  /** A file changed on disk. Our own saves land here too, and are ignored because the stored content already matches. */
  private async onModify(path: string) {
    const node = findNodeByPath(this.nodes.nodes(), path);
    if (!node || !('content' in node)) return;

    let disk: string;
    try {
      disk = await this.fileService.getFileTextContent(node.path);
    } catch {
      return;
    }

    const current = this.nodes.nodes()[node.id] as FileNode | undefined;
    if (!current || disk === current.content) return; // our own write, or nothing changed

    const live = this.editor.getContent(node.id);
    if (live === undefined) {
      // No model: either a file nobody has open (nothing to do, it is read when opened) or a tab that was never shown.
      if (this.tabs.openTabs().includes(node.id)) this.nodes.setContent(node.id, disk);
      return;
    }

    if (disk === live || !this.tabs.isDirty(node.id)) {
      // Same text as the editor, or nothing unsaved to lose: follow the disk.
      if (disk !== live) this.editor.replaceContent(node.id, disk);
      this.nodes.setContent(node.id, disk);
      this.editor.markSaved(node.id, disk);
      return;
    }

    // Unsaved edits AND a different text on disk: ask, once per file.
    if (this.openConflicts.has(node.id)) return;
    this.openConflicts.add(node.id);
    void this.resolveConflict(node.id, disk).finally(() => this.openConflicts.delete(node.id));
  }

  private async resolveConflict(id: string, disk: string) {
    const name = this.nodes.nameOf(id);
    if (!name) return;
    const reload = await this.fileService.askReloadChangedFile(name);

    if (this.editor.getContent(id) === undefined) return; // closed while the dialog was open
    if (reload) this.editor.replaceContent(id, disk);
    this.nodes.setContent(id, disk);
    this.editor.markSaved(id, disk); // "keep mine" stays dirty, now compared against the new disk text
  }
}
