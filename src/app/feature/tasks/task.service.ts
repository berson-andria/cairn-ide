import { Injectable, computed, inject, signal } from '@angular/core';
import { TaskStore } from '../../core/store/task.store';
import { WorkApiService, type ApiError } from '../../core/services/tauri/work-api.service';
import { handleApiError as reportApiError } from '../../core/services/tauri/api-error';
import { NoticeManager } from '../../core/services/notification/notification.service';
import { RunService, RunResult } from '../../core/services/runs/run.service';

export type TaskStatus = 'ready' | 'running' | 'blocked' | 'needs_review' | 'completed' | 'failed';
export interface TaskAnchor {
  kind: 'file' | 'function' | 'ast';
  path: string;
  label?: string;
  lineNumber?: number;
}
export interface SubTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt?: number;
}
export interface NewSubTask {
  title: string;
  description?: string;
}
export interface SubTaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
}
export interface NewTask {
  title: string;
  description?: string | null;
  anchor?: TaskAnchor | null;
  linkedNoteIds?: string[] | null;
  subTasks?: NewSubTask[] | null;
  dependsOn?: string | null;
  acceptanceCriteria?: string | null;
  branch?: string | null;
}
export interface TaskPatch {
  title?: string;
  description?: string | null;
}
export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  anchor?: TaskAnchor;
  linkedNoteIds?: string[];
  subTasks?: SubTask[];
  dependsOn?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt?: number;
  acceptanceCriteria?: string;
  branch?: string;
  runs?: string[];
  schemaVersion: number;
  rev: number;
}

export type TaskAction =
  | 'start'
  | 'run'
  | 'resume'
  | 'cancelRun'
  | 'complete'
  | 'sendBack'
  | 'retry'
  | 'reopen';
export interface AvailableTaskAction {
  action: TaskAction;
  enabled: boolean;
  reason?: string;
  hint?: string;
}

export interface SubtaskProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
  pending: number;
  percent: number;
}

@Injectable({ providedIn: 'root' })
export class TaskService {
  private readonly store = inject(TaskStore);
  private readonly api = inject(WorkApiService);
  private readonly notices = inject(NoticeManager);
  private readonly runService = inject(RunService);
  readonly records = this.store.records;
  readonly errors = this.store.errors;
  readonly loaded = this.store.loaded;
  readonly tasks = computed(() => Object.values(this.records()));
  readonly selectedTaskId = signal<string | null>(null);
  readonly selectedTask = computed(() => this.get(this.selectedTaskId() ?? ''));
  readonly readyTasks = computed(() => this.tasks().filter((t) => t.status === 'ready'));
  readonly runningTasks = computed(() => this.tasks().filter((t) => t.status === 'running'));
  readonly blockedTasks = computed(() => this.tasks().filter((t) => t.status === 'blocked'));
  readonly completedTasks = computed(() => this.tasks().filter((t) => t.status === 'completed'));
  readonly needsReviewTasks = computed(() =>
    this.tasks().filter((t) => t.status === 'needs_review'),
  );
  readonly failedTasks = computed(() => this.tasks().filter((t) => t.status === 'failed'));
  readonly availableTasks = computed(() =>
    this.tasks().filter(
      (t) =>
        t.status !== 'completed' && (!t.dependsOn || this.get(t.dependsOn)?.status === 'completed'),
    ),
  );
  private refreshPromise?: Promise<void>;
  refresh(): Promise<void> {
    return (this.refreshPromise ??= this.api
      .taskList()
      .then((r) => this.store.replace(r.records, r.errors))
      .catch((e) => this.handleApiError(e as ApiError))
      .finally(() => (this.refreshPromise = undefined)));
  }
  get(id: string): TaskItem | undefined {
    return this.records()[id];
  }
  select(id: string | null): void {
    this.selectedTaskId.set(id && this.get(id) ? id : null);
  }
  canStart(id: string): boolean {
    const t = this.get(id);
    return (
      !!t && t.status === 'ready' && (!t.dependsOn || this.get(t.dependsOn)?.status === 'completed')
    );
  }
  subtaskProgress(task: TaskItem): SubtaskProgress {
    const subtasks = task.subTasks ?? [];
    const total = subtasks.length;
    const done = subtasks.filter((subtask) =>
      subtask.status === 'needs_review' || subtask.status === 'completed'
    ).length;
    const running = subtasks.filter((subtask) => subtask.status === 'running').length;
    const failed = subtasks.filter((subtask) => subtask.status === 'failed').length;
    const pending = total - done - running - failed;
    return {
      total,
      done,
      running,
      failed,
      pending,
      percent: total === 0 ? 0 : Math.round(done * 100 / total),
    };
  }
  availableActions(task: TaskItem): AvailableTaskAction[] {
    const dependency = task.dependsOn ? this.get(task.dependsOn) : undefined;
    const dependencyReady = !task.dependsOn || dependency?.status === 'completed';
    const progress = this.subtaskProgress(task);
    const progressHint = progress.total > 0
      ? `${progress.done} of ${progress.total} steps done`
      : undefined;
    switch (task.status) {
      case 'ready':
        return [
          {
            action: 'start',
            enabled: dependencyReady,
            reason: dependencyReady ? undefined : 'Complete the dependency first.',
          },
          {
            action: 'run',
            enabled: this.runService.canRun(task),
            reason: this.runService.runDisabledReason(task) ?? undefined,
            ...(progressHint ? { hint: progressHint } : {}),
          },
        ];
      case 'running': {
        const currentRun = this.runService.current();
        const activeRunForTask = this.runService.isRunning() && currentRun?.taskId === task.id;
        return activeRunForTask
          ? [
              { action: 'cancelRun', enabled: true },
              {
                action: 'complete',
                enabled: false,
                reason: 'A workflow is running; cancel it first',
              },
            ]
          : [{ action: 'complete', enabled: true }];
      }
      case 'needs_review':
        return [
          { action: 'complete', enabled: true },
          { action: 'sendBack', enabled: true },
        ];
      case 'failed':
        {
          const resumeTask = { ...task, status: 'ready' as const };
          const canResume = progress.done > 0 &&
            progress.pending > 0 &&
            this.runService.runDisabledReason(resumeTask) === null;
          return canResume
            ? [
                { action: 'retry', enabled: true },
                { action: 'resume', enabled: true, ...(progressHint ? { hint: progressHint } : {}) },
              ]
            : [{ action: 'retry', enabled: true }];
        }
      case 'completed':
        return [{ action: 'reopen', enabled: true }];
      case 'blocked':
        return [];
    }
  }
  async perform(
    task: TaskItem,
    action: TaskAction,
  ): Promise<TaskItem | RunResult | void> {
    if (action === 'run') {
      if (!this.runService.canRun(task)) return;
    } else if (
      !this.availableActions(task).some((item) => item.action === action && item.enabled)
    ) {
      return;
    }
    switch (action) {
      case 'start':
        return this.start(task.id);
      case 'run':
        return this.runService.run(task.id);
      case 'resume': {
        const updated = await this.setStatus(task.id, 'ready');
        if (!updated) return;
        return this.runService.run(task.id);
      }
      case 'cancelRun':
        return this.runService.cancel();
      case 'complete':
        return this.complete(task.id);
      case 'sendBack':
      case 'retry':
      case 'reopen':
        return this.setStatus(task.id, 'ready');
    }
  }
  getDependentTasks(id: string): TaskItem[] {
    return this.tasks().filter((t) => t.dependsOn === id);
  }
  private async mutate(
    id: string,
    run: (rev: number) => Promise<TaskItem>,
  ): Promise<TaskItem | undefined> {
    const current = this.get(id);
    if (!current) return;
    try {
      const updated = await run(current.rev);
      this.store.upsert(updated);
      return updated;
    } catch (e) {
      await this.handleApiError(e as ApiError, id);
      return;
    }
  }
  private async handleApiError(error: ApiError, id?: string): Promise<void> {
    await reportApiError(
      error,
      this.notices,
      id ? async () => this.store.upsert(await this.api.taskGet(id)) : undefined,
    );
  }
  async add(data: NewTask): Promise<TaskItem | undefined> {
    try {
      return await this.api.taskCreate(data);
    } catch (e) {
      await this.handleApiError(e as ApiError);
      return;
    }
  }
  edit(id: string, patch: TaskPatch): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskUpdate(id, patch, rev));
  }
  async delete(id: string): Promise<void> {
    try {
      await this.api.taskDelete(id);
      if (this.selectedTaskId() === id) this.select(this.tasks()[0]?.id ?? null);
    } catch (e) {
      await this.handleApiError(e as ApiError, id);
    }
  }
  setStatus(id: string, status: TaskStatus): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskSetStatus(id, status, rev));
  }
  start(id: string): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskStart(id, rev));
  }
  complete(id: string): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskComplete(id, rev));
  }
  setAnchor(id: string, anchor: TaskAnchor | null): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskSetAnchor(id, anchor, rev));
  }
  addLinkedNote(id: string, noteId: string): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskLinkNote(id, noteId, rev));
  }
  removeLinkedNote(taskId: string, noteId: string): Promise<TaskItem | undefined> {
    return this.mutate(taskId, (rev) => this.api.taskUnlinkNote(taskId, noteId, rev));
  }
  setDependency(id: string, dependsOn: string | null): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskSetDependency(id, dependsOn, rev));
  }
  addSubTask(id: string, subtask: NewSubTask): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskAddSubtask(id, subtask, rev));
  }
  updateSubTask(id: string, subId: string, patch: SubTaskPatch): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskUpdateSubtask(id, subId, patch, rev));
  }
  deleteSubTask(id: string, subId: string): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskDeleteSubtask(id, subId, rev));
  }
  setAcceptanceCriteria(id: string, value: string | null): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskSetAcceptanceCriteria(id, value, rev));
  }
  setBranch(id: string, value: string | null): Promise<TaskItem | undefined> {
    return this.mutate(id, (rev) => this.api.taskSetBranch(id, value, rev));
  }
}
