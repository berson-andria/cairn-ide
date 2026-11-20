import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceStateFile,
  createWorkspaceRestorePlan,
  parseWorkspaceStateFile,
  parseDiffRequest,
  serializeDiffRequest,
  sortFolderPathsByDepth,
  validateWorkspaceTabRefs,
} from '../src/app/shared/models/workspace-state.model.ts';
import type { WorkspaceStateFile } from '../src/app/shared/models/workspace-state.model.ts';

const state: WorkspaceStateFile = {
  schemaVersion: 1,
  expandedFolders: ['src/app', 'src', 'deleted/child'],
  tabs: [
    { type: 'CodeEditor', ref: 'src/main.ts' },
    { type: 'Task', ref: 'task-deleted' },
    { type: 'Note', ref: 'note-1' },
    { type: 'Task', ref: 'task-2' },
  ],
  focus: [1, 1, 90, 0, 2, 3],
};

test('missing, corrupt and unsupported workspace data are ignored', () => {
  assert.equal(parseWorkspaceStateFile(null), null);
  assert.equal(parseWorkspaceStateFile('{broken json'), null);
  assert.equal(parseWorkspaceStateFile('{"schemaVersion":2}'), null);
});

test('parsing skips malformed entries while retaining valid state', () => {
  const parsed = parseWorkspaceStateFile(JSON.stringify({
    schemaVersion: 1,
    expandedFolders: ['src', '../outside', 3],
    tabs: [
      { type: 'CodeEditor', ref: 'src/main.ts' },
      { type: 'CodeEditor', ref: '../outside' },
      { type: 'Task', ref: 42 },
    ],
    focus: [0, 'bad', 2],
  }));
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    expandedFolders: ['src'],
    tabs: [{ type: 'CodeEditor', ref: 'src/main.ts' }, null, null],
    focus: [0, 2],
  });
});

test('validation drops deleted task ids and restore drops missing folders', () => {
  const validTabs = validateWorkspaceTabRefs(
    state,
    new Set(['src/main.ts']),
    new Set(['task-2']),
    new Set(['note-1']),
  );
  const plan = createWorkspaceRestorePlan(
    state,
    validTabs,
    new Set(['src']),
  );

  assert.deepEqual([...validTabs], [0, 2, 3]);
  assert.deepEqual(plan.expandedFolders, ['src']);
  assert.deepEqual(plan.tabs.map(({ savedIndex }) => savedIndex), [0, 2, 3]);
  assert.deepEqual(
    createWorkspaceRestorePlan(state, validTabs, new Set()).expandedFolders,
    [],
  );
});

test('focus mapping drops removed active tabs, invalid indexes and duplicates', () => {
  const plan = createWorkspaceRestorePlan(
    state,
    new Set([0, 2, 3]),
    new Set(['src', 'src/app']),
  );
  assert.deepEqual(plan.focus, [0, 2, 3]);
  assert.equal(plan.focus[0], plan.tabs[0].savedIndex);
  assert.deepEqual(new Set(plan.focus), new Set(plan.tabs.map(({ savedIndex }) => savedIndex)));
});

test('folder expansion restore orders parents before children', () => {
  assert.deepEqual(sortFolderPathsByDepth(['src/app/components', 'docs', 'src/app', 'src']), [
    'docs',
    'src',
    'src/app',
    'src/app/components',
  ]);
});

test('snapshot maps ids to project-relative paths and omits transient or unstable data', () => {
  const fileNode = {
    id: 'random-node-id',
    name: 'main.ts',
    path: 'C:\\repo\\src\\main.ts',
    parentId: 'random-folder-id',
    content: 'unsaved text',
    extension: 'ts',
    isDirty: true,
  };
  const folderNode = {
    id: 'random-folder-id',
    name: 'src',
    path: 'C:\\repo\\src',
    parentId: null,
    children: ['random-node-id'],
  };
  const codeTab = { id: fileNode.id, type: 'CodeEditor' as const };
  const taskTab = { id: 'task-1', type: 'Task' as const };
  const chatTab = { id: 'session-chat-id', type: 'Chat' as const };
  const { file, skippedTypes } = createWorkspaceStateFile(
    'C:\\repo',
    { [folderNode.id]: { isExpanded: true } },
    { [fileNode.id]: fileNode, [folderNode.id]: folderNode },
    [codeTab, taskTab, chatTab],
    [taskTab, codeTab, chatTab],
    {},
  );

  assert.deepEqual(file, {
    schemaVersion: 1,
    expandedFolders: ['src'],
    tabs: [
      { type: 'CodeEditor', ref: 'src/main.ts' },
      { type: 'Task', ref: 'task-1' },
    ],
    focus: [1, 0],
  });
  assert.deepEqual(skippedTypes, ['Chat']);
  assert.equal(JSON.stringify(file).includes('unsaved text'), false);
  assert.equal(JSON.stringify(file).includes('random-node-id'), false);
});

test('diff references retain reconstructable sides without persisting transient file ids', () => {
  const ref = serializeDiffRequest({
    original: { kind: 'commit', rev: 'abc123', path: 'C:\\repo\\src\\old.ts' },
    modified: { kind: 'worktree', fileId: 'random-node-id', path: 'C:\\repo\\src\\main.ts' },
  }, 'C:\\repo');

  assert.equal(ref, JSON.stringify({
    original: { kind: 'commit', rev: 'abc123', path: 'src/old.ts' },
    modified: { kind: 'worktree', path: 'src/main.ts' },
  }));
  assert.deepEqual(parseDiffRequest(ref!), {
    original: { kind: 'commit', rev: 'abc123', path: 'src/old.ts' },
    modified: { kind: 'worktree', path: 'src/main.ts' },
  });
  assert.equal(ref!.includes('random-node-id'), false);
});
