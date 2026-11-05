import languageMap from '../../../assets/file-extension-to-language.json';
import { Node } from '../../core/store/node.state';

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
export function topLevelIds(nodes: Record<string, Node>, ids: string[]): string[] {
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
