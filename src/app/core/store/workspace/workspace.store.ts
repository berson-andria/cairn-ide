import { signalStore, withState, withMethods, patchState } from '@ngrx/signals';
import {
  FileNode,
  FolderNode,
  FolderUiState,
  InlineCreationMode,
  WorkspaceNode,
  WorkspaceState,
} from './workspace.state';
import { inject } from '@angular/core';
import { FileSystemService } from '../../services/file-system/file-system.service';
import {
  parentPathOf,
  samePath,
  findNodeByPath,
  baseNameOf,
  extensionOf,
  collectSubtreeIds,
  sortIdsByName,
  sortRecordByName,
  normalizePath,
} from '../../services/file-system/external-watcher.utils';
import {
  resolveNewPath,
  topLevelIds,
  uniqueName,
  validateNodeName,
} from '../../../shared/utils/node.utils';

const initialState: WorkspaceState = {
  rootPath: null,
  rootName: null,
  rootInlineCreation: 'none',
  rootNodes: {},

  nodes: {},

  explorerUiState: {},

  activeNodeId: null,

  isWorkspaceLoading: false,
  renamingNodeId: null,
  selectionAnchorId: null,
  clipboard: null,
  selectedNodeIds: [],
};

const folderLoads = new Map<string, Promise<void>>();

/** The top level of a freshly read folder, as the record the store keeps (plus the explorer state of its folders). */
function indexRootNodes(list: WorkspaceNode[]) {
  const nodes: Record<string, WorkspaceNode> = {};
  const explorerUiState: Record<string, FolderUiState> = {};
  for (const node of list) {
    node.parentId = null;
    nodes[node.id] = node;
    if (!('extension' in node)) {
      explorerUiState[node.id] = { isExpanded: false, inlineCreation: 'none' };
    }
  }
  return { nodes, explorerUiState };
}

/**
 * The workspace tree: nodes, explorer UI state, and the file system behind them.
 * It knows nothing about tabs, editor models or dirty state: those live in EditorTabsStore and EditorService,
 * and EditorCommands is what connects them. The file watcher lives in WorkspaceWatcherService.
 */
export const WorkspaceNodeStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  //UI
  withMethods((store) => ({
    toggleFolderExpansion(folderId: string): void {
      const uiState = { ...store.explorerUiState() };
      const currentUi = uiState[folderId] || { isExpanded: false, inlineCreation: 'none' };

      uiState[folderId] = {
        ...currentUi,
        isExpanded: !currentUi.isExpanded,
      };

      patchState(store, { explorerUiState: uiState, activeNodeId: folderId });
    },
    /** The explorer's current node. EditorCommands keeps it in step with the focused file tab. */
    setActiveNode(id: string | null): void {
      patchState(store, { activeNodeId: id });
    },

    showInlineCreationForm(mode: InlineCreationMode) {
      patchState(store, (state) => {
        if (!store.activeNodeId()) {
          return {
            rootInlineCreation: mode,
          };
        }
        const activeNode = { ...store.nodes()[<string>store.activeNodeId()] };

        const folderId = 'extension' in activeNode ? activeNode.parentId : activeNode.id;
        if (!folderId) {
          return {
            rootInlineCreation: mode,
          };
        }
        const currentUiState = state.explorerUiState[folderId] || {
          isExpanded: false,
          inlineCreation: 'none',
        };

        return {
          explorerUiState: {
            ...state.explorerUiState,
            [folderId]: {
              ...currentUiState,
              isExpanded: true,
              inlineCreation: mode,
            },
          },
        };
      });
    },
    closeInlineCreationForm() {
      patchState(store, (state) => {
        const mode: InlineCreationMode = 'none';
        if (!store.activeNodeId()) {
          return {
            rootInlineCreation: mode,
          };
        }
        const activeNode = { ...store.nodes()[<string>store.activeNodeId()] };

        const folderId = 'extension' in activeNode ? activeNode.parentId : activeNode.id;
        if (!folderId) {
          return {
            rootInlineCreation: mode,
          };
        }
        const currentUiState = state.explorerUiState[folderId];
        if (!currentUiState) return {};

        return {
          explorerUiState: {
            ...state.explorerUiState,
            [folderId]: { ...currentUiState, inlineCreation: mode },
          },
        };
      });
    },
  })),

  //Data
  withMethods((store, fileService = inject(FileSystemService)) => ({
    /** Shows the folder picker. Returns the chosen path, or null if cancelled or it is the folder already open. */
    async pickFolder(): Promise<string | null> {
      const selectedPath = await fileService.selectFolder();
      if (!selectedPath || selectedPath === store.rootPath()) return null;
      return selectedPath;
    },
    /**
     * Replaces the workspace with the folder at `path`. Close the tabs first (EditorCommands.openFolder does).
     * The file watcher restarts on its own when rootPath changes.
     */
    async loadFolder(path: string): Promise<void> {
      patchState(store, { isWorkspaceLoading: true });
      try {
        const result = await fileService.getRootFolder(path);
        if (!result) return;
        const { nodes, explorerUiState } = indexRootNodes(result.nodes);
        patchState(store, {
          rootPath: result.rootPath,
          rootName: result.rootName,
          rootNodes: nodes,
          nodes,
          explorerUiState,
          activeNodeId: null,
        });
      } catch (error) {
        console.error('Unable to open the folder', error);
      } finally {
        patchState(store, { isWorkspaceLoading: false });
      }
    },
    /** Re-reads the workspace. Every node gets a new id, so close the tabs first (EditorCommands.refreshExplorer). */
    async refreshExplorer(): Promise<void> {
      patchState(store, { isWorkspaceLoading: true });
      try {
        const result = await fileService.readDirectoryContents(<string>store.rootPath());
        if (!result) return;
        const { nodes, explorerUiState } = indexRootNodes(result);
        patchState(store, { rootNodes: nodes, nodes, explorerUiState, activeNodeId: null });
      } catch (error) {
        console.error('Unable to refresh the explorer', error);
      } finally {
        patchState(store, { isWorkspaceLoading: false });
      }
    },
    /** Lets the user pick files outside the workspace and adds them as root nodes. Returns their ids. */
    async addStandaloneFiles(): Promise<string[]> {
      patchState(store, { isWorkspaceLoading: true });
      try {
        const result = await fileService.selectAndOpenFile();
        if (!result) return [];

        const nodes = { ...store.nodes() }; // fresh, after the dialog
        for (const node of result.nodes) {
          node.parentId = null;
          node.content = '';
          nodes[node.id] = node;
        }
        patchState(store, { nodes });
        return result.nodes.map((node) => node.id);
      } catch (error) {
        console.error('Unable to open the files', error);
        return [];
      } finally {
        patchState(store, { isWorkspaceLoading: false });
      }
    },
    /**
     * The id of the file at `path`, reading the folders on the way down if they were never loaded.
     * Null if it is not in the workspace. (The git panel uses it to find the `fileId` of a worktree side.)
     */
    async resolveFileId(path: string): Promise<string | null> {
      let node = findNodeByPath(store.nodes(), path);

      if (!node) {
        const root = store.rootPath();
        const target = normalizePath(path);
        if (!root || !target.toLowerCase().startsWith(normalizePath(root).toLowerCase() + '\\'))
          return null;
        const parts = target.slice(normalizePath(root).length + 1).split('\\');
        parts.pop();
        let folderPath = normalizePath(root);
        for (const part of parts) {
          folderPath += '\\' + part;
          const folder = findNodeByPath(store.nodes(), folderPath);
          if (!folder || !('children' in folder)) return null;
          if (!folder.children?.length) await this.fetchFolderContents(folder.id);
        }
        node = findNodeByPath(store.nodes(), path);
      }
      return node && 'content' in node ? node.id : null;
    },
    /** Expands every folder above the file so it is visible in the explorer. */
    revealInExplorer(fileId: string) {
      const uiState = { ...store.explorerUiState() };
      let parentId = store.nodes()[fileId]?.parentId ?? null;
      while (parentId) {
        const nodeUI = uiState[parentId];
        if (nodeUI?.isExpanded) break;
        uiState[parentId] = { ...nodeUI, inlineCreation: 'none', isExpanded: true };
        parentId = store.nodes()[parentId]?.parentId ?? null;
      }
      patchState(store, { explorerUiState: uiState });
    },

    getNodesByParentId(parentId: string | null): WorkspaceNode[] {
      const allNodes = Object.values(store.nodes());
      return allNodes.filter((node) => node.parentId === parentId);
    },
    fetchFolderContents(folderId: string): Promise<void> {
      const running = folderLoads.get(folderId);
      if (running) return running;
      const job = this._loadFolder(folderId).finally(() => folderLoads.delete(folderId));
      folderLoads.set(folderId, job);
      return job;
    },
    async _loadFolder(folderId: string): Promise<void> {
      const folder = store.nodes()[folderId] as FolderNode | undefined;
      if (!folder || folder.children?.length) return; // unknown, or already loaded

      let scanned: WorkspaceNode[];
      try {
        scanned = await fileService.readDirectoryContents(folder.path);
      } catch (err) {
        console.error(`OS level directory scan failed for ${folder.path}:`, err);
        return; // nothing recorded as loaded, so the next click retries
      }

      // Everything below reads FRESH state: the scan can take long enough for other updates to land,
      // and writing back a copy taken before the await would silently undo them.
      const current = store.nodes()[folderId] as FolderNode | undefined;
      if (!current || current.children?.length) return; // removed or loaded while we waited

      const nodes = { ...store.nodes() };
      const uiState = { ...store.explorerUiState() };
      const childIds: string[] = [];
      for (const child of scanned) {
        child.parentId = folderId;
        nodes[child.id] = child;
        childIds.push(child.id);
        if (!('extension' in child) && !uiState[child.id]) {
          uiState[child.id] = { isExpanded: false, inlineCreation: 'none' };
        }
      }
      nodes[folderId] = { ...current, children: childIds };
      patchState(store, { nodes, explorerUiState: uiState });
    },
    async fetchFileContent(fileId: string): Promise<void> {
      const node = store.nodes()[fileId] as FileNode | undefined;
      if (!node) return;
      try {
        const text = await fileService.getFileTextContent(node.path);
        const current = store.nodes()[fileId]; // fresh, after the await
        if (!current) return;
        patchState(store, {
          nodes: { ...store.nodes(), [fileId]: { ...current, content: text } as FileNode },
        });
      } catch (err) {
        console.error(`Failed to read ${node.path}:`, err);
      }
    },

    /** Writes the text to disk, then records it as the file's content. Throws if the write fails. */
    async writeFile(fileId: string, content: string): Promise<void> {
      const node = store.nodes()[fileId] as FileNode | undefined;
      if (!node) throw new Error(`Unknown file ${fileId}`);
      try {
        await fileService.saveFile(node.path, content);
      } catch (error) {
        console.error('Unable to save the file', error);
        throw error;
      }
      this.setContent(fileId, content);
    },
    /** Records what is on disk for a file (no I/O). */
    setContent(fileId: string, content: string) {
      const node = store.nodes()[fileId] as FileNode | undefined;
      if (!node) return;
      patchState(store, { nodes: { ...store.nodes(), [fileId]: { ...node, content } } });
    },
    nameOf(id: string): string {
      return store.nodes()[id]?.name ?? '';
    },
    /** The node itself if it is a file, otherwise every file below it. */
    fileIdsUnder(id: string): string[] {
      const nodes = store.nodes();
      return collectSubtreeIds(nodes, id).filter((sid) => 'content' in nodes[sid]);
    },

    async submitInlineCreation(
      name: string,
      mode: InlineCreationMode,
      targetFolderId: string | null,
    ): Promise<string | null> {
      store.closeInlineCreationForm();
      if (mode === 'none' || !name.trim()) return null;

      let stateNodes = { ...store.nodes() };
      let currentRootNodes = { ...store.rootNodes() };
      const explorerUiState = { ...store.explorerUiState() };
      const isRootPlacement = targetFolderId === 'root' || targetFolderId === null;

      let parentPath = store.rootPath();
      let parentNode: FolderNode | null = null;

      if (!isRootPlacement && targetFolderId) {
        parentNode = stateNodes[targetFolderId] as FolderNode;
        if (parentNode) parentPath = parentNode.path;
      }

      const absolutePath = `${parentPath}/${name}`;

      try {
        const newNode = await fileService.createPhysicalDiskNode(
          absolutePath,
          name,
          mode,
          isRootPlacement ? null : targetFolderId,
        );

        stateNodes[newNode.id] = newNode;
        stateNodes = Object.fromEntries(
          Object.entries(stateNodes).sort(([, n1], [, n2]) => n1.name.localeCompare(n2.name)),
        );

        if (isRootPlacement) {
          currentRootNodes[newNode.id] = newNode;
          currentRootNodes = Object.fromEntries(
            Object.entries(currentRootNodes).sort(([, n1], [, n2]) =>
              n1.name.localeCompare(n2.name),
            ),
          );
        } else if (parentNode) {
          const updatedParentChildren = parentNode.children
            ? [...parentNode.children, newNode.id]
            : [newNode.id];
          stateNodes[targetFolderId] = {
            ...parentNode,
            children: updatedParentChildren,
          };
        }
        if ('children' in newNode) {
          explorerUiState[newNode.id] = {
            isExpanded: false,
            inlineCreation: 'none',
          };
        }

        patchState(store, {
          nodes: stateNodes,
          rootNodes: currentRootNodes,
          activeNodeId: newNode.id,
          explorerUiState: explorerUiState,
        });
        return 'content' in newNode ? newNode.id : null; // the file to open, if it is one
      } catch (err: any) {
        console.error('System execution failed during disk creation step:', err);
        return null;
      }
    },

    // ───────────────────── Explorer: selection ─────────────────────
    // `selectionAnchorId` is the explorer's "current" node: F2 renames it and paste lands next to it.
    // (It is deliberately separate from `activeNodeId`, which follows the editor tab.)

    selectNode(id: string, mode: 'single' | 'toggle' | 'range' = 'single') {
      const nodes = store.nodes();
      const node = nodes[id];
      if (!node) return;

      let selected: string[];
      let anchor: string | null = store.selectionAnchorId();

      if (mode === 'toggle') {
        const set = new Set(store.selectedNodeIds());
        set.has(id) ? set.delete(id) : set.add(id);
        selected = [...set];
        anchor = id;
      } else if (
        mode === 'range' &&
        anchor &&
        nodes[anchor] &&
        nodes[anchor].parentId === node.parentId
      ) {
        // Shift+click: everything between the anchor and here, within one folder.
        const siblings = this.getNodesByParentId(node.parentId).map((n) => n.id);
        const a = siblings.indexOf(anchor);
        const b = siblings.indexOf(id);
        selected = siblings.slice(Math.min(a, b), Math.max(a, b) + 1);
      } else {
        selected = [id];
        anchor = id;
      }
      patchState(store, { selectedNodeIds: selected, selectionAnchorId: anchor });
    },
    /** Ctrl+A: every node in the same folder as the current one. */
    selectAllSiblings() {
      const anchor = store.selectionAnchorId();
      const parentId = anchor ? (store.nodes()[anchor]?.parentId ?? null) : null;
      patchState(store, { selectedNodeIds: this.getNodesByParentId(parentId).map((n) => n.id) });
    },
    clearSelection() {
      patchState(store, { selectedNodeIds: [], selectionAnchorId: null });
    },

    // ───────────────────── Explorer: rename ─────────────────────

    startRename(id?: string) {
      const target = id ?? store.selectionAnchorId();
      if (!target || !store.nodes()[target]) return;
      patchState(store, { renamingNodeId: target });
    },
    cancelRename() {
      patchState(store, { renamingNodeId: null });
    },
    /** Returns an error message to show beside the input, or null when the rename went through. */
    async commitRename(id: string, rawName: string): Promise<string | null> {
      const node = store.nodes()[id];
      if (!node) return null;

      const name = rawName.trim();
      if (name === node.name) {
        patchState(store, { renamingNodeId: null });
        return null;
      }
      const invalid = validateNodeName(name);
      if (invalid) return invalid;
      const clash = this.getNodesByParentId(node.parentId).some(
        (n) => n.id !== id && n.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) return `"${name}" already exists in this folder.`;

      const to = `${parentPathOf(node.path)}\\${name}`;
      try {
        await fileService.renamePath(node.path, to);
      } catch (err) {
        return `Could not rename: ${err}`;
      }
      // Update the tree right away with the same code the file watcher uses. When the watcher's own
      // event arrives a moment later it finds nothing left to do.
      await this.applyRenamed(node.path, to);
      patchState(store, { renamingNodeId: null });
      return null;
    },

    // ───────────────────── Explorer: delete ─────────────────────

    async deleteNodes(ids?: string[]) {
      const nodes = store.nodes();
      const targets = topLevelIds(nodes, ids ?? store.selectedNodeIds()).filter((id) => nodes[id]);
      if (!targets.length) return;
      if (!(await fileService.confirmDelete(targets.map((id) => nodes[id].name)))) return;

      for (const id of targets) {
        const node = store.nodes()[id];
        if (!node) continue;
        try {
          await fileService.removePath(node.path, 'children' in node);
        } catch (err) {
          console.error(`Could not delete ${node.path}`, err);
          continue;
        }
        this.applyRemoved(node.path); // its open tabs close on their own (EditorCommands watches the tree)
      }
      patchState(store, { selectedNodeIds: [], selectionAnchorId: null });
    },

    // ───────────────────── Explorer: move / copy / cut / paste ─────────────────────

    /** Returns an error message, or null on success. `targetFolderId` null = the workspace root. */
    async moveNode(id: string, targetFolderId: string | null): Promise<string | null> {
      const node = store.nodes()[id];
      const target = targetFolderId ? store.nodes()[targetFolderId] : undefined;
      const targetPath = target ? target.path : store.rootPath();
      if (!node || !targetPath || (target && !('children' in target))) return 'Invalid move.';

      if (samePath(parentPathOf(node.path), targetPath)) return null; // already there
      if (normalizePath(targetPath).startsWith(normalizePath(node.path) + '\\')) {
        return `Cannot move "${node.name}" into itself.`;
      }
      const to = `${normalizePath(targetPath)}\\${node.name}`;
      if (await fileService.pathExists(to))
        return `"${node.name}" already exists in the destination.`;

      try {
        await fileService.renamePath(node.path, to);
      } catch (err) {
        return `Could not move: ${err}`;
      }
      await this.applyRenamed(node.path, to);
      // An empty destination folder shows nothing until it is re-read.
      if (target) {
        const folder = store.nodes()[target.id] as FolderNode | undefined;
        if (folder && !folder.children?.length && store.explorerUiState()[folder.id]?.isExpanded) {
          await this.fetchFolderContents(folder.id);
        }
      }
      return null;
    },

    /** Drag-and-drop entry point. Returns the error message of every item that could not be moved. */
    async moveNodes(ids: string[], targetFolderId: string | null): Promise<string[]> {
      const errors: string[] = [];
      for (const id of topLevelIds(store.nodes(), ids)) {
        const err = await this.moveNode(id, targetFolderId);
        if (err) errors.push(err);
      }
      return errors;
    },

    /**
     * "Create this path" from the file search: makes every missing folder, then the file, and puts them in the tree.
     * Never overwrites: an existing file is just returned. `error` is a message to show; `fileId` is the file to
     * open (null for a folder). EditorCommands.createPathFromSearch opens it.
     */
    async createPathFromSearch(
      input: string,
    ): Promise<{ error: string | null; fileId: string | null }> {
      const fail = (error: string) => ({ error, fileId: null });
      const root = store.rootPath();
      if (!root) return fail('Open a folder first.');
      const resolved = resolveNewPath(input);
      if (!resolved.ok) return fail(resolved.error);

      const created: { path: string; kind: 'file' | 'folder' }[] = [];
      let current = normalizePath(root);
      const last = resolved.segments.length - 1;

      try {
        for (let i = 0; i <= last; i++) {
          current = `${current}\\${resolved.segments[i]}`;
          const isTargetFile = i === last && !resolved.isFolder;
          const existing = await fileService.getNodeKind(current);

          if (existing === 'folder') {
            if (isTargetFile) return fail(`"${resolved.display}" is a folder, not a file.`);
            continue; // a folder we can walk through
          }
          if (existing === 'file') {
            if (isTargetFile) break; // already there: fall through and just open it
            return fail(
              `"${resolved.segments[i]}" is a file, so it cannot contain "${resolved.display}".`,
            );
          }
          if (isTargetFile) {
            await fileService.createEmptyFile(current); // refuses to overwrite
            created.push({ path: current, kind: 'file' });
          } else {
            await fileService.makeDirectory(current);
            created.push({ path: current, kind: 'folder' });
          }
        }
      } catch (err) {
        return fail(`Could not create ${resolved.display}: ${err}`);
      }

      // Put the new nodes in the tree top-down (parents first) so resolveFileId can find them.
      // Folders that were never loaded are skipped here and get read from disk by resolveFileId itself.
      for (const item of created) await this.applyCreated(item.path, item.kind);

      try {
        if (resolved.isFolder) {
          const node = findNodeByPath(store.nodes(), current);
          if (node) await this.expandFolder(node.id);
          return { error: null, fileId: null };
        }
        return { error: null, fileId: await this.resolveFileId(current) };
      } catch (err) {
        return fail(`Created ${resolved.display}, but could not open it: ${err}`);
      }
    },

    /** Opens a folder (unlike toggleFolderExpansion, which flips it), reading its contents first if needed. */
    async expandFolder(id: string) {
      const folder = store.nodes()[id];
      if (!folder || !('children' in folder)) return;
      const ui = store.explorerUiState()[id];
      if (ui?.isExpanded) return;
      if (!folder.children?.length) await this.fetchFolderContents(id);
      patchState(store, {
        explorerUiState: {
          ...store.explorerUiState(),
          [id]: { ...store.explorerUiState()[id], isExpanded: true },
        },
      });
    },

    /** True for a node on the clipboard as "cut", and for everything inside a cut folder. */
    isCutNode(id: string): boolean {
      const clip = store.clipboard();
      if (!clip || clip.mode !== 'cut') return false; // returns before reading nodes(): zero cost when nothing is cut
      const cut = new Set(clip.ids);
      const nodes = store.nodes();
      for (let cur: string | null = id; cur; cur = nodes[cur]?.parentId ?? null) {
        if (cut.has(cur)) return true;
      }
      return false;
    },

    copySelection() {
      this._setClipboard('copy');
    },
    cutSelection() {
      this._setClipboard('cut');
    },
    _setClipboard(mode: 'copy' | 'cut') {
      const ids = topLevelIds(store.nodes(), store.selectedNodeIds());
      if (ids.length) patchState(store, { clipboard: { ids, mode } });
    },

    /** The folder a paste lands in: the current node if it's a folder, its parent if it's a file, else the root. */
    _pasteTarget(): { id: string | null; path: string } | null {
      const root = store.rootPath();
      if (!root) return null;
      const focus = store.selectionAnchorId();
      const node = focus ? store.nodes()[focus] : undefined;
      if (!node) return { id: null, path: root };
      if ('children' in node) return { id: node.id, path: node.path };
      const parent = node.parentId ? store.nodes()[node.parentId] : undefined;
      return parent ? { id: parent.id, path: parent.path } : { id: null, path: root };
    },

    /** Returns the error messages of anything that could not be pasted. */
    async paste(): Promise<string[]> {
      const clip = store.clipboard();
      const target = this._pasteTarget();
      if (!clip || !target) return [];

      const errors: string[] = [];
      for (const id of clip.ids) {
        const node = store.nodes()[id];
        if (!node) continue;

        if (clip.mode === 'cut') {
          const err = await this.moveNode(id, target.id);
          if (err) errors.push(err);
          continue;
        }

        const isFolder = 'children' in node;
        if (
          isFolder &&
          (samePath(target.path, node.path) ||
            normalizePath(target.path).startsWith(normalizePath(node.path) + '\\'))
        ) {
          errors.push(`Cannot copy "${node.name}" into itself.`);
          continue;
        }
        const name = await uniqueName(target.path, node.name, isFolder, (p) =>
          fileService.pathExists(p),
        );
        const dest = `${normalizePath(target.path)}\\${name}`;
        try {
          await fileService.copyPath(node.path, dest, isFolder);
        } catch (err) {
          errors.push(`Could not copy "${node.name}": ${err}`);
          continue;
        }
        await this.applyCreated(dest, isFolder ? 'folder' : 'file');
      }
      if (clip.mode === 'cut') patchState(store, { clipboard: null });
      return errors;
    },

    _resolveExternalParent(
      path: string,
    ): { parent: FolderNode | null; isRootLevel: boolean } | null {
      const root = store.rootPath();
      if (!root) return null;
      const parentPath = parentPathOf(path);
      if (samePath(parentPath, root)) return { parent: null, isRootLevel: true };

      const parent = findNodeByPath(store.nodes(), parentPath);

      return parent && 'children' in parent ? { parent, isRootLevel: false } : null;
    },

    async applyCreated(path: string, entry?: string) {
      const slot = this._resolveExternalParent(path);
      if (!slot || findNodeByPath(store.nodes(), path)) return;

      if (slot.parent && !slot.parent.children?.length) {
        if (store.explorerUiState()[slot.parent.id]?.isExpanded) {
          await this.fetchFolderContents(slot.parent.id);
        }
        return;
      }
      const kind =
        entry === 'file' || entry === 'folder' ? entry : await fileService.getNodeKind(path);

      if (!kind) return;

      const again = this._resolveExternalParent(path);
      if (!again || findNodeByPath(store.nodes(), path)) return;
      if (again.parent && !again.parent.children?.length) return;

      const id = crypto.randomUUID();
      const name = baseNameOf(path);
      const parentId = again.parent ? again.parent.id : null;
      const node: WorkspaceNode =
        kind === 'folder'
          ? ({ id, name, path, parentId, children: [] } as FolderNode)
          : ({
              id,
              name,
              path,
              parentId,
              extension: extensionOf(name),
              content: '',
            } as FileNode);

      const nodes = { ...store.nodes(), [id]: node };
      if (again.parent) {
        nodes[again.parent.id] = {
          ...again.parent,
          children: sortIdsByName([...(again.parent.children as string[]), id], nodes),
        } as FolderNode;
      }
      patchState(store, {
        nodes: sortRecordByName(nodes),
        rootNodes: again.isRootLevel
          ? sortRecordByName({ ...store.rootNodes(), [id]: node })
          : store.rootNodes(),
        explorerUiState:
          kind === 'folder'
            ? { ...store.explorerUiState(), [id]: { isExpanded: false, inlineCreation: 'none' } }
            : store.explorerUiState(),
      });
    },

    /**
     * Takes `path` (and everything under it) out of the tree. `keep` can veto single nodes:
     * the watcher uses it so a file with unsaved edits survives being deleted outside the app.
     */
    applyRemoved(path: string) {
      const nodes = { ...store.nodes() };
      const target = findNodeByPath(nodes, path);
      if (!target) return;

      const rootNodes = { ...store.rootNodes() };
      const uiState = { ...store.explorerUiState() };

      for (const id of collectSubtreeIds(nodes, target.id)) {
        delete nodes[id];
        delete rootNodes[id];
        delete uiState[id];
      }

      if (!nodes[target.id] && target.parentId && nodes[target.parentId]) {
        const parent = nodes[target.parentId] as FolderNode;
        nodes[parent.id] = {
          ...parent,
          children: (parent.children ?? []).filter((c) => c !== target.id),
        };
      }

      const active = store.activeNodeId();
      patchState(store, {
        nodes,
        rootNodes,
        explorerUiState: uiState,
        activeNodeId: active && nodes[active] ? active : null,
      });
    },

    /**
     * Renames or moves `from` to `to` in the tree. Node ids stay the same, so open tabs follow the file
     * (EditorCommands moves the model). Returns a path whose content should be re-checked, when the target
     * already existed and is a file.
     */
    async applyRenamed(from: string, to: string): Promise<string | null> {
      const nodes = store.nodes();
      const source = findNodeByPath(nodes, from);
      const existingTarget = findNodeByPath(nodes, to);

      if (existingTarget) {
        if (source) this.applyRemoved(from);
        return 'content' in existingTarget ? to : null;
      }
      if (!source) {
        await this.applyCreated(to);
        return null;
      }

      const slot = this._resolveExternalParent(to);
      if (!slot || (slot.parent && !slot.parent.children?.length)) {
        this.applyRemoved(from);
        return null;
      }

      const next = { ...nodes };
      const rootNodes = { ...store.rootNodes() };
      const newName = baseNameOf(to);
      const newParentId = slot.parent ? slot.parent.id : null;

      for (const id of collectSubtreeIds(nodes, source.id)) {
        const old = nodes[id];
        const isSource = id === source.id;
        let updated = {
          ...old,
          path: isSource ? to : to + old.path.slice(from.length),
        } as WorkspaceNode;
        if (isSource) {
          updated = { ...updated, name: newName, parentId: newParentId } as WorkspaceNode;
          if ('extension' in updated)
            updated = { ...updated, extension: extensionOf(newName) } as FileNode;
          delete rootNodes[id];
          if (slot.isRootLevel) rootNodes[id] = updated;
        }
        next[id] = updated;
      }

      if (source.parentId !== newParentId) {
        if (source.parentId && next[source.parentId]) {
          const oldParent = next[source.parentId] as FolderNode;
          next[oldParent.id] = {
            ...oldParent,
            children: (oldParent.children ?? []).filter((c) => c !== source.id),
          };
        }
        if (slot.parent) {
          const newParent = next[slot.parent.id] as FolderNode;
          next[newParent.id] = {
            ...newParent,
            children: [...(newParent.children ?? []), source.id],
          };
        }
      }

      if (newParentId) {
        const p = next[newParentId] as FolderNode;
        next[newParentId] = { ...p, children: sortIdsByName(p.children ?? [], next) };
      }

      patchState(store, {
        nodes: sortRecordByName(next),
        rootNodes: sortRecordByName(rootNodes),
      });
      return null;
    },

    resetActiveNode() {
      patchState(store, { activeNodeId: null });
    },
  })),
);
