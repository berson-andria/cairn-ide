import darkIconMap from '../../../assets/dark-jetbrains-icon-theme.json';
import lightIconMap from '../../../assets/light-jetbrains-icon-theme.json';

import languageMap from '../../../assets/file-extension-to-language.json';
import { WorkspaceNode } from '../../core/store/workspace/workspace.state';

const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** null = valid, otherwise a message fit to show next to the rename input. Windows rules, applied everywhere. */
export function validateNodeName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'A name is required.';
  if (n === '.' || n === '..') return 'This name is not valid.';
  if (INVALID_CHARS.test(n))
    return 'A name cannot contain any of these characters: < > : " / \\ | ? *';
  if (/[. ]$/.test(n)) return 'A name cannot end with a dot or a space.';
  if (RESERVED_NAMES.test(n)) return `"${n}" is a reserved name.`;
  return null;
}

/**
 * Drops any id whose ancestor is also in the list: if a folder and a file inside it are both
 * selected, deleting/copying the folder already covers the file.
 */
export function topLevelIds(nodes: Record<string, WorkspaceNode>, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let parent = nodes[id]?.parentId ?? null;
    while (parent) {
      if (set.has(parent)) return false;
      parent = nodes[parent]?.parentId ?? null;
    }
    return true;
  });
}

/**
 * "a.txt" -> "a copy.txt" -> "a copy 2.txt" ... until the path is free on disk.
 * Folders and dotfiles ('.gitignore') have no extension to preserve.
 */
export async function uniqueName(
  dir: string,
  name: string,
  isFolder: boolean,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const hasExt = !isFolder && dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';

  let candidate = name;
  for (let n = 1; await exists(`${dir}\\${candidate}`); n++) {
    candidate = `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
  }
  return candidate;
}

export type NewPath =
  | { ok: true; segments: string[]; isFolder: boolean; display: string }
  | { ok: false; error: string };

/**
 * Turns what was typed in the file search ("src/utils/format.ts", "docs/guides/") into the folders and
 * file to create under the project root. A trailing slash means "create a folder".
 * Nothing here touches the disk, so the UI can call it on every keystroke to decide whether to
 * offer "Create ...".
 */
export function resolveNewPath(input: string): NewPath {
  const text = input.trim().replace(/\\/g, '/');
  if (!text) return { ok: false, error: '' };
  if (/^[a-zA-Z]:/.test(text))
    return { ok: false, error: 'Use a path relative to the project folder.' };

  const isFolder = text.endsWith('/');
  // Leading slashes mean "from the project root"; "." segments are no-ops.
  const segments = text.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length) return { ok: false, error: '' };
  if (segments.includes('..'))
    return { ok: false, error: 'A path cannot leave the project folder.' };

  for (const segment of segments) {
    const problem = validateNodeName(segment);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, segments, isFolder, display: segments.join('/') + (isFolder ? '/' : '') };
}

export type ItemType = 'file' | 'folder';

interface IconTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  file: string;
  folder: string;
  folderNames: Record<string, string>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
}

const ASSETS_ROOT = 'assets';

function isDarkMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function lookup(map: Record<string, string>, key: string): string | undefined {
  return map[key] ?? map[key.toLowerCase()];
}

function resolveIconId(theme: IconTheme, name: string, type: ItemType): string {
  if (type === 'folder') {
    return lookup(theme.folderNames, name) ?? theme.folder;
  }

  const byName = lookup(theme.fileNames, name);
  if (byName) return byName;

  // "foo.test.ts" -> ["foo", "test", "ts"] -> try "test.ts", then "ts".
  // ".env.local"  -> ["", "env", "local"]  -> try "env.local", then "local".
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const byExt = lookup(theme.fileExtensions, parts.slice(i).join('.'));
    if (byExt) return byExt;
  }

  return theme.file;
}
export function getIconPath(name: string, type: ItemType, isDark: boolean = isDarkMode()): string {
  const theme = (isDark ? darkIconMap : lightIconMap) as unknown as IconTheme;

  const iconId = resolveIconId(theme, name, type);
  const definition =
    theme.iconDefinitions[iconId] ??
    theme.iconDefinitions[type === 'folder' ? theme.folder : theme.file];

  // iconPath looks like "./icons/folder/folder_dark.svg"
  return `${ASSETS_ROOT}/${definition.iconPath.replace(/^\.\//, '')}`;
}
export function indentStyle(level: number, multiplier: number) {
  return {
    'padding-left': `${level * multiplier + 5}px`,
  };
}

export function getMonacoLanguage(fileName: String): string {
  const lowerName = fileName.toLowerCase();

  if (lowerName === 'dockerfile') return 'dockerfile';
  if (lowerName === 'makefile') return 'makefile';

  const extension = lowerName.split('.').pop();

  if (extension && (languageMap as Record<string, string>)[extension]) {
    return (languageMap as Record<string, string>)[extension];
  }

  return 'plaintext';
}

export function getFileNameFromPath(path: string) {
  return path.split('/').pop();
}
