// persistence.service.ts
import { Injectable, signal } from '@angular/core';
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { NodeState } from '../store/node.state';
import {
  IdeData,
  DEFAULT_IDE_DATA,
  PersistedWorkspace,
  toPersisted,
} from '../../shared/models/persistence.model';

const IDE_FILE = 'ide-data.json';
const WS_DIR = '.ide'; // rename to your IDE's name
const WS_FILE = 'workspace.json';
const MAX_RECENT = 10;

@Injectable({ providedIn: 'root' })
export class PersistenceService {
  private readonly _ide = signal<IdeData>(structuredClone(DEFAULT_IDE_DATA));
  readonly ideData = this._ide.asReadonly();

  // ---------- IDE data (AppData) ----------

  /** Call from the app initializer. Never throws. */
  async loadIdeData(): Promise<IdeData> {
    try {
      if (await exists(IDE_FILE, { baseDir: BaseDirectory.AppData })) {
        const raw = JSON.parse(
          await readTextFile(IDE_FILE, { baseDir: BaseDirectory.AppData }),
        ) as Partial<IdeData>;

        this._ide.set({
          ...DEFAULT_IDE_DATA,
          ...raw,
          lastOpenedFolder: raw.lastOpenedFolder ?? null,
          recentFolders: Array.isArray(raw.recentFolders)
            ? raw.recentFolders.slice(0, MAX_RECENT)
            : [],
        });
      }
    } catch (e) {
      console.error('Failed to load IDE data, using defaults', e);
    }
    return this._ide();
  }

  /** Call whenever a folder is opened, so the recent list survives a crash. */
  async addRecentFolder(path: string) {
    this._ide.update((d) => ({
      ...d,
      recentFolders: [path, ...d.recentFolders.filter((p) => p !== path)].slice(0, MAX_RECENT),
    }));
    await this.saveIdeData();
  }

  async saveIdeData(lastOpenedFolder?: string | null) {
    if (lastOpenedFolder !== undefined) {
      this._ide.update((d) => ({ ...d, lastOpenedFolder }));
    }
    // Create the AppData dir on first run
    await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {});
    await this.atomicWrite(IDE_FILE, JSON.stringify(this._ide(), null, 2), {
      baseDir: BaseDirectory.AppData,
    });
  }

  // ---------- Workspace data (inside the folder) ----------

  async loadWorkspace(rootPath: string): Promise<PersistedWorkspace | null> {
    try {
      const file = await join(rootPath, WS_DIR, WS_FILE);
      if (!(await exists(file))) return null;
      return JSON.parse(await readTextFile(file)) as PersistedWorkspace;
    } catch (e) {
      console.error('Failed to load workspace data', e);
      return null;
    }
  }

  async saveWorkspace(state: NodeState) {
    if (!state.rootPath) return;
    const dir = await join(state.rootPath, WS_DIR);
    await mkdir(dir, { recursive: true }).catch(() => {});
    await this.atomicWrite(await join(dir, WS_FILE), JSON.stringify(toPersisted(state)));
  }

  // ---------- Save everything on close ----------

  async saveOnClose(state: NodeState) {
    // allSettled so one failure doesn't block the other
    await Promise.allSettled([
      this.saveWorkspace(state),
      this.saveIdeData(state.rootPath), // null if no folder was open
    ]);
  }

  // write to .tmp then rename, so a crash mid-write never corrupts the file
  private async atomicWrite(path: string, content: string, opts?: { baseDir: BaseDirectory }) {
    const tmp = `${path}.tmp`;
    await writeTextFile(tmp, content, opts);
    await rename(tmp, path, opts && { oldPathBaseDir: opts.baseDir, newPathBaseDir: opts.baseDir });
  }
}
