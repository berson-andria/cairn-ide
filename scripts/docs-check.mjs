import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustRoot = path.join(root, 'src-tauri', 'src');
const docsRoot = path.join(root, 'docs');

function walkFiles(directoryPath, includeFile, skipDirectory = () => false) {
  const files = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectory(entry.name, entryPath)) {
        files.push(...walkFiles(entryPath, includeFile, skipDirectory));
      }
    } else if (entry.isFile() && includeFile(entry.name, entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function registeredCommands(source) {
  const handler = source.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!handler) throw new Error('Could not find generate_handler! in src-tauri/src/lib.rs.');

  return new Set(
    [...handler[1].matchAll(/\bcommands::(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\b/g)].map(
      ([, name]) => name,
    ),
  );
}

function reportDuplicateCommandRows(commands) {
  const commandFiles = new Map();
  const domainFiles = walkFiles(path.join(docsRoot, 'domains'), (name) => name.endsWith('.md'));
  const rowPattern = /^\| `([A-Za-z_]\w*)` \|/gm;

  for (const file of domainFiles) {
    const source = readFileSync(file, 'utf8');
    for (const [, name] of source.matchAll(rowPattern)) {
      if (!commands.has(name)) continue;
      const files = commandFiles.get(name) ?? [];
      const relativeFile = path.relative(root, file).replaceAll(path.sep, '/');
      if (!files.includes(relativeFile)) files.push(relativeFile);
      commandFiles.set(name, files);
    }
  }

  const duplicates = [...commandFiles.entries()].filter(([, files]) => files.length > 1);
  if (duplicates.length === 0) {
    console.log('No Tauri command table rows are duplicated across domain docs.');
    return false;
  }

  console.log('Tauri command table rows appear in multiple domain docs:');
  for (const [name, files] of duplicates) {
    console.log(`  ${name}: ${files.join(', ')}`);
  }
  return true;
}

function eventNames(rustFiles) {
  const names = new Set();
  const eventPattern = /"(?:task|note|proposal|run|project|fs):[a-z_-]+"/g;
  for (const file of rustFiles) {
    const source = readFileSync(file, 'utf8');
    for (const [match] of source.matchAll(eventPattern)) names.add(match.slice(1, -1));
  }
  return names;
}

function serviceErrorCodes(source) {
  const declaration = source.match(/enum\s+ServiceErrorCode\s*\{([\s\S]*?)\}/);
  if (!declaration) {
    throw new Error('Could not find ServiceErrorCode enum in src-tauri/src/services/service_error.rs.');
  }
  return new Set(
    [...declaration[1].matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s*,?\s*$/gm)].map(([, name]) => name),
  );
}

function documentationText() {
  const docsFiles = walkFiles(
    docsRoot,
    () => true,
    (name) => name.toLowerCase() === 'archive',
  );
  return docsFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
}

function markdownLinks(source) {
  const lines = source.split(/\r?\n/);
  let fence;
  const visibleLines = lines.map((line) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      return '';
    }
    if (fence) return '';
    return line.replace(/`[^`\r\n]*`/g, '');
  });
  const text = visibleLines.join('\n');
  const links = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(<[^>]+>|(?:\\.|[^()\s]|\([^)]*\))+)/g,
    /^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|(?:\\.|[^\s])+)/gm,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const destination = match[1].startsWith('<') && match[1].endsWith('>')
        ? match[1].slice(1, -1)
        : match[1];
      links.push({
        destination: destination.replace(/\\([\\`*{}[\]()#+.!_>])/g, '$1'),
        line: text.slice(0, match.index).split('\n').length,
      });
    }
  }
  return links;
}

function checkRelativeMarkdownLinks(files) {
  const broken = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const link of markdownLinks(source)) {
      const destination = link.destination;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) continue;
      const linkPath = destination.split(/[?#]/, 1)[0].replace(/:\d+(?:-\d+)?$/, '');
      if (!linkPath || linkPath.startsWith('/')) continue;

      let decodedPath;
      try {
        decodedPath = decodeURIComponent(linkPath);
      } catch {
        decodedPath = linkPath;
      }
      const target = path.resolve(path.dirname(file), decodedPath);
      if (!existsSync(target)) {
        broken.push(`${path.relative(root, file).replaceAll(path.sep, '/')}:${link.line} -> ${destination}`);
      }
    }
  }

  if (broken.length === 0) {
    console.log('All relative Markdown links in docs/ and README.md resolve.');
    return false;
  }
  console.log('Broken relative Markdown links:');
  for (const link of broken) console.log(`  ${link}`);
  return true;
}

function reportMissing(groups) {
  const missingGroups = [...groups.entries()]
    .map(([kind, names]) => [kind, [...names].filter((name) => !docs.includes(name)).sort()])
    .filter(([, names]) => names.length > 0);

  if (missingGroups.length === 0) {
    console.log('All registered commands, event names, and ServiceErrorCode variants appear in docs/.');
    return false;
  }

  console.log('Missing documentation names:');
  for (const [kind, names] of missingGroups) {
    console.log(`${kind}:`);
    for (const name of names) console.log(`  ${name}`);
  }
  return true;
}

const docs = documentationText();
let failed = false;
try {
  const rustFiles = walkFiles(rustRoot, (name) => name.endsWith('.rs'));
  const libSource = readFileSync(path.join(rustRoot, 'lib.rs'), 'utf8');
  const errorSource = readFileSync(
    path.join(rustRoot, 'services', 'service_error.rs'),
    'utf8',
  );
  const commands = registeredCommands(libSource);
  failed = reportMissing(
    new Map([
      ['Tauri commands', commands],
      ['Events', eventNames(rustFiles)],
      ['ServiceErrorCode variants', serviceErrorCodes(errorSource)],
    ]),
  ) || failed;
  failed = reportDuplicateCommandRows(commands) || failed;
} catch (error) {
  console.error(error.message);
  failed = true;
}

const markdownFiles = [
  ...walkFiles(docsRoot, (name) => name.endsWith('.md')),
  path.join(root, 'README.md'),
];
failed = checkRelativeMarkdownLinks(markdownFiles) || failed;

const treeCheck = spawnSync(process.execPath, [path.join(root, 'scripts', 'docs-tree.mjs'), '--check'], {
  cwd: root,
  encoding: 'utf8',
});
if (treeCheck.stdout) process.stdout.write(treeCheck.stdout);
if (treeCheck.stderr) process.stderr.write(treeCheck.stderr);
if (treeCheck.error) {
  console.error(`Could not run docs tree check: ${treeCheck.error.message}`);
  failed = true;
} else if (treeCheck.status !== 0) {
  failed = true;
}

process.exitCode = failed ? 1 : 0;
