import { Injectable, inject } from '@angular/core';
import { EditorService } from '../../../feature/editor/services/editor.service';
import { FileNode } from '../../store/node.state';
import { classifyWatchEvent, findNodeByPath } from './external-watcher.utils';
import { FileSystemService } from './file-system.service';
import { NodeStore } from '../../store/node.store';
import { TabStore } from '../../store/tab.store';

@Injectable({ providedIn: 'root' })
export class WorkspaceWatcherService {
  private readonly fileService = inject(FileSystemService);
  private readonly nodes = inject(NodeStore);
  private readonly tabs = inject(TabStore);
  private readonly editor = inject(EditorService);

  /** Events are handled one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();
  /** Files with a "reload?" dialog open, so one outside edit asks only once. */
  private readonly openConflicts = new Set<string>();

  /** Starts watching `rootPath`. If FileSystemService can stop the previous watcher, do that first. */
  async start(rootPath: string): Promise<void> {
    await this.fileService.startWorkspaceWatcher(rootPath, (event) => this.enqueue(event));
  }

  private enqueue(event: { type: unknown; paths: string[] }) {
    this.queue = this.queue
      .then(() => this.process(event))
      .catch((err) => console.error('External watcher event failed', event, err));
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
