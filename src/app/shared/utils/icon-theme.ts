import darkIconMap from '../../../assets/dark-jetbrains-icon-theme.json';
export type ItemType = 'file' | 'folder';
interface IconTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  file: string;
  folder: string;
  folderNames: Record<string, string>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
}
const theme = darkIconMap as unknown as IconTheme;
const cache = new Map<string, string>();

function lookup(map: Record<string, string>, key: string): string | undefined {
  return map[key] ?? map[key.toLowerCase()];
}

const toSymbolId = (key: string) => `ic-${key.replace(/[^\w-]/g, '_')}`;
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
export function getIconId(name: string, type: ItemType): string {
  const cacheKey = `${type}:${name}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const key = resolveIconId(theme, name, type);
  const safe = theme.iconDefinitions[key] ? key : type === 'folder' ? theme.folder : theme.file;
  const id = toSymbolId(safe);
  cache.set(cacheKey, id);
  return id;
}
