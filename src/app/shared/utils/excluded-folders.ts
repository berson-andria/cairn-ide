export function isExcludedFolderPath(
  path: string,
  rootPath: string | null,
  exclusions: readonly string[],
): boolean {
  const normalizedPath = normalize(path);
  const normalizedRoot = rootPath ? normalize(rootPath).replace(/\/$/, '') : '';
  const relative = normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
  const parts = relative.split('/').filter(Boolean);

  return exclusions.some((entry) => {
    const rule = normalize(entry).replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    if (!rule) return false;
    if (rule.includes('/')) return relative === rule || relative.startsWith(`${rule}/`);
    return parts.includes(rule);
  });
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
