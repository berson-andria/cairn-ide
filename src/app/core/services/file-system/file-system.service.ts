import { inject, Injectable } from '@angular/core';
import { TauriBridgeService } from '../tauri/tauri-bridge.service';
import { FileNode, WorkspaceNode } from '../../store/workspace/workspace.state';
import {
  stat,
  watch,
  writeTextFile,
  rename,
  remove,
  exists,
  copyFile,
  mkdir,
  readDir,
} from '@tauri-apps/plugin-fs';
import { ask, message, MessageDialogResult } from '@tauri-apps/plugin-dialog';

export type FileSystemWatcherCallback = (event: {
  type: 'create' | 'modify' | 'remove' | 'rename' | any;
  paths: string[];
}) => void;

@Injectable({
  providedIn: 'root',
})
export class FileSystemService {
  tauri = inject(TauriBridgeService);
  private unwatchFn: (() => void) | null = null;

  async startWorkspaceWatcher(
    absoluteRootPath: string,
    onEvent: FileSystemWatcherCallback,
  ): Promise<void> {
    if (this.unwatchFn) {
      this.unwatchFn();
      this.unwatchFn = null;
    }

    try {
      this.unwatchFn = await watch(absoluteRootPath, (event) => onEvent(event as any), {
        recursive: true,
        delayMs: 300,
      });
    } catch (err) {
      console.error(`Failed to start the file watcher for path: ${absoluteRootPath}`, err);
    }
  }

  stopWorkspaceWatcher(): void {
    if (this.unwatchFn) {
      this.unwatchFn();
      this.unwatchFn = null;
    }
  }

  async renamePath(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async removePath(path: string, isFolder: boolean): Promise<void> {
    await remove(path, { recursive: isFolder });
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      return await exists(path);
    } catch {
      return false;
    }
  }

  async copyPath(from: string, to: string, isFolder: boolean): Promise<void> {
    if (!isFolder) {
      await copyFile(from, to);
      return;
    }
    await mkdir(to);
    for (const entry of await readDir(from)) {
      if (entry.isSymlink) continue; // never follow links: they can loop back into the tree
      await this.copyPath(`${from}\\${entry.name}`, `${to}\\${entry.name}`, entry.isDirectory);
    }
  }
  async makeDirectory(path: string): Promise<void> {
    await mkdir(path);
  }

  async createEmptyFile(path: string): Promise<void> {
    await writeTextFile(path, '', { createNew: true });
  }

  async confirmDelete(names: string[]): Promise<boolean> {
    const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
    return ask(
      `Permanently delete ${what}?\n\nThis cannot be undone, and unsaved changes in open files inside will be lost.`,
      { title: 'Delete', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' },
    );
  }
  async askReloadChangedFile(name: string): Promise<boolean> {
    return ask(
      `"${name}" was changed on disk, but you also have unsaved changes in the editor.\n\nReload from disk and discard your changes?`,
      {
        title: 'File changed on disk',
        kind: 'warning',
        okLabel: 'Reload from disk',
        cancelLabel: 'Keep my changes',
      },
    );
  }

  askSaveDirtyFiles(count: number): Promise<MessageDialogResult> {
    return message(`You have ${count} unsaved work.\n\nSave files and close?`, {
      title: 'Close Unsaved Files',
      kind: 'warning',
      buttons: {
        yes: 'Save All',
        no: 'Don`t save',
        cancel: 'Cancel',
      },
    });
  }

  askSaveDirtyFile(fileName: string) {
    return message('You have unsaved changes in ' + fileName + '.\n Would you like to save them?', {
      title: 'Unsaved changes',
      kind: 'warning',
      buttons: {
        yes: 'Save',
        no: 'Don`t save',
        cancel: 'Cancel',
      },
    });
  }

  async getNodeKind(path: string): Promise<'file' | 'folder' | null> {
    try {
      const info = await stat(path);
      return info.isDirectory ? 'folder' : 'file';
    } catch (e) {
      return null;
    }
  }

  async selectFolder() {
    return await this.tauri.showFolderPicker();
  }

  async getRootFolder(rootPath: string): Promise<{
    rootPath: string;
    rootName: string;
    nodes: WorkspaceNode[];
  }> {
    const treeData = await this.readDirectoryContents(rootPath);
    const pathArray = rootPath.split('\\');

    return {
      rootName: <string>pathArray.pop(),
      rootPath: rootPath,
      nodes: treeData,
    };
  }

  async selectAndOpenFile(): Promise<{ nodes: FileNode[] } | null> {
    const selectedPath = await this.tauri.showFilePicker();
    if (!selectedPath) return null;

    const nodes = await this.tauri.invokeCommand<FileNode[]>('get_files', {
      path: selectedPath,
    });
    return {
      nodes: nodes,
    };
  }

  async readDirectoryContents(folderPath: string): Promise<WorkspaceNode[]> {
    return await this.tauri.invokeCommand<WorkspaceNode[]>('read_directory_content', {
      path: folderPath,
    });
  }

  async getFileTextContent(filePath: string): Promise<string> {
    return this.tauri.invokeCommand<string>('read_text_file', { path: filePath });
  }

  async createPhysicalDiskNode(
    path: string,
    name: string,
    nodeType: 'file' | 'folder',
    parentId: string | null,
  ): Promise<WorkspaceNode> {
    return await this.tauri.invokeCommand<WorkspaceNode>('create_fs_node', {
      path,
      name,
      nodeType,
      parentId,
    });
  }

  async saveFile(path: string, content: string) {
    await writeTextFile(path, content);
  }
}
