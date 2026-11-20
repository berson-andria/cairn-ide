import { Injectable, computed, inject } from '@angular/core';
import type { Signal } from '@angular/core';
import { NodeStore } from '../../core/store/node.store';
import { RunStore } from '../../core/store/run.store';
import { TaskStore } from '../../core/store/task.store';
import { NoticeManager } from '../../core/services/notification/notification.service';
import { handleApiError } from '../../core/services/tauri/api-error';
import { WorkApiService } from '../../core/services/tauri/work-api.service';
import type { RunRecord, WorkflowInfo, WorkflowInspect } from '../../shared/models/agent.model';
import type { TaskItem } from '../tasks/task.service';
import { WorkflowService } from './workflow.service';

export type RunResult =
  | { kind: 'started'; run: RunRecord }
  | { kind: 'trust-required'; workflow: WorkflowInspect };

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
    if (!workflows.some(item => item.name === selectedWorkflow)) {
      return 'Workflow not found.';
    }
    return null;
  }

  private selectWorkflow(workflow: string | undefined, workflows: WorkflowInfo[]): string | undefined {
    if (workflow !== undefined) return workflow;
    if (workflows.some(item => item.name === 'default')) return 'default';
    return workflows.length === 1 ? workflows[0].name : undefined;
  }

  async run(taskId: string, workflow?: string): Promise<RunResult | undefined> {
    const task = this.tasks.records()[taskId];
    if (!task) {
      await handleApiError({ code: 'NotFound', message: `Task ${taskId} was not found.` }, this.notices);
      return undefined;
    }
    const workflowName = this.selectWorkflow(workflow, this.workflows.workflows());
    if (workflowName === undefined || this.runDisabledReason(task, workflow) !== null) return undefined;
    try {
      const run = await this.api.runStart(taskId, task.rev, workflowName);
      return { kind: 'started', run };
    } catch (error) {
      if ((error as { code?: string })?.code === 'TrustRequired') {
        const inspection = await this.workflows.inspect(workflowName);
        return inspection ? { kind: 'trust-required', workflow: inspection } : undefined;
      }
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async trustAndRun(taskId: string, workflowName: string, hash: string): Promise<RunResult | undefined> {
    try {
      await this.api.workflowTrust(workflowName, hash);
    } catch (error) {
      await handleApiError(error, this.notices);
      return undefined;
    }
    return this.run(taskId, workflowName);
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
