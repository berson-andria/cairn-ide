// Imports: effect, inject, Injectable, InjectionToken, untracked; EditorTabsStore; EditorService, fileTabOwner;
// WrokspaceNodeStore; getMonacoLanguage; InlineCreationMode.

import { InjectionToken, Injectable, inject, effect, untracked } from '@angular/core';
import { EditorTabsStore } from '../../core/store/editor-tabs.store';
import { InlineCreationMode } from '../../core/store/workspace/workspace.state';
import { WorkspaceNodeStore } from '../../core/store/workspace/workspace.store';
import { getMonacoLanguage } from '../../shared/utils/node.utils';
import { EditorService, fileTabOwner } from './services/editor.service';
import { MessageService } from '../../core/services/message.service';
import { TerminalService } from '../tooling/terminal/terminal.service';

export type SaveChoice = 'save' | 'discard' | 'cancel';

/**
 * The user actions that cross the node store, the tabs store and the editor: open, save, close.
 * UI -> EditorCommands -> { WrokspaceNodeStore, EditorTabsStore, EditorService }. The three never import each other.
 * It also keeps them in step with each other (see the effects). Inject it once at startup so they are running.
 */
@Injectable({ providedIn: 'root' })
export class EditorCommands {
  private readonly nodes = inject(WorkspaceNodeStore);
  private readonly tabs = inject(EditorTabsStore);
  private readonly editor = inject(EditorService);
  private readonly messageService = inject(MessageService);
  private readonly terminalService = inject(TerminalService);

  constructor() {
    // The explorer's current node follows the focused file tab.
    effect(() => {
      const id = this.tabs.activeTabId();
      untracked(() => {
        if (!id) this.nodes.setActiveNode(null);
        else if (!this.tabs.diffTabs()[id]) this.nodes.setActiveNode(id);
      });
    });

    // A file that no longer exists (deleted, folder switched) can't stay open.
    effect(() => {
      const nodes = this.nodes.nodes();
      const gone = this.tabs.openTabs().filter((id) => !this.tabs.diffTabs()[id] && !nodes[id]);
      if (!gone.length) return;
      untracked(() => {
        gone.forEach((id) => this.tabs.setDirty(id, false));
        this.tabs.closeMany(gone);
      });
    });

    // A renamed or moved file keeps its id, so its model has to follow it to the new path.
    effect(() => {
      const nodes = this.nodes.nodes();
      untracked(() => {
        for (const id of this.editor.modelIds()) {
          const node = nodes[id];
          if (node && 'content' in node) {
            this.editor.moveModel(id, node.path, getMonacoLanguage(node.name));
          }
        }
      });
    });
  }

  // ───────────── open ─────────────

  async openFile(id: string): Promise<void> {
    if (!this.editor.hasModel(id)) {
      await this.nodes.fetchFileContent(id); // the model is built from node.content, so load it first
    }
    this.tabs.openFile(id);
    this.nodes.setActiveNode(id);
  }

  /** Opens the file at `path` (loading the folders on the way). Returns its id, or null if it isn't in the workspace. */
  async openPath(path: string): Promise<string | null> {
    const id = await this.nodes.resolveFileId(path);
    if (!id) return null;
    this.nodes.revealInExplorer(id);
    await this.openFile(id);
    return id;
  }

  /** Opens a file and selects `text` on `lineNumber` (search results). */
  async openPathAtLine(path: string, lineNumber: number, text: string): Promise<void> {
    const id = await this.openPath(path);
    if (!id) return;
    // The editor shows the file a moment later (the tab is focused, then its model is built): retry for a while.
    for (let i = 0; i < 30; i++) {
      if (this.editor.revealText(id, lineNumber, text)) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async openStandaloneFiles(): Promise<void> {
    for (const id of await this.nodes.addStandaloneFiles()) await this.openFile(id);
  }

  async submitInlineCreation(
    name: string,
    mode: InlineCreationMode,
    targetFolderId: string | null,
  ): Promise<void> {
    const fileId = await this.nodes.submitInlineCreation(name, mode, targetFolderId);
    if (fileId) this.tabs.openFile(fileId); // brand new and empty: nothing to load
  }

  /** Returns an error message, or null on success. */
  async createPathFromSearch(input: string): Promise<string | null> {
    const { error, fileId } = await this.nodes.createPathFromSearch(input);
    if (error) return error;
    if (fileId) {
      this.nodes.revealInExplorer(fileId);
      await this.openFile(fileId);
    }
    return null;
  }

  // ───────────── save ─────────────

  /** Reads the text from the editor, writes it through the node store, then tells the editor it is on disk. */
  async saveFile(id: string): Promise<boolean> {
    const content = this.editor.getContent(id);
    if (content === undefined) return true; // never opened in an editor: nothing to save
    try {
      await this.nodes.writeFile(id, content);
    } catch {
      return false; // writeFile reports the error itself
    }
    this.editor.markSaved(id, content); // stays dirty if the user typed during the write
    return true;
  }

  async saveAll(): Promise<boolean> {
    for (const id of this.tabs.dirtyIds()) {
      if (!(await this.saveFile(id))) return false;
    }
    return true;
  }

  // ───────────── close ─────────────

  closeTab(id: string) {
    return this.closeTabs([id]);
  }

  // closeOthers(id: string) {
  //   return this.closeTabs(this.tabs.openTabs().filter((t) => t !== id));
  // }

  closeAll() {
    return this.closeTabs(this.tabs.openTabs());
  }

  /** Asks about unsaved changes once for the whole group. Returns false if the user cancelled or a save failed. */
  async closeTabs(tabIds: string[]): Promise<boolean> {
    const closing = new Set(tabIds.map((id) => this.ownerOf(id)));

    // Dirty files that nothing outside the closing tabs would still keep open.
    const atRisk = [...new Set(tabIds.flatMap((id) => this.fileIdsOf(id)))].filter(
      (fileId) =>
        this.tabs.isDirty(fileId) && this.editor.ownersOf(fileId).every((o) => closing.has(o)),
    );

    if (atRisk.length) {
      const choice =
        atRisk.length === 1
          ? await this.messageService.askSaveDirtyFile(atRisk.map((id) => this.nodes.nameOf(id))[0])
          : await this.messageService.askSaveDirtyFiles(atRisk.length);
      if (choice === 'Cancel') return false;
      if (choice === 'Don`t save') {
        atRisk.forEach((id) => this.editor.discardChanges(id));
      } else {
        for (const id of atRisk) if (!(await this.saveFile(id))) return false;
      }
    }

    const activeTab = this.tabs.closeMany(tabIds);
    if (!activeTab) return true;
    this.nodes.setActiveNode(activeTab);
    this.nodes.selectNode(activeTab, 'single');
    return true;
  }

  // ───────────── workspace ─────────────

  /** Picks a folder first, so cancelling the picker doesn't close anything. */
  async openFolder(): Promise<void> {
    const path = await this.nodes.pickFolder();
    if (!path) return;
    if (!(await this.closeAll())) return;
    await this.nodes.loadFolder(path);
  }

  /** Refreshing gives every node a new id, so the open tabs would be lost: ask about them first. */
  async refreshExplorer(): Promise<void> {
    if (!(await this.closeAll())) return;
    await this.nodes.refreshExplorer();
  }

  // ───────────── helpers ─────────────

  /** The file ids a tab shows: itself, or the working-file sides of a diff. */
  private fileIdsOf(tabId: string): string[] {
    const diff = this.tabs.diffTabs()[tabId];
    if (!diff) return [tabId];
    return [diff.request.original, diff.request.modified].flatMap((side) =>
      side.kind === 'worktree' ? [side.fileId] : [],
    );
  }

  /** What the editor components register as the model owner for a tab. */
  private ownerOf(tabId: string): string {
    return this.tabs.diffTabs()[tabId] ? tabId : fileTabOwner(tabId);
  }
}
