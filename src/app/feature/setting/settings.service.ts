import { computed, effect, inject, Injectable, Signal, signal } from '@angular/core';
import { BaseDirectory, exists, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { NodeStore } from '../../core/store/node.store';
import { SETTINGS, SettingDef, SettingScope, SettingValue } from './settings.registry';

const USER_SETTINGS_FILE = 'settings.json';
const WORKSPACE_SETTINGS_DIR = '.cairn';
const WRITE_DEBOUNCE_MS = 300;
type StoredValues = Record<string, SettingValue>;

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly nodes = inject(NodeStore);
  readonly definitions = SETTINGS;
  private readonly byKey = new Map(SETTINGS.map((def) => [def.key, def]));
  private readonly userValues = signal<StoredValues>({});
  private readonly workspaceValues = signal<StoredValues>({});
  private readonly workspacePath = signal<string | null>(null);
  private readonly writeTimers: Partial<Record<'user' | 'workspace', ReturnType<typeof setTimeout>>> = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private loadGeneration = 0;

  readonly modifiedCount = computed(() => this.definitions.filter((def) => this.isModified(def.key)).length);

  constructor() {
    effect(() => {
      const path = this.nodes.rootPath();
      if (path !== this.workspacePath()) void this.reloadWorkspace(path);
    });
  }

  /** Reactive effective value: workspace, then user, then the registry default. */
  get<T = SettingValue>(key: string): Signal<T> {
    const def = this.definition(key);
    return computed(() => this.effective(def) as T);
  }

  /** Backwards-friendly alias for call sites that prefer the select terminology. */
  select<T = SettingValue>(key: string): Signal<T> {
    return this.get<T>(key);
  }

  /** Apply a valid value immediately, then persist a debounced scope snapshot. */
  set(key: string, raw: unknown, scope?: 'user' | 'workspace'): void {
    const def = this.definition(key);
    const target = scope ?? this.defaultWriteScope(def);
    this.assertAllowed(def, target);
    if (!isValidValue(def, raw)) throw new TypeError(`Invalid value for setting "${key}"`);

    const values = target === 'user' ? this.userValues : this.workspaceValues;
    values.update((current) => {
      const next = { ...current };
      if (sameValue(raw, def.default)) delete next[key];
      else next[key] = cloneValue(raw);
      return next;
    });
    this.scheduleWrite(target);
  }

  reset(key: string, scope?: 'user' | 'workspace'): void {
    const def = this.definition(key);
    this.set(key, def.default, scope);
  }

  sourceOf(key: string): 'default' | 'user' | 'workspace' {
    const def = this.definition(key);
    if (Object.hasOwn(this.workspaceValues(), key)) return 'workspace';
    if (Object.hasOwn(this.userValues(), key)) return 'user';
    return 'default';
  }

  isModified(key: string): boolean {
    return this.sourceOf(key) !== 'default';
  }

  resetAll(): void {
    this.userValues.set({});
    this.workspaceValues.set({});
    this.scheduleWrite('user');
    if (this.workspacePath()) this.scheduleWrite('workspace');
  }

  /** Loads user settings and the currently open workspace settings. Safe to call at startup. */
  async load(): Promise<void> {
    await this.loadUserSettings();
    await this.reloadWorkspace(this.nodes.rootPath());
  }

  /** Reload workspace overrides after opening or switching a folder. */
  async reloadWorkspace(rootPath: string | null = this.nodes.rootPath()): Promise<void> {
    const generation = ++this.loadGeneration;
    this.workspacePath.set(rootPath);
    this.workspaceValues.set({});
    if (!rootPath) {
      return;
    }
    const path = await join(rootPath, WORKSPACE_SETTINGS_DIR, USER_SETTINGS_FILE);
    const values = await this.readValues(path);
    if (generation === this.loadGeneration && rootPath === this.workspacePath()) {
      this.workspaceValues.set(filterValues(values, this.byKey, 'workspace'));
    }
  }

  private effective(def: SettingDef): SettingValue {
    const workspace = this.workspaceValues();
    if (Object.hasOwn(workspace, def.key)) return workspace[def.key];
    const user = this.userValues();
    if (Object.hasOwn(user, def.key)) return user[def.key];
    return def.default;
  }

  private definition(key: string): SettingDef {
    const def = this.byKey.get(key);
    if (!def) throw new Error(`Unknown setting "${key}"`);
    return def;
  }

  private defaultWriteScope(def: SettingDef): 'user' | 'workspace' {
    return def.scope === 'workspace' ? 'workspace' : 'user';
  }

  private assertAllowed(def: SettingDef, scope: 'user' | 'workspace'): void {
    if (def.scope !== 'both' && def.scope !== scope) {
      throw new Error(`Setting "${def.key}" does not allow ${scope} scope`);
    }
    if (scope === 'workspace' && !this.workspacePath()) {
      throw new Error(`Cannot write workspace setting "${def.key}" without an open workspace`);
    }
  }

  private async loadUserSettings(): Promise<void> {
    const values = await this.readValues(USER_SETTINGS_FILE, { baseDir: BaseDirectory.AppData });
    this.userValues.set(filterValues(values, this.byKey, 'user'));
  }

  private async readValues(path: string, opts?: { baseDir: BaseDirectory }): Promise<StoredValues> {
    try {
      if (!(await exists(path, opts))) return {};
      const parsed: unknown = JSON.parse(await readTextFile(path, opts));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredValues : {};
    } catch {
      // Missing, unreadable, or malformed files all fall back to defaults.
      return {};
    }
  }

  private scheduleWrite(scope: 'user' | 'workspace'): void {
    const existing = this.writeTimers[scope];
    if (existing) clearTimeout(existing);
    const snapshot = cloneRecord(scope === 'user' ? this.userValues() : this.workspaceValues());
    const targetPath = scope === 'workspace' ? this.workspacePath() : null;
    this.writeTimers[scope] = setTimeout(() => {
      delete this.writeTimers[scope];
      this.enqueueWrite(scope, snapshot, targetPath);
    }, WRITE_DEBOUNCE_MS);
  }

  private enqueueWrite(scope: 'user' | 'workspace', snapshot: StoredValues, targetPath: string | null): void {
    if (scope === 'workspace' && !targetPath) return;
    this.writeQueue = this.writeQueue
      .then(() => scope === 'user'
        ? this.writeUserSettings(snapshot)
        : this.writeWorkspaceSettings(targetPath!, snapshot))
      .catch((error) => console.error(`Failed to write ${scope} settings`, error));
  }

  private async writeUserSettings(values: StoredValues): Promise<void> {
    await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {});
    await this.atomicWrite(USER_SETTINGS_FILE, JSON.stringify(values, null, 2), { baseDir: BaseDirectory.AppData });
  }

  private async writeWorkspaceSettings(rootPath: string, values: StoredValues): Promise<void> {
    const directory = await join(rootPath, WORKSPACE_SETTINGS_DIR);
    await mkdir(directory, { recursive: true });
    const path = await join(directory, USER_SETTINGS_FILE);
    await this.atomicWrite(path, JSON.stringify(values, null, 2));
  }

  private async atomicWrite(path: string, contents: string, opts?: { baseDir: BaseDirectory }): Promise<void> {
    const temporary = `${path}.tmp`;
    await writeTextFile(temporary, contents, opts);
    await rename(temporary, path, opts && { oldPathBaseDir: opts.baseDir, newPathBaseDir: opts.baseDir });
  }
}

function isValidValue(def: SettingDef, value: unknown): value is SettingValue {
  switch (def.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'enum': return typeof value === 'string' && !!def.options?.some((option) => option.value === value);
    case 'string':
    case 'path':
    case 'command': return typeof value === 'string';
    case 'string-list': return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

function filterValues(
  values: StoredValues,
  definitions: Map<string, SettingDef>,
  scope: 'user' | 'workspace',
): StoredValues {
  const accepted: StoredValues = {};
  for (const [key, value] of Object.entries(values)) {
    const def = definitions.get(key);
    if (def && (def.scope === scope || def.scope === 'both') && isValidValue(def, value) && !sameValue(value, def.default)) {
      accepted[key] = cloneValue(value);
    }
  }
  return accepted;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function cloneValue<T extends SettingValue>(value: T): T {
  return structuredClone(value);
}

function cloneRecord(values: StoredValues): StoredValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, cloneValue(value)]));
}
