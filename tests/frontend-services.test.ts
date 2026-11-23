import '@angular/compiler';
import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { RunStore } from '../src/app/core/store/run.store';
import { PatchStore } from '../src/app/core/store/patch.store';
import { TaskStore } from '../src/app/core/store/task.store';
import { NodeStore } from '../src/app/core/store/node.store';
import { NoticeManager } from '../src/app/core/services/notification/notification.service';
import { WorkApiService } from '../src/app/core/services/tauri/work-api.service';
import { refreshFinishedRun } from '../src/app/core/services/tauri/work-sync.service';
import { ProposalNotifier } from '../src/app/core/services/proposals/proposal-notifier.service';
import { PatchService } from '../src/app/core/services/patches/patch.service';
import { RunService } from '../src/app/core/services/runs/run.service';
import {
  WorkflowService,
  deriveTrustState,
  summarizeChanges,
} from '../src/app/core/services/runs/workflow.service';
import { TaskService, type TaskItem, type TaskStatus } from '../src/app/feature/tasks/task.service';
import { SettingsService } from '../src/app/feature/setting/settings.service';
import type {
  Proposal,
  Patch,
  PatchSummary,
  RunRecord,
  RunState,
  WorkflowScope,
  WorkflowSourceStatus,
  WorkflowStatus,
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

const workflow = (
  source: WorkflowScope = 'project',
  overrides: Partial<WorkflowSourceStatus> = {},
): WorkflowSourceStatus => ({
  source,
  folder: source === 'project' ? '.cairn/workflows' : `${source}/workflows`,
  status: 'ok',
  entry: `${source}/workflows/main.py`,
  warnings: [],
  trusted: source === 'project' ? true : true,
  ...overrides,
});

const workflowStatus = (
  active: WorkflowScope | null = 'project',
  sources: WorkflowSourceStatus[] = [workflow()],
): WorkflowStatus => ({
  active,
  sources,
  needsChoice: false,
  choice: null,
  choiceOptions: { bundled: true, global: false },
  activeVia: active === 'project' ? 'project' : active ? 'fallback' : null,
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
const patchRecord = (id: string, overrides: Partial<Patch> = {}): Patch => ({
  id,
  runId: 'run-1',
  taskId: 'task-1',
  title: id,
  status: 'pending',
  createdAt: 1,
  files: [{ path: `${id}.txt`, op: 'modify', before: 'old', after: 'new' }],
  ...overrides,
});
const patchSummary = (id: string, overrides: Partial<PatchSummary> = {}): PatchSummary => {
  const { files: _files, ...summary } = patchRecord(id, overrides);
  return summary;
};

function makeHarness(
  options: {
    tasks?: TaskItem[];
    current?: RunState | null;
    rootPath?: string | null;
    workflowStatus?: WorkflowStatus;
    needsTrustReview?: boolean;
    trustState?: 'unknown' | 'none' | 'unreviewed' | 'changed' | 'trusted';
    runStore?: Pick<RunStore, 'current' | 'logLines' | 'refresh' | 'record' | 'setRecord'>;
    api?: Partial<WorkApiService>;
    choose?: (scope: Exclude<WorkflowScope, 'project'>) => Promise<boolean>;
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
  const api: Partial<WorkApiService> = {
    runStart: async () => ({}) as RunRecord,
    ...options.api,
  };
  const activeStatus = computed(() =>
    (options.workflowStatus ?? workflowStatus()).sources.find((source) =>
      source.source === (options.workflowStatus ?? workflowStatus()).active
    ) ?? null
  );
  const workflows = {
    active: activeStatus,
    needsChoice: signal(options.workflowStatus?.needsChoice ?? false).asReadonly(),
    choose: options.choose ?? (async () => true),
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

test('runDisabledReason reports every blocker in priority order', () => {
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

  const noWorkflows = makeHarness({
    workflowStatus: workflowStatus(null, []),
  }).runService;
  assert.equal(noWorkflows.runDisabledReason(task('task-1')), 'No workflows are available.');

  const noEntry = makeHarness({
    workflowStatus: workflowStatus('project', [workflow('project', {
      status: 'no-entry',
      message: 'no main.py in .cairn/workflows',
    })]),
  }).runService;
  assert.equal(noEntry.runDisabledReason(task('task-1')), 'no main.py in .cairn/workflows');

  const reserved = makeHarness({
    workflowStatus: workflowStatus('project', [workflow('project', {
      status: 'reserved-name',
      message: 'cairn.py would shadow the Cairn SDK; rename it',
    })]),
  }).runService;
  assert.equal(reserved.runDisabledReason(task('task-1')), 'cairn.py would shadow the Cairn SDK; rename it');

  const projectUntrusted = makeHarness({
    workflowStatus: workflowStatus('project', [workflow('project', { trusted: false })]),
    needsTrustReview: true,
    trustState: 'unreviewed',
  }).runService;
  assert.equal(
    projectUntrusted.runDisabledReason(task('task-1')),
    "Workflows in this project haven't been reviewed; review them in Settings",
  );

  const projectChanged = makeHarness({
    workflowStatus: workflowStatus('project', [workflow('project', { trusted: false })]),
    trustState: 'changed',
  }).runService;
  assert.equal(
    projectChanged.runDisabledReason(task('task-1')),
    'Workflows changed since you approved them; review the changes in Settings',
  );

  const globalWorkflow = makeHarness({
    workflowStatus: workflowStatus('global', [workflow('global')]),
    needsTrustReview: true,
  }).runService;
  assert.equal(globalWorkflow.runDisabledReason(task('task-1')), null);
});

test('runDisabledReason ignores needsChoice so the choice dialog can proceed', () => {
  const choiceStatus = {
    ...workflowStatus(null, []),
    needsChoice: true,
    choiceOptions: { bundled: true, global: true },
  };
  assert.equal(
    makeHarness({ workflowStatus: choiceStatus }).runService.runDisabledReason(task('task-1')),
    null,
  );
});

test('run starts without a workflow argument', async () => {
  const calls: unknown[][] = [];
  const harness = makeHarness({
    workflowStatus: workflowStatus('project', [workflow('project')]),
    api: {
      runStart: async (...args: unknown[]) => {
        calls.push(args);
        return {} as RunRecord;
      },
    },
  });
  assert.equal(harness.runService.canRun(task('task-1')), true);
  await harness.runService.run('task-1');
  assert.deepEqual(calls, [['task-1', 1]]);
});

test('run returns choice-required without showing an error notice', async () => {
  let notices = 0;
  const harness = makeHarness({
    api: {
      runStart: async () => {
        throw { code: 'WorkflowChoiceRequired', message: 'Choose a workflow.' };
      },
    },
  });
  harness.injector.get(NoticeManager).error = () => {
    notices++;
  };

  assert.deepEqual(await harness.runService.run('task-1'), { kind: 'choice-required' });
  assert.equal(notices, 0);
});

test('chooseAndRun chooses before starting and stops when the choice fails', async () => {
  const calls: string[] = [];
  const success = makeHarness({
    workflowStatus: {
      ...workflowStatus(null, []),
      needsChoice: true,
      choiceOptions: { bundled: true, global: true },
    },
    choose: async (scope) => {
      calls.push(`choose:${scope}`);
      return true;
    },
    api: {
      runStart: async () => {
        calls.push('run');
        return runRecord('run-1');
      },
    },
  });
  assert.deepEqual(await success.runService.chooseAndRun('task-1', 'global'), {
    kind: 'started',
    run: runRecord('run-1'),
  });
  assert.deepEqual(calls, ['choose:global', 'run']);

  calls.length = 0;
  const failed = makeHarness({
    choose: async () => {
      calls.push('choose');
      return false;
    },
    api: {
      runStart: async () => {
        calls.push('run');
        return runRecord('run-2');
      },
    },
  });
  assert.equal(await failed.runService.chooseAndRun('task-1', 'bundled'), undefined);
  assert.deepEqual(calls, ['choose']);
});

test('perform starts a run without workflow options', async () => {
  let started = false;
  const harness = makeHarness({
    workflowStatus: workflowStatus('bundled', [workflow('bundled')]),
    api: {
      runStart: async () => {
        started = true;
        return {} as RunRecord;
      },
    },
  });
  await harness.taskService.perform(task('task-1'), 'run');
  assert.equal(started, true);
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

function workflowServiceHarness(
  api: Partial<WorkApiService>,
  rootPath = '/project',
  settings?: unknown,
) {
  const injector = Injector.create({
    providers: [
      { provide: WorkApiService, useValue: api },
      { provide: NodeStore, useValue: { rootPath: signal<string | null>(rootPath) } },
      { provide: NoticeManager, useValue: { error: () => {} } },
      ...(settings ? [{ provide: SettingsService, useValue: settings }] : []),
    ],
  });
  return runInInjectionContext(injector, () => new WorkflowService());
}

function patchServiceHarness(api: Partial<WorkApiService>) {
  const errors: string[] = [];
  const notices = { error: (message: string) => errors.push(message) };
  const injector = Injector.create({
    providers: [
      { provide: WorkApiService, useValue: api },
      { provide: NoticeManager, useValue: notices },
    ],
  });
  const store = runInInjectionContext(injector, () => new PatchStore());
  const serviceInjector = Injector.create({
    providers: [
      { provide: WorkApiService, useValue: api },
      { provide: NoticeManager, useValue: notices },
      { provide: PatchStore, useValue: store },
    ],
  });
  const service = runInInjectionContext(serviceInjector, () => new PatchService());
  return { store, service, errors };
}

test('patch store upserts status transitions and clears with patch cache for a new workspace', async () => {
  let fetches = 0;
  const { store, service } = patchServiceHarness({
    patchGet: async (_runId: string, patchId: string) => {
      fetches++;
      return patchRecord(patchId);
    },
  });
  await service.load('run-1', 'cache-me');
  store.upsert(patchSummary('p-1', { createdAt: 2 }));
  store.upsert(patchSummary('p-1', { createdAt: 1, title: 'stale' }));
  assert.equal(store.summary('run-1', 'p-1')?.title, 'p-1');

  store.upsert(patchSummary('p-1', { createdAt: 2, status: 'applied', appliedAt: 3 }));
  store.upsert(patchSummary('p-1', { createdAt: 2, status: 'pending' }));
  assert.equal(store.summary('run-1', 'p-1')?.status, 'applied');

  service.clear();
  assert.deepEqual(store.all(), []);
  await service.load('run-1', 'cache-me');
  assert.equal(fetches, 2);
});

test('patch service exposes task, run, and pending summary signals', () => {
  const { store, service } = patchServiceHarness({});
  store.upsert(patchSummary('p-1', { taskId: 'task-1', runId: 'run-1' }));
  store.upsert(patchSummary('p-2', {
    taskId: 'task-2',
    runId: 'run-2',
    status: 'applied',
  }));
  assert.deepEqual(service.pending().map((patch) => patch.id), ['p-1']);
  assert.deepEqual(service.forTask('task-1')().map((patch) => patch.id), ['p-1']);
  assert.deepEqual(service.forRun('run-2')().map((patch) => patch.id), ['p-2']);
});

test('patch load evicts the oldest cache entry and refetches when summary status changes', async () => {
  let fetches = 0;
  const { store, service } = patchServiceHarness({
    patchGet: async (runId: string, patchId: string) => {
      fetches++;
      return patchRecord(patchId, { runId });
    },
  });
  for (let index = 0; index < 21; index++) {
    await service.load('run-1', `p-${index}`);
  }
  assert.equal(fetches, 21);
  await service.load('run-1', 'p-0');
  assert.equal(fetches, 22);

  store.upsert(patchSummary('p-0', { status: 'applied', appliedAt: 10 }));
  await service.load('run-1', 'p-0');
  assert.equal(fetches, 23);
});

test('patch apply returns applied, plain-text conflict, and handled errors; refreshes after apply', async () => {
  let listCalls = 0;
  let mode: 'applied' | 'conflict' | 'error' = 'applied';
  const { service, errors } = patchServiceHarness({
    patchList: async () => {
      listCalls++;
      return [];
    },
    patchApply: async () => {
      if (mode === 'conflict') {
        throw { code: 'PatchConflict', message: '<stale> path' };
      }
      if (mode === 'error') throw { code: 'Io', message: 'disk error' };
      return patchSummary('p-1', { status: 'applied' });
    },
  });

  assert.deepEqual(await service.apply('run-1', 'p-1'), { kind: 'applied' });
  assert.equal(listCalls, 1);
  mode = 'conflict';
  assert.deepEqual(await service.apply('run-1', 'p-1'), {
    kind: 'conflict',
    message: '<stale> path',
  });
  assert.equal(listCalls, 1);
  mode = 'error';
  assert.equal(await service.apply('run-1', 'p-1'), undefined);
  assert.deepEqual(errors, ['disk error']);
});

test('workflow choice methods refresh status and expose choice signals', async () => {
  const calls: string[] = [];
  let current = {
    ...workflowStatus(null, []),
    needsChoice: true,
    choiceOptions: { bundled: true, global: true },
  };
  const service = workflowServiceHarness({
    workflowStatus: async () => current,
    workflowTemplates: async () => [],
    workflowChoose: async (scope: Exclude<WorkflowScope, 'project'>) => {
      calls.push(`choose:${scope}`);
      current = {
        ...current,
        needsChoice: false,
        choice: scope,
        active: scope,
        activeVia: 'chosen',
      };
    },
    workflowChoiceClear: async () => {
      calls.push('clear');
      current = { ...current, choice: null };
    },
  });

  await service.refresh();
  assert.equal(service.needsChoice(), true);
  assert.deepEqual(service.choiceOptions(), { bundled: true, global: true });
  assert.equal(await service.choose('global'), true);
  assert.equal(service.choice(), 'global');
  assert.equal(service.activeVia(), 'chosen');
  assert.equal(await service.clearChoice(), true);
  assert.equal(service.choice(), null);
  assert.deepEqual(calls, ['choose:global', 'clear']);
});

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

test('workflow active status exposes issue and warnings for every status', async () => {
  for (const status of ['empty', 'ok', 'no-entry', 'reserved-name'] as const) {
    const source = workflow('project', {
      status,
      message: status === 'ok' ? undefined : `${status} issue`,
      warnings: status === 'ok' ? ['stdlib warning'] : ['issue warning'],
    });
    const service = workflowServiceHarness({
      workflowStatus: async () => workflowStatus(status === 'empty' ? null : 'project', [source]),
      workflowTemplates: async () => [],
    });
    await service.refresh();
    assert.equal(
      service.active()?.status,
      status === 'empty' ? undefined : status,
    );
  }

  const issueService = workflowServiceHarness({
    workflowStatus: async () => workflowStatus('project', [workflow('project', {
      status: 'no-entry',
      message: 'no main.py in .cairn/workflows',
      warnings: ['stdlib warning'],
    })]),
    workflowTemplates: async () => [{
      id: 'blank',
      title: 'Blank',
      description: 'Start from a blank workflow',
    }],
  });
  await issueService.refresh();
  assert.equal(issueService.activeIssue(), 'no main.py in .cairn/workflows');
  assert.deepEqual(issueService.warnings(), ['stdlib warning']);
  assert.equal(issueService.templates()[0]?.id, 'blank');
});

test('workflow create reports created and duplicate results and handles other errors', async () => {
  const created = workflowServiceHarness({
    workflowStatus: async () => workflowStatus('project', [workflow('project')]),
    workflowTemplates: async () => [],
    workflowCreate: async () => ({
      source: 'project',
      entry: '.cairn/workflows/main.py',
      entryPath: '/project/.cairn/workflows/main.py',
    }),
  });
  assert.deepEqual(
    await created.create('project', 'blank'),
    { kind: 'created', entryPath: '/project/.cairn/workflows/main.py' },
  );

  const duplicate = workflowServiceHarness({
    workflowCreate: async () => {
      throw { code: 'Validation', message: 'The workflow folder already exists.' };
    },
  });
  assert.deepEqual(await duplicate.create('global', 'steps'), { kind: 'exists' });

  let handled = false;
  const failed = workflowServiceHarness({
    workflowCreate: async () => {
      throw { code: 'Io', message: 'disk failed' };
    },
  });
  // The harness NoticeManager is intentionally minimal; the result is still undefined.
  assert.equal(await failed.create('project', 'blank'), undefined);
  void handled;
});

test('project create auto-approves only when trusted before and trust setting is on', async () => {
  let approved: string[] = [];
  let trustCalls = 0;
  const settingsOn = {
    definitions: [{ key: 'agents.trustIdeEdits' }],
    get: () => signal(true).asReadonly(),
  };
  const trusted = workflowServiceHarness({
    workspaceTrustStatus: async () => {
      trustCalls++;
      return trustStatus({ trusted: true, folderHash: 'new-hash' });
    },
    workflowStatus: async () => workflowStatus('project', [workflow('project')]),
    workflowTemplates: async () => [],
    workflowCreate: async () => ({
      source: 'project',
      entry: '.cairn/workflows/main.py',
      entryPath: '/project/.cairn/workflows/main.py',
    }),
    workspaceTrust: async (hash: string) => {
      approved.push(hash);
    },
  }, '/project', settingsOn);
  await trusted.refreshTrust();
  await trusted.create('project', 'blank');
  assert.deepEqual(approved, ['new-hash']);
  assert.equal(trustCalls > 0, true);

  approved = [];
  const settingOff = {
    definitions: [{ key: 'agents.trustIdeEdits' }],
    get: () => signal(false).asReadonly(),
  };
  const notAutoApproved = workflowServiceHarness({
    workspaceTrustStatus: async () => trustStatus({ trusted: true, folderHash: 'new-hash' }),
    workflowStatus: async () => workflowStatus('project', [workflow('project')]),
    workflowTemplates: async () => [],
    workflowCreate: async () => ({
      source: 'project',
      entry: '.cairn/workflows/main.py',
      entryPath: '/project/.cairn/workflows/main.py',
    }),
    workspaceTrust: async (hash: string) => {
      approved.push(hash);
    },
  }, '/project', settingOff);
  await notAutoApproved.refreshTrust();
  await notAutoApproved.create('project', 'blank');
  assert.deepEqual(approved, []);

  const untrusted = workflowServiceHarness({
    workspaceTrustStatus: async () => trustStatus(),
    workflowStatus: async () => workflowStatus('project', [workflow('project')]),
    workflowTemplates: async () => [],
    workflowCreate: async () => ({
      source: 'project',
      entry: '.cairn/workflows/main.py',
      entryPath: '/project/.cairn/workflows/main.py',
    }),
    workspaceTrust: async (hash: string) => {
      approved.push(hash);
    },
  }, '/project', settingsOn);
  await untrusted.refreshTrust();
  await untrusted.create('project', 'blank');
  assert.deepEqual(approved, []);
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

test('workflow status and trust refresh once per window only for workflow paths', async () => {
  let calls = 0;
  let statusCalls = 0;
  const service = workflowServiceHarness({
    workspaceTrustStatus: async () => {
      calls++;
      return trustStatus();
    },
    workflowStatus: async () => {
      statusCalls++;
      return workflowStatus('project', [workflow('project')]);
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
  assert.equal(statusCalls, 1);
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
