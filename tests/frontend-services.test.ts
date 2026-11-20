import '@angular/compiler';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { RunStore } from '../src/app/core/store/run.store';
import { TaskStore } from '../src/app/core/store/task.store';
import { NodeStore } from '../src/app/core/store/node.store';
import { NoticeManager } from '../src/app/core/services/notification/notification.service';
import { WorkApiService } from '../src/app/core/services/tauri/work-api.service';
import { refreshFinishedRun } from '../src/app/core/services/tauri/work-sync.service';
import { ProposalNotifier } from '../src/app/feature/proposals/proposal-notifier.service';
import { RunService } from '../src/app/feature/runs/run.service';
import { WorkflowService } from '../src/app/feature/runs/workflow.service';
import { TaskService, type TaskItem, type TaskStatus } from '../src/app/feature/tasks/task.service';
import type { Proposal, RunRecord, RunState, WorkflowInfo } from '../src/app/shared/models/agent.model';

const task = (id: string, status: TaskStatus = 'ready', dependsOn?: string): TaskItem => ({
  id,
  title: id,
  status,
  createdAt: 1,
  schemaVersion: 1,
  rev: 1,
  ...(dependsOn ? { dependsOn } : {}),
});

const workflow = (name: string): WorkflowInfo => ({ name, source: 'project', trusted: true });

function makeHarness(options: {
  tasks?: TaskItem[];
  current?: RunState | null;
  rootPath?: string | null;
  workflows?: WorkflowInfo[];
  runStore?: Pick<RunStore, 'current' | 'logLines' | 'refresh'>;
  api?: Partial<WorkApiService>;
} = {}) {
  const taskStore = new TaskStore();
  taskStore.replace(options.tasks ?? [task('task-1')], []);
  const runStore = options.runStore ?? {
    current: signal(options.current ?? null).asReadonly(),
    logLines: () => signal<string[]>([]).asReadonly(),
    refresh: async () => {},
  };
  const api = {
    runStart: async () => ({} as RunRecord),
    ...options.api,
  };
  const workflows = {
    workflows: signal(options.workflows ?? [workflow('default')]).asReadonly(),
    inspect: async () => undefined,
  };
  const injector = Injector.create({
    providers: [
      { provide: WorkApiService, useValue: api },
      { provide: RunStore, useValue: runStore },
      { provide: TaskStore, useValue: taskStore },
      { provide: NodeStore, useValue: { rootPath: signal(options.rootPath === undefined ? '/project' : options.rootPath) } },
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

  const handStarted = makeHarness({ tasks: [task('task-1', 'running')] })
    .taskService.availableActions(task('task-1', 'running'));
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
    api: { runCancel: async () => { cancelCalls++; } },
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
  const storeInjector = Injector.create({ providers: [{ provide: WorkApiService, useValue: api }] });
  const runStore = runInInjectionContext(storeInjector, () => new RunStore());
  runStore.started({ runId: 'run-1', taskId: 'task-1', workflow: 'default' });
  const harness = makeHarness({ runStore, api });

  const refresh = refreshFinishedRun(
    { runId: 'run-1', taskId: 'task-1', outcome: 'needs_review' },
    runStore,
    harness.runService,
  );
  assert.equal(runStore.current()?.startedAt, undefined);
  assert.equal(runStore.current()?.summary, undefined);
  await refresh;

  assert.equal(runGetCalls, 1);
  assert.equal(runStore.current()?.startedAt, fullRun.startedAt);
  assert.equal(runStore.current()?.endedAt, fullRun.endedAt);
  assert.equal(runStore.current()?.summary, fullRun.summary);
});

test('runDisabledReason reports project, task, run, dependency, and workflow blockers', () => {
  const noProject = makeHarness({ rootPath: null }).runService;
  assert.equal(noProject.runDisabledReason(task('task-1')), 'Open a project before starting a workflow.');

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
  assert.equal(dependency.runDisabledReason(task('task-1', 'ready', 'dependency')), 'Complete the dependency first.');

  const noWorkflows = makeHarness({ workflows: [] }).runService;
  assert.equal(noWorkflows.runDisabledReason(task('task-1')), 'No workflows are available.');

  const multiple = makeHarness({ workflows: [workflow('one'), workflow('two')] }).runService;
  assert.equal(multiple.runDisabledReason(task('task-1')), 'Choose a workflow.');
  assert.equal(multiple.runDisabledReason(task('task-1'), 'missing'), 'Workflow not found.');
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

test('proposal notifier emits on quiet time or the five-second maximum wait', t => {
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
