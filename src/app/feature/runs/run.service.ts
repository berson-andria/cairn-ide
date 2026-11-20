import { Injectable, computed, inject } from '@angular/core';
import type { Signal } from '@angular/core';
import { NodeStore } from '../../core/store/node.store';
import { RunStore } from '../../core/store/run.store';
import { TaskStore } from '../../core/store/task.store';
import { NoticeManager } from '../../core/services/notification/notification.service';
import { handleApiError } from '../../core/services/tauri/api-error';
import { WorkApiService } from '../../core/services/tauri/work-api.service';
import type { RunRecord, WorkflowInspect } from '../../shared/models/agent.model';
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
    return !!current && !current.endedAt && !current.outcome;
  });

  logLines(runId: string): Signal<string[]> {
    return this.store.logLines(runId);
  }

  canRun(task: TaskItem): boolean {
    const dependency = task.dependsOn ? this.tasks.records()[task.dependsOn] : undefined;
    return (
      task.status === 'ready' &&
      !this.isRunning() &&
      !!this.nodes.rootPath() &&
      (!task.dependsOn || dependency?.status === 'completed')
    );
  }

  async run(taskId: string, workflow?: string): Promise<RunResult | undefined> {
    const task = this.tasks.records()[taskId];
    if (!task) {
      await handleApiError({ code: 'NotFound', message: `Task ${taskId} was not found.` }, this.notices);
      return undefined;
    }
    try {
      const run = await this.api.runStart(taskId, task.rev, workflow);
      return { kind: 'started', run };
    } catch (error) {
      if ((error as { code?: string })?.code === 'TrustRequired') {
        const inspection = await this.workflows.inspect(workflow ?? 'default');
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
