import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapPath = path.join(root, 'docs', 'MAP.md');
const startMarker = '<!-- TREE:START -->';
const endMarker = '<!-- TREE:END -->';
const excludedDirectories = new Set([
  '.angular',
  '.git',
  'assets',
  'dist',
  'gen',
  'icons',
  'node_modules',
  'target',
]);
const excludedLockfiles = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pipfile.lock',
  'poetry.lock',
  'pnpm-lock.yaml',
  'uv.lock',
  'yarn.lock',
]);

function isLockfile(name) {
  const lowerName = name.toLowerCase();
  return excludedLockfiles.has(lowerName) || lowerName.endsWith('.lock');
}

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function listEntries(directoryPath) {
  return readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink() || isLockfile(entry.name)) return false;
      return !entry.isDirectory() || !excludedDirectories.has(entry.name);
    })
    .map((entry) => ({
      name: entry.name,
      path: path.join(directoryPath, entry.name),
      directory: entry.isDirectory(),
    }))
    .sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1;
      return compareNames(left, right);
    });
}

function getChildren(entry) {
  if (entry.name !== 'src-tauri') return listEntries(entry.path);

  const allowedDirectories = new Set(['capabilities', 'src']);
  const allowedFiles = new Set(['Cargo.toml', 'tauri.conf.json']);
  return readdirSync(entry.path, { withFileTypes: true })
    .filter((child) => {
      if (child.isSymbolicLink() || isLockfile(child.name)) return false;
      return child.isDirectory()
        ? allowedDirectories.has(child.name)
        : allowedFiles.has(child.name);
    })
    .map((child) => ({
      name: child.name,
      path: path.join(entry.path, child.name),
      directory: child.isDirectory(),
    }))
    .sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1;
      return compareNames(left, right);
    });
}

function renderChildren(parent, prefix, lines) {
  const children = getChildren(parent);
  const visibleChildren = children.slice(0, 40);

  visibleChildren.forEach((child, index) => {
    const isLast = index === visibleChildren.length - 1 && children.length <= 40;
    lines.push(`${prefix}${isLast ? '└── ' : '├── '}${child.name}${child.directory ? '/' : ''}`);

    if (child.directory) {
      renderChildren(child, `${prefix}${isLast ? '    ' : '│   '}`, lines);
    }
  });

  if (children.length > 40) {
    const remaining = children.length - 40;
    lines.push(`${prefix}└── (+${remaining} more)`);
  }
}

function buildTree() {
  const directoryNames = ['docs', 'scripts', 'sdk', 'src', 'src-tauri', 'tests'];
  const rootConfigNames = [
    '.gitignore',
    '.prettierrc',
    'AGENTS.md',
    'angular.json',
    'package.json',
    'tsconfig.app.json',
    'tsconfig.json',
    'tsconfig.worker.json',
  ];
  const entries = [
    ...directoryNames.map((name) => ({
      name,
      path: path.join(root, name),
      directory: true,
    })),
    ...rootConfigNames
      .filter((name) => {
        try {
          readFileSync(path.join(root, name));
          return true;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      })
      .map((name) => ({
        name,
        path: path.join(root, name),
        directory: false,
      })),
  ].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return compareNames(left, right);
  });

  const lines = ['.'];
  entries.forEach((entry, index) => {
    const isLast = index === entries.length - 1;
    lines.push(`${isLast ? '└── ' : '├── '}${entry.name}${entry.directory ? '/' : ''}`);
    if (entry.directory) {
      renderChildren(entry, isLast ? '    ' : '│   ', lines);
    }
  });
  return lines.join('\n');
}

function main() {
  const checkOnly = process.argv.slice(2);
  if (checkOnly.length > 1 || (checkOnly.length === 1 && checkOnly[0] !== '--check')) {
    console.error('Usage: node scripts/docs-tree.mjs [--check]');
    process.exitCode = 2;
    return;
  }

  const source = readFileSync(mapPath, 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (
    start < 0 ||
    end < 0 ||
    start >= end ||
    source.indexOf(startMarker, start + startMarker.length) >= 0 ||
    source.indexOf(endMarker, end + endMarker.length) >= 0
  ) {
    console.error(`Expected exactly one ordered tree marker pair in ${path.relative(root, mapPath)}.`);
    process.exitCode = 1;
    return;
  }

  const block = [startMarker, '```text', buildTree(), '```', endMarker].join('\n');
  const updated = `${source.slice(0, start)}${block}${source.slice(end + endMarker.length)}`;
  if (checkOnly.length === 1) {
    if (updated !== source) {
      console.error('docs/MAP.md tree is out of date. Run npm run docs:tree.');
      process.exitCode = 1;
    } else {
      console.log('docs/MAP.md tree is up to date.');
    }
    return;
  }

  writeFileSync(mapPath, updated, 'utf8');
  console.log('Updated docs/MAP.md tree.');
}

main();
