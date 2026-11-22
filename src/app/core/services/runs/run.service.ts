import { Injectable, computed, inject } from '@angular/core';
import type { Signal } from '@angular/core';
import { WorkflowService } from './workflow.service';
import { RunRecord, WorkflowInfo } from '../../../shared/models/agent.model';
import { TaskItem } from '../../../feature/tasks/task.service';
import { NodeStore } from '../../store/node.store';
import { RunStore } from '../../store/run.store';
import { TaskStore } from '../../store/task.store';
import { NoticeManager } from '../notification/notification.service';
import { handleApiError } from '../tauri/api-error';
import { WorkApiService } from '../tauri/work-api.service';

export type RunResult =
  | { kind: 'started'; run: RunRecord }
  | { kind: 'trust-required' };

@Injectable({ providedIn: 'root' })
export class RunService {
  private readonly api = inject(WorkApiService);
  private readonly store = inject(RunStore);
  private readonly tasks = inject(TaskStore);
  private readonly nodes = inject(NodeStore);
  private readonly workflows = inject(WorkflowService);
  private readonly notices = inject(NoticeManager);

  readonly current = this.store.current;
  readonly isRunning = computed(() => {
    const current = this.current();
    if (!current || current.endedAt || current.outcome) return false;
    const task = this.tasks.records()[current.taskId];
    return !task || task.status === 'running';
  });

  logLines(runId: string): Signal<string[]> {
    return this.store.logLines(runId);
  }

  attemptCount(task: TaskItem): number {
    return task.runs?.length ?? 0;
  }

  lastRunId(task: TaskItem): string | undefined {
    return task.runs?.[task.runs.length - 1];
  }

  resumeInfo(task: TaskItem): { attempt: number; done: number; total: number; pending: number } {
    const subtasks = task.subTasks ?? [];
    const done = subtasks.filter((subtask) =>
      subtask.status === 'needs_review' || subtask.status === 'completed'
    ).length;
    return {
      attempt: this.attemptCount(task),
      done,
      total: subtasks.length,
      pending: subtasks.length - done,
    };
  }

  async loadRunsFor(task: TaskItem, limit = 5): Promise<RunRecord[]> {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    if (count === 0) return [];
    const runIds = [...new Set((task.runs ?? []).slice(-count).reverse())];
    const records: RunRecord[] = [];

    for (const runId of runIds) {
      const cached = this.store.record(runId)();
      if (cached) {
        records.push(cached);
        continue;
      }

      try {
        const record = await this.api.runGet(runId);
        if (record) {
          this.store.setRecord(record);
          records.push(record);
        }
      } catch (error) {
        if ((error as { code?: string })?.code !== 'NotFound') {
          await handleApiError(error, this.notices);
        }
      }
    }

    return records;
  }

  canRun(task: TaskItem, workflow?: string): boolean {
    return this.runDisabledReason(task, workflow) === null;
  }

  runDisabledReason(task: TaskItem, workflow?: string): string | null {
    if (!this.nodes.rootPath()) return 'Open a project before starting a workflow.';
    if (task.status !== 'ready') return 'Task is not ready.';
    if (this.isRunning()) return 'Another workflow is running.';
    const dependency = task.dependsOn ? this.tasks.records()[task.dependsOn] : undefined;
    if (task.dependsOn && dependency?.status !== 'completed') {
      return 'Complete the dependency first.';
    }

    const workflows = this.workflows.workflows();
    if (workflows.length === 0) return 'No workflows are available.';

    const selectedWorkflow = this.selectWorkflow(workflow, workflows);
    if (selectedWorkflow === undefined) return 'Choose a workflow.';
    const selected = workflows.find((item) => item.name === selectedWorkflow);
    if (!selected) {
      return 'Workflow not found.';
    }
    if (selected.source === 'project') {
      const trustState = this.workflows.trustState?.() ??
        (this.workflows.needsTrustReview() ? 'unreviewed' : null);
      if (trustState === 'unreviewed') {
        return "Workflows in this project haven't been reviewed; review them in Settings";
      }
      if (trustState === 'changed') {
        return "Workflows changed since you approved them; review the changes in Settings";
      }
    }
    return null;
  }

  private selectWorkflow(
    workflow: string | undefined,
    workflows: WorkflowInfo[],
  ): string | undefined {
    if (workflow !== undefined) return workflow;
    if (workflows.some((item) => item.name === 'default')) return 'default';
    return workflows.length === 1 ? workflows[0].name : undefined;
  }

  async run(taskId: string, workflow?: string): Promise<RunResult | undefined> {
    const task = this.tasks.records()[taskId];
    if (!task) {
      await handleApiError(
        { code: 'NotFound', message: `Task ${taskId} was not found.` },
        this.notices,
      );
      return undefined;
    }
    const workflowName = this.selectWorkflow(workflow, this.workflows.workflows());
    if (workflowName === undefined || this.runDisabledReason(task, workflow) !== null)
      return undefined;
    try {
      const run = await this.api.runStart(taskId, task.rev, workflowName);
      return { kind: 'started', run };
    } catch (error) {
      if ((error as { code?: string })?.code === 'TrustRequired') {
        return { kind: 'trust-required' };
      }
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.api.runCancel();
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.store.refresh();
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async loadHistory(limit: number): Promise<RunRecord[] | undefined> {
    try {
      const history = await this.api.runList(limit);
      this.store.setHistory(history);
      return history;
    } catch (error) {
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async loadLog(runId: string, maxLines: number): Promise<string[] | undefined> {
    try {
      const lines = await this.api.runLog(runId, maxLines);
      this.store.setLog(runId, lines);
      return lines;
    } catch (error) {
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  clear(): void {
    this.store.clear();
  }
}
