import '@angular/compiler';
import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { RunStore } from '../src/app/core/store/run.store';
import { TaskStore } from '../src/app/core/store/task.store';
import { NodeStore } from '../src/app/core/store/node.store';
import { NoticeManager } from '../src/app/core/services/notification/notification.service';
import { WorkApiService } from '../src/app/core/services/tauri/work-api.service';
import { refreshFinishedRun } from '../src/app/core/services/tauri/work-sync.service';
import { ProposalNotifier } from '../src/app/core/services/proposals/proposal-notifier.service';
import { RunService } from '../src/app/core/services/runs/run.service';
import {
  WorkflowService,
  deriveTrustState,
  summarizeChanges,
} from '../src/app/core/services/runs/workflow.service';
import { TaskService, type TaskItem, type TaskStatus } from '../src/app/feature/tasks/task.service';
import type {
  Proposal,
  RunRecord,
  RunState,
  WorkflowInfo,
  WorkflowSource,
  WorkflowTrustStatus,
} from '../src/app/shared/models/agent.model';

const task = (id: string, status: TaskStatus = 'ready', dependsOn?: string): TaskItem => ({
  id,
  title: id,
  status,
  createdAt: 1,
  schemaVersion: 1,
  rev: 1,
  ...(dependsOn ? { dependsOn } : {}),
});

const workflow = (name: string, source: WorkflowSource = 'project'): WorkflowInfo => ({
  name,
  source,
  overrides: [],
  trusted: true,
  entry: `${source}/${name}.py`,
});

const trustStatus = (overrides: Partial<WorkflowTrustStatus> = {}): WorkflowTrustStatus => ({
  hasWorkflows: true,
  trusted: false,
  folderHash: 'folder-hash',
  files: [{ path: 'main.py', size: 4, sha256: 'file-hash' }],
  changes: [],
  ...overrides,
});
const runRecord = (runId: string): RunRecord => ({
  runId,
  taskId: 'task-1',
  workflow: 'default',
  source: 'project',
  scriptHash: 'hash',
  startedAt: 1,
  endedAt: 2,
  outcome: 'needs_review',
});

function makeHarness(
  options: {
    tasks?: TaskItem[];
    current?: RunState | null;
    rootPath?: string | null;
    workflows?: WorkflowInfo[];
    needsTrustReview?: boolean;
    trustState?: 'unknown' | 'none' | 'unreviewed' | 'changed' | 'trusted';
    runStore?: Pick<RunStore, 'current' | 'logLines' | 'refresh' | 'record' | 'setRecord'>;
    api?: Partial<WorkApiService>;
  } = {},
) {
  const taskStore = new TaskStore();
  taskStore.replace(options.tasks ?? [task('task-1')], []);
  const runRecords = signal<Record<string, RunRecord>>({});
  const runStore = options.runStore ?? {
    current: signal(options.current ?? null).asReadonly(),
    logLines: () => signal<string[]>([]).asReadonly(),
    refresh: async () => {},
    record: (runId: string) => computed(() => runRecords()[runId]),
    setRecord: (record: RunRecord) =>
      runRecords.update((records) => ({ ...records, [record.runId]: record })),
  };
  const api = {
    runStart: async () => ({}) as RunRecord,
    ...options.api,
  };
  const workflows = {
    workflows: signal(options.workflows ?? [workflow('default')]).asReadonly(),
    needsTrustReview: signal(options.needsTrustReview ?? false).asReadonly(),
    trustState: signal(
      options.trustState ?? (options.needsTrustReview ? 'unreviewed' : 'trusted'),
    ).asReadonly(),
  };
  const injector = Injector.create({
    providers: [
      { provide: WorkApiService, useValue: api },
      { provide: RunStore, useValue: runStore },
      { provide: TaskStore, useValue: taskStore },
      {
        provide: NodeStore,
        useValue: {
          rootPath: signal(options.rootPath === undefined ? '/project' : options.rootPath),
        },
      },
      { provide: WorkflowService, useValue: workflows },
      { provide: NoticeManager, useValue: { error: () => {} } },
    ],
  });
  const runService = runInInjectionContext(injector, () => new RunService());
  const taskInjector = Injector.create({
    parent: injector,
    providers: [{ provide: RunService, useValue: runService }],
  });
  const taskService = runInInjectionContext(taskInjector, () => new TaskService());
  return { injector, taskStore, runStore, runService, taskService, api, workflows };
}

test('availableActions offers cancellation only for the task with the active run', () => {
  const active = { runId: 'run-1', taskId: 'task-1' };
  const sameTask = makeHarness({
    tasks: [task('task-1', 'running')],
    current: active,
  }).taskService.availableActions(task('task-1', 'running'));
  assert.deepEqual(sameTask, [
    { action: 'cancelRun', enabled: true },
    { action: 'complete', enabled: false, reason: 'A workflow is running; cancel it first' },
  ]);

  const handStarted = makeHarness({
    tasks: [task('task-1', 'running')],
  }).taskService.availableActions(task('task-1', 'running'));
  assert.deepEqual(handStarted, [{ action: 'complete', enabled: true }]);

  const anotherTask = makeHarness({
    tasks: [task('task-1', 'running'), task('task-2', 'running')],
    current: { runId: 'run-2', taskId: 'task-2' },
  }).taskService.availableActions(task('task-1', 'running'));
  assert.deepEqual(anotherTask, [{ action: 'complete', enabled: true }]);
});

test('perform delegates cancelRun to RunService.cancel', async () => {
  let cancelCalls = 0;
  const harness = makeHarness({
    tasks: [task('task-1', 'running')],
    current: { runId: 'run-1', taskId: 'task-1' },
    api: {
      runCancel: async () => {
        cancelCalls++;
      },
    },
  });

  await harness.taskService.perform(task('task-1', 'running'), 'cancelRun');
  assert.equal(cancelCalls, 1);
});

test('isRunning ignores an unfinished run whose cached task is no longer running', () => {
  const harness = makeHarness({
    tasks: [task('task-1', 'ready')],
    current: { runId: 'run-1', taskId: 'task-1' },
  });
  assert.equal(harness.runService.isRunning(), false);
});

test('run:finished refreshes exactly once and replaces partial current state', async () => {
  const fullRun: RunRecord = {
    runId: 'run-1',
    taskId: 'task-1',
    workflow: 'default',
    source: 'project',
    scriptHash: 'hash',
    startedAt: 10,
    endedAt: 20,
    outcome: 'needs_review',
    summary: 'Finished',
  };
  let runGetCalls = 0;
  const api = {
    runGet: async () => {
      runGetCalls++;
      return fullRun;
    },
  };
  const storeInjector = Injector.create({
    providers: [{ provide: WorkApiService, useValue: api }],
  });
  const runStore = runInInjectionContext(storeInjector, () => new RunStore());
  runStore.started({ runId: 'run-1', taskId: 'task-1', workflow: 'default' });
  runStore.setRecord({ ...fullRun, outcome: 'failed' });
  const harness = makeHarness({ runStore, api });

  const refresh = refreshFinishedRun(
    { runId: 'run-1', taskId: 'task-1', outcome: 'needs_review' },
    runStore,
    harness.runService,
  );
  assert.equal(runStore.current()?.startedAt, undefined);
  assert.equal(runStore.current()?.summary, undefined);
  assert.equal(runStore.record(fullRun.runId)()?.outcome, 'needs_review');
  await refresh;

  assert.equal(runGetCalls, 1);
  assert.equal(runStore.current()?.startedAt, fullRun.startedAt);
  assert.equal(runStore.current()?.endedAt, fullRun.endedAt);
  assert.equal(runStore.current()?.summary, fullRun.summary);
  assert.deepEqual(runStore.record(fullRun.runId)(), fullRun);
});

test('attemptCount and lastRunId use the task run history', () => {
  const runService = makeHarness().runService;
  const withHistory = { ...task('task-1'), runs: ['run-1', 'run-2'] };
  assert.equal(runService.attemptCount(withHistory), 2);
  assert.equal(runService.lastRunId(withHistory), 'run-2');

  const withoutHistory = task('task-2');
  assert.equal(runService.attemptCount(withoutHistory), 0);
  assert.equal(runService.lastRunId(withoutHistory), undefined);
});

test('loadRunsFor fetches only missing recent ids and skips NotFound within its limit', async () => {
  const cached = runRecord('run-8');
  const calls: string[] = [];
  const harness = makeHarness({
    api: {
      runGet: async (runId?: string) => {
        calls.push(runId ?? '');
        if (runId === 'run-7') throw { code: 'NotFound', message: 'missing' };
        return runRecord(runId ?? '');
      },
    },
  });
  harness.runStore.setRecord(cached);

  const records = await harness.runService.loadRunsFor(
    {
      ...task('task-1'),
      runs: ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6', 'run-7', 'run-8'],
    },
    3,
  );

  assert.deepEqual(calls, ['run-7', 'run-6']);
  assert.ok(calls.length <= 3);
  assert.deepEqual(
    records.map((record) => record.runId),
    ['run-8', 'run-6'],
  );
  assert.equal(harness.runStore.record('run-6')()?.runId, 'run-6');
});

test('runDisabledReason reports project, task, run, dependency, and workflow blockers', () => {
  const noProject = makeHarness({ rootPath: null }).runService;
  assert.equal(
    noProject.runDisabledReason(task('task-1')),
    'Open a project before starting a workflow.',
  );

  const notReady = makeHarness().runService;
  assert.equal(notReady.runDisabledReason(task('task-1', 'running')), 'Task is not ready.');

  const activeRun = makeHarness({
    tasks: [task('task-1', 'ready'), task('task-2', 'running')],
    current: { runId: 'run-2', taskId: 'task-2' },
  }).runService;
  assert.equal(activeRun.runDisabledReason(task('task-1')), 'Another workflow is running.');

  const dependency = makeHarness({
    tasks: [task('task-1', 'ready', 'dependency'), task('dependency', 'ready')],
  }).runService;
  assert.equal(
    dependency.runDisabledReason(task('task-1', 'ready', 'dependency')),
    'Complete the dependency first.',
  );

  const noWorkflows = makeHarness({ workflows: [] }).runService;
  assert.equal(noWorkflows.runDisabledReason(task('task-1')), 'No workflows are available.');

  const multiple = makeHarness({ workflows: [workflow('one'), workflow('two')] }).runService;
  assert.equal(multiple.runDisabledReason(task('task-1')), 'Choose a workflow.');
  assert.equal(multiple.runDisabledReason(task('task-1'), 'missing'), 'Workflow not found.');

  const projectUntrusted = makeHarness({
    workflows: [workflow('project-workflow')],
    needsTrustReview: true,
    trustState: 'unreviewed',
  }).runService;
  assert.equal(
    projectUntrusted.runDisabledReason(task('task-1'), 'project-workflow'),
    "Workflows in this project haven't been reviewed; review them in Settings",
  );

  const projectChanged = makeHarness({
    workflows: [workflow('project-workflow')],
    trustState: 'changed',
  }).runService;
  assert.equal(
    projectChanged.runDisabledReason(task('task-1'), 'project-workflow'),
    'Workflows changed since you approved them; review the changes in Settings',
  );

  const globalWorkflow = makeHarness({
    workflows: [workflow('global-workflow', 'global')],
    needsTrustReview: true,
  }).runService;
  assert.equal(globalWorkflow.runDisabledReason(task('task-1'), 'global-workflow'), null);
});

test('runDisabledReason allows the default or the sole workflow', async () => {
  const selected: string[] = [];
  const defaultHarness = makeHarness({
    api: {
      runStart: async (_taskId: string, _rev: number, name?: string) => {
        selected.push(name ?? '');
        return {} as RunRecord;
      },
    },
  });
  assert.equal(defaultHarness.runService.canRun(task('task-1')), true);
  await defaultHarness.runService.run('task-1');

  const singleHarness = makeHarness({
    workflows: [workflow('only')],
    api: {
      runStart: async (_taskId: string, _rev: number, name?: string) => {
        selected.push(name ?? '');
        return {} as RunRecord;
      },
    },
  });
  assert.equal(singleHarness.runService.canRun(task('task-1')), true);
  await singleHarness.runService.run('task-1');
  assert.deepEqual(selected, ['default', 'only']);
});

test('perform forwards the chosen workflow to RunService.run', async () => {
  let selected = '';
  const harness = makeHarness({
    workflows: [workflow('one'), workflow('two')],
    api: {
      runStart: async (_taskId: string, _rev: number, name?: string) => {
        selected = name ?? '';
        return {} as RunRecord;
      },
    },
  });
  await harness.taskService.perform(task('task-1'), 'run', { workflow: 'two' });
  assert.equal(selected, 'two');
});

test('run returns trust-required without inspecting or approving the workflow', async () => {
  let trustCalls = 0;
  const harness = makeHarness({
    api: {
      runStart: async () => {
        throw { code: 'TrustRequired', message: 'Review the project workflows.' };
      },
      workspaceTrust: async () => {
        trustCalls++;
      },
    },
  });

  assert.deepEqual(await harness.runService.run('task-1'), { kind: 'trust-required' });
  assert.equal(trustCalls, 0);
});

function workflowServiceHarness(api: Partial<WorkApiService>, rootPath = '/project') {
  const injector = Injector.create({
    providers: [
      { provide: WorkApiService, useValue: api },
      { provide: NodeStore, useValue: { rootPath: signal<string | null>(rootPath) } },
      { provide: NoticeManager, useValue: { error: () => {} } },
    ],
  });
  return runInInjectionContext(injector, () => new WorkflowService());
}

test('deriveTrustState covers all workflow trust states and stale approval cases', () => {
  assert.equal(deriveTrustState(null), 'unknown');
  assert.equal(deriveTrustState(trustStatus({ hasWorkflows: false })), 'none');
  assert.equal(deriveTrustState(trustStatus({ trusted: true })), 'trusted');
  assert.equal(deriveTrustState(trustStatus({ approvedHash: undefined })), 'unreviewed');
  assert.equal(
    deriveTrustState(trustStatus({ approvedHash: 'old-hash', changes: [] })),
    'changed',
  );
  assert.equal(
    deriveTrustState(trustStatus({ hasWorkflows: false, approvedHash: 'old-hash' })),
    'none',
  );
});

test('summarizeChanges counts added modified removed and details availability', () => {
  assert.deepEqual(
    summarizeChanges(trustStatus({
      changes: [
        { path: 'a.py', change: 'added' },
        { path: 'b.py', change: 'modified' },
        { path: 'b.py', change: 'modified' },
        { path: 'c.py', change: 'removed' },
      ],
    })),
    { added: 1, modified: 2, removed: 1, detailsAvailable: true },
  );
  assert.deepEqual(
    summarizeChanges(trustStatus({ approvedHash: 'old-hash', changes: [] })),
    { added: 0, modified: 0, removed: 0, detailsAvailable: false },
  );
});

test('trustReview$ emits once per hash and resets on workspace clear', async () => {
  let status = trustStatus();
  const service = workflowServiceHarness({
    workspaceTrustStatus: async () => status,
  });
  const emissions: unknown[] = [];
  const subscription = service.trustReview$.subscribe((review) => emissions.push(review));

  await service.refreshTrust();
  await service.refreshTrust();
  assert.deepEqual(emissions, [{
    state: 'unreviewed',
    summary: { added: 0, modified: 0, removed: 0, detailsAvailable: false },
  }]);

  status = trustStatus({ folderHash: 'changed-hash', approvedHash: 'old-hash', changes: [
    { path: 'main.py', change: 'modified' },
  ] });
  await service.refreshTrust();
  assert.deepEqual(emissions.at(-1), {
    state: 'changed',
    summary: { added: 0, modified: 1, removed: 0, detailsAvailable: true },
  });

  status = trustStatus({ folderHash: 'changed-hash', trusted: true });
  await service.refreshTrust();
  assert.equal(emissions.length, 2);

  status = trustStatus({ hasWorkflows: false, folderHash: 'none-hash' });
  await service.refreshTrust();
  assert.equal(emissions.length, 2);

  service.clear();
  status = trustStatus({ folderHash: 'changed-hash' });
  await service.refreshTrust();
  assert.equal(emissions.length, 3);
  subscription.unsubscribe();
});

test('approve uses the displayed hash and handles validation by refreshing trust', async () => {
  let displayedHash = '';
  let status = trustStatus({ folderHash: 'displayed-hash' });
  const service = workflowServiceHarness({
    workspaceTrustStatus: async () => status,
    workspaceTrust: async (hash: string) => {
      displayedHash = hash;
    },
  });
  await service.refreshTrust();
  assert.deepEqual(await service.approve('displayed-hash'), { kind: 'approved' });
  assert.equal(displayedHash, 'displayed-hash');

  let refreshes = 0;
  const changedService = workflowServiceHarness({
    workspaceTrustStatus: async () => {
      refreshes++;
      return trustStatus({ folderHash: 'new-hash', approvedHash: 'old-hash', changes: [
        { path: 'main.py', change: 'modified' },
      ] });
    },
    workspaceTrust: async () => {
      throw { code: 'Validation', message: 'The workflow files changed.' };
    },
  });
  await changedService.refreshTrust();
  refreshes = 0;
  assert.deepEqual(
    await changedService.approve('stale-hash'),
    { kind: 'changed-while-reviewing' },
  );
  assert.equal(refreshes, 1);
});

test('needsTrustReview requires project workflows and an untrusted status', async () => {
  let status = trustStatus({ hasWorkflows: false });
  const service = workflowServiceHarness({
    workspaceTrustStatus: async () => status,
  });
  await service.refreshTrust();
  assert.equal(service.needsTrustReview(), false);

  status = trustStatus({ trusted: true });
  await service.refreshTrust();
  assert.equal(service.needsTrustReview(), false);

  status = trustStatus();
  await service.refreshTrust();
  assert.equal(service.needsTrustReview(), true);
  service.clear();
  assert.equal(service.needsTrustReview(), false);
});

test('workflow trust status refresh is debounced and ignores unrelated filesystem paths', async () => {
  let calls = 0;
  const service = workflowServiceHarness({
    workspaceTrustStatus: async () => {
      calls++;
      return trustStatus();
    },
  });
  service.filesChanged(['/project/src/app.ts']);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(calls, 0);

  service.filesChanged(['/project/.cairn/workflows/main.py']);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(calls, 0);
  service.filesChanged(['/project/.cairn/workflows/helpers/common.py']);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls, 1);
  service.clear();
});

test('subtaskProgress reports done running failed pending and percent', () => {
  const service = makeHarness().taskService;
  const progressTask: TaskItem = {
    ...task('task-1'),
    subTasks: [
      { id: 'done-1', title: 'Done', status: 'completed', createdAt: 1 },
      { id: 'done-2', title: 'Review', status: 'needs_review', createdAt: 1 },
      { id: 'run-1', title: 'Running', status: 'running', createdAt: 1 },
      { id: 'fail-1', title: 'Failed', status: 'failed', createdAt: 1 },
      { id: 'pending-1', title: 'Pending', status: 'ready', createdAt: 1 },
    ],
  };
  assert.deepEqual(service.subtaskProgress(progressTask), {
    total: 5,
    done: 2,
    running: 1,
    failed: 1,
    pending: 1,
    percent: 40,
  });
  assert.deepEqual(service.subtaskProgress(task('task-2')), {
    total: 0,
    done: 0,
    running: 0,
    failed: 0,
    pending: 0,
    percent: 0,
  });
});

test('availableActions offers resume for failed tasks with finished and pending steps', () => {
  const partial: TaskItem = {
    ...task('task-1', 'failed'),
    subTasks: [
      { id: 'done', title: 'Done', status: 'needs_review', createdAt: 1 },
      { id: 'pending', title: 'Pending', status: 'ready', createdAt: 1 },
    ],
  };
  assert.deepEqual(makeHarness({ tasks: [partial] }).taskService.availableActions(partial), [
    { action: 'retry', enabled: true },
    { action: 'resume', enabled: true, hint: '1 of 2 steps done' },
  ]);

  const noDone: TaskItem = {
    ...task('task-2', 'failed'),
    subTasks: [{ id: 'pending', title: 'Pending', status: 'ready', createdAt: 1 }],
  };
  assert.deepEqual(makeHarness({ tasks: [noDone] }).taskService.availableActions(noDone), [
    { action: 'retry', enabled: true },
  ]);
});

test('perform resume sets ready before run and stops on status error', async () => {
  const calls: string[] = [];
  const partial: TaskItem = {
    ...task('task-1', 'failed'),
    subTasks: [
      { id: 'done', title: 'Done', status: 'needs_review', createdAt: 1 },
      { id: 'pending', title: 'Pending', status: 'ready', createdAt: 1 },
    ],
  };
  const success = makeHarness({
    tasks: [partial],
    api: {
      taskSetStatus: async () => {
        calls.push('status');
        return { ...partial, status: 'ready', rev: 2 };
      },
      runStart: async () => {
        calls.push('run');
        return runRecord('run-1');
      },
    },
  });
  await success.taskService.perform(partial, 'resume');
  assert.deepEqual(calls, ['status', 'run']);

  calls.length = 0;
  const stopped = makeHarness({
    tasks: [partial],
    api: {
      taskSetStatus: async () => {
        calls.push('status');
        throw { code: 'Io', message: 'cannot update' };
      },
      runStart: async () => {
        calls.push('run');
        return runRecord('run-2');
      },
    },
  });
  await stopped.taskService.perform(partial, 'resume');
  assert.deepEqual(calls, ['status']);
});

test('run step events update stepStatus and latest state', () => {
  const api = { runGet: async () => null };
  const injector = Injector.create({ providers: [{ provide: WorkApiService, useValue: api }] });
  const store = runInInjectionContext(injector, () => new RunStore());
  store.step({
    runId: 'run-1',
    taskId: 'task-1',
    subtaskId: 'sub-1',
    status: 'running',
  });
  store.step({
    runId: 'run-1',
    taskId: 'task-1',
    subtaskId: 'sub-1',
    status: 'needs_review',
    summary: 'Implemented',
  });
  assert.deepEqual(store.stepStatus('run-1')(), {
    'sub-1': { status: 'needs_review', summary: 'Implemented' },
  });
  store.clear();
  assert.deepEqual(store.stepStatus('run-1')(), {});
});

test('proposal notifier emits on quiet time or the five-second maximum wait', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const notifier = new ProposalNotifier();
  const emittedAt: number[] = [];
  const subscription = notifier.notifications$.subscribe(() => emittedAt.push(Date.now()));
  const proposal = (index: number): Proposal => ({
    id: `proposal-${index}`,
    kind: 'task',
    status: 'pending',
    presentation: 'notify',
    runId: 'run-1',
    workflow: 'default',
    payload: { title: `Suggestion ${index}` },
    createdAt: index,
    schemaVersion: 1,
    rev: 1,
  });

  notifier.proposalCreated(proposal(0));
  let now = 0;
  for (let index = 1; index <= 15; index++) {
    const nextProposalAt = index * 800;
    const nextMaxWaitAt = (Math.floor(now / 5000) + 1) * 5000;
    if (nextProposalAt > nextMaxWaitAt) {
      t.mock.timers.tick(nextMaxWaitAt - now);
      now = nextMaxWaitAt;
    }
    t.mock.timers.tick(nextProposalAt - now);
    now = nextProposalAt;
    notifier.proposalCreated(proposal(index));
  }
  t.mock.timers.tick(1000);
  subscription.unsubscribe();

  assert.deepEqual(emittedAt, [5000, 10000, 13000]);
});
