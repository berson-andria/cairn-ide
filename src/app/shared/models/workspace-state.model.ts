import type { DiffRequest, DiffSide } from '../../feature/editor/features/diff-tab';
import type { Node } from '../../core/store/node.state';
import type { DiffTab } from '../../feature/editor/features/diff-tab';
import type { Tab, TabContentType } from '../../core/store/tab.store';

export const WORKSPACE_STATE_SCHEMA_VERSION = 1;

export interface PersistedWorkspaceTab {
  type: TabContentType;
  ref: string;
}

export interface WorkspaceStateFile {
  schemaVersion: 1;
  expandedFolders: string[];
  tabs: Array<PersistedWorkspaceTab | null>;
  focus: number[];
}

export type PersistedDiffSide =
  | { kind: 'empty' | 'index' | 'head'; path: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'commit'; rev: string; path: string };

export interface PersistedDiffRequest {
  original: PersistedDiffSide;
  modified: PersistedDiffSide;
}

export interface WorkspaceRestorePlan {
  expandedFolders: string[];
  tabs: Array<{ savedIndex: number; tab: PersistedWorkspaceTab }>;
  focus: number[];
}

const TAB_TYPES: readonly TabContentType[] = ['CodeEditor', 'DiffEditor', 'Task', 'Note', 'Chat'];

export function isProjectRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.replace(/\\/g, '/').split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function relativeProjectPath(rootPath: string, absolutePath: string): string | null {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = absolutePath.replace(/\\/g, '/');
  const prefix = `${root}/`;
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const relative = path.slice(prefix.length);
  return isProjectRelativePath(relative) ? relative : null;
}

export function serializeDiffRequest(request: DiffRequest, rootPath: string): string | null {
  const original = serializeDiffSide(request.original, rootPath);
  const modified = serializeDiffSide(request.modified, rootPath);
  if (!original || !modified) return null;
  return JSON.stringify({ original, modified });
}

export function parseDiffRequest(ref: string): PersistedDiffRequest | null {
  try {
    const raw: unknown = JSON.parse(ref);
    if (!isRecord(raw)) return null;
    const original = parseDiffSide(raw['original']);
    const modified = parseDiffSide(raw['modified']);
    return original && modified ? { original, modified } : null;
  } catch {
    return null;
  }
}

export function createWorkspaceStateFile(
  rootPath: string,
  explorerUiState: Record<string, { isExpanded: boolean }>,
  nodes: Record<string, Node>,
  openedTabs: Tab[],
  focusHistory: Tab[],
  diffTabs: Record<string, DiffTab>,
): { file: WorkspaceStateFile; skippedTypes: TabContentType[] } {
  const expandedFolders = Object.entries(explorerUiState).flatMap(([id, state]) => {
    const node = nodes[id];
    if (!state.isExpanded || !node || !('children' in node)) return [];
    const path = relativeProjectPath(rootPath, node.path);
    return path ? [path] : [];
  });

  const savedTabs: PersistedWorkspaceTab[] = [];
  const savedIndexByTabId = new Map<string, number>();
  const skippedTypes = new Set<TabContentType>();
  for (const tab of openedTabs) {
    const persisted = serializeTab(tab, rootPath, nodes, diffTabs);
    if (!persisted) {
      if (tab.type === 'Chat') skippedTypes.add(tab.type);
      continue;
    }
    savedIndexByTabId.set(tab.id, savedTabs.length);
    savedTabs.push(persisted);
  }

  const focus: number[] = [];
  const focused = new Set<number>();
  for (const tab of focusHistory) {
    const index = savedIndexByTabId.get(tab.id);
    if (index !== undefined && !focused.has(index)) {
      focused.add(index);
      focus.push(index);
    }
  }
  for (let index = 0; index < savedTabs.length; index++) {
    if (!focused.has(index)) focus.push(index);
  }

  return {
    file: {
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      expandedFolders: [...new Set(expandedFolders)],
      tabs: savedTabs,
      focus,
    },
    skippedTypes: [...skippedTypes],
  };
}

export function parseWorkspaceStateFile(raw: string | null): WorkspaceStateFile | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed['schemaVersion'] !== WORKSPACE_STATE_SCHEMA_VERSION)
      return null;
    const folders = parsed['expandedFolders'];
    const parsedTabs = parsed['tabs'];
    const parsedFocus = parsed['focus'];
    const expandedFolders = Array.isArray(folders)
      ? [
          ...new Set(
            folders
              .filter(
                (path): path is string => typeof path === 'string' && isProjectRelativePath(path),
              )
              .map((path) => path.replace(/\\/g, '/')),
          ),
        ]
      : [];
    const tabs = Array.isArray(parsedTabs)
      ? parsedTabs.map((entry): PersistedWorkspaceTab | null => {
          if (!isRecord(entry)) return null;
          const type = entry['type'];
          const ref = entry['ref'];
          if (typeof type !== 'string' || !TAB_TYPES.includes(type as TabContentType)) return null;
          if (typeof ref !== 'string' || ref.length === 0) return null;
          if (type === 'CodeEditor' && !isProjectRelativePath(ref)) return null;
          return { type: type as TabContentType, ref };
        })
      : [];
    const focus = Array.isArray(parsedFocus)
      ? parsedFocus.filter((index): index is number => Number.isInteger(index))
      : [];

    return {
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      expandedFolders,
      tabs,
      focus,
    };
  } catch {
    return null;
  }
}

export function createWorkspaceRestorePlan(
  state: WorkspaceStateFile,
  validTabIndexes: ReadonlySet<number>,
  validFolderPaths: ReadonlySet<string>,
): WorkspaceRestorePlan {
  const tabs = state.tabs.flatMap((tab, savedIndex) =>
    tab && validTabIndexes.has(savedIndex) ? [{ savedIndex, tab }] : [],
  );
  const survivingIndexes = new Set(tabs.map(({ savedIndex }) => savedIndex));
  const focus: number[] = [];
  const focused = new Set<number>();
  for (const index of state.focus) {
    if (survivingIndexes.has(index) && !focused.has(index)) {
      focused.add(index);
      focus.push(index);
    }
  }
  for (const { savedIndex } of tabs) {
    if (!focused.has(savedIndex)) focus.push(savedIndex);
  }

  return {
    expandedFolders: state.expandedFolders.filter((path) => validFolderPaths.has(path)),
    tabs,
    focus,
  };
}

export function validateWorkspaceTabRefs(
  state: WorkspaceStateFile,
  filePaths: ReadonlySet<string>,
  taskIds: ReadonlySet<string>,
  noteIds: ReadonlySet<string>,
): Set<number> {
  const valid = new Set<number>();
  state.tabs.forEach((tab, index) => {
    if (!tab) return;
    if (
      (tab.type === 'CodeEditor' && filePaths.has(tab.ref)) ||
      (tab.type === 'DiffEditor' && parseDiffRequest(tab.ref) !== null) ||
      (tab.type === 'Task' && taskIds.has(tab.ref)) ||
      (tab.type === 'Note' && noteIds.has(tab.ref))
    ) {
      valid.add(index);
    }
  });
  return valid;
}

export function sortFolderPathsByDepth(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length;
    return depth || a.localeCompare(b);
  });
}

function serializeTab(
  tab: Tab,
  rootPath: string,
  nodes: Record<string, Node>,
  diffTabs: Record<string, DiffTab>,
): PersistedWorkspaceTab | null {
  switch (tab.type) {
    case 'CodeEditor': {
      const node = nodes[tab.id];
      if (!node || !('content' in node)) return null;
      const ref = relativeProjectPath(rootPath, node.path);
      return ref ? { type: tab.type, ref } : null;
    }
    case 'DiffEditor': {
      const diff = diffTabs[tab.id];
      if (!diff) return null;
      const ref = serializeDiffRequest(diff.request, rootPath);
      return ref ? { type: tab.type, ref } : null;
    }
    case 'Task':
    case 'Note':
      return { type: tab.type, ref: tab.id };
    case 'Chat':
      return null;
  }
}

function serializeDiffSide(side: DiffSide, rootPath: string): Record<string, string> | null {
  const path = relativeProjectPath(rootPath, side.path);
  if (!path) return null;
  if (side.kind === 'commit') return { kind: side.kind, rev: side.rev, path };
  return { kind: side.kind, path };
}

function parseDiffSide(value: unknown): PersistedDiffSide | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value['kind'];
  const rawPath = value['path'];
  if (typeof kind !== 'string' || typeof rawPath !== 'string') return null;
  const path = rawPath.replace(/\\/g, '/');
  if (!isProjectRelativePath(path)) return null;
  switch (kind) {
    case 'empty':
    case 'index':
    case 'head':
      return { kind, path };
    case 'worktree':
      return { kind: 'worktree', path };
    case 'commit':
      return typeof value['rev'] === 'string' && value['rev'].length > 0
        ? { kind: 'commit', rev: value['rev'], path }
        : null;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
