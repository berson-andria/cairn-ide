import { Injectable, computed, signal } from '@angular/core';

export type TaskStatus = 'ready' | 'running' | 'blocked' | 'completed';

export interface TaskAnchor {
  kind: 'file' | 'function' | 'ast';
  path: string; // file path
  label?: string; // function or AST symbol name
  lineNumber?: number; // optional line number for precise location
}

export interface SubTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt?: number;
}

export interface TaskItem {
  id: string; // UUID generated
  title: string;
  description?: string;
  anchor?: TaskAnchor;
  linkedNoteIds?: string[];
  subTasks?: SubTask[];
  dependsOn?: string; // task ID this task depends on
  status: TaskStatus;
  createdAt: number;
  updatedAt?: number;
  acceptanceCriteria?: string; // runnable check (test, lint, type check)
  branch?: string; // git branch if task is being worked on
}

@Injectable({
  providedIn: 'root',
})
export class TaskService {
  private readonly _tasks = signal<TaskItem[]>([]);

  /** Read-only signal access to all tasks */
  readonly tasks = this._tasks.asReadonly();

  /** The task currently shown by the task workspace. */
  readonly selectedTaskId = signal<string | null>(this._tasks()[0]?.id ?? null);
  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    return id ? (this.get(id) ?? null) : null;
  });

  select(id: string | null): void {
    this.selectedTaskId.set(id && this.get(id) ? id : null);
  }

  readonly readyTasks = computed(() => this._tasks().filter((t) => t.status === 'ready'));

  readonly runningTasks = computed(() => this._tasks().filter((t) => t.status === 'running'));

  readonly blockedTasks = computed(() => this._tasks().filter((t) => t.status === 'blocked'));

  readonly completedTasks = computed(() => this._tasks().filter((t) => t.status === 'completed'));

  /**
   * Tasks that have no dependencies or whose dependencies are completed
   */
  readonly availableTasks = computed(() =>
    this._tasks().filter((t) => {
      if (t.status === 'completed') return false;
      if (!t.dependsOn) return true;
      const dependency = this.get(t.dependsOn);
      return dependency?.status === 'completed';
    }),
  );

  /**
   * Get a single task by ID
   */
  get(id: string): TaskItem | undefined {
    return this._tasks().find((t) => t.id === id);
  }

  /**
   * Add a new task
   */
  add(data: {
    title: string;
    description?: string;
    anchor?: TaskAnchor;
    subTasks?: SubTask[];
    dependsOn?: string;
    status?: TaskStatus;
    acceptanceCriteria?: string;
    branch?: string;
  }): TaskItem {
    const newTask: TaskItem = {
      id: crypto.randomUUID(),
      title: data.title,
      description: data.description,
      anchor: data.anchor,
      subTasks: data.subTasks,
      dependsOn: data.dependsOn,
      status: this._computeInitialStatus(data.status, data.dependsOn),
      acceptanceCriteria: data.acceptanceCriteria,
      branch: data.branch,
      createdAt: Date.now(),
    };
    this._tasks.update((list) => [newTask, ...list]);
    return newTask;
  }

  /**
   * Edit an existing task
   */
  edit(id: string, updates: Partial<Omit<TaskItem, 'id' | 'createdAt'>>): void {
    this._tasks.update((list) =>
      list.map((task) => {
        if (task.id !== id) return task;

        const updated = { ...task, ...updates, updatedAt: Date.now() };

        // Auto-update status to blocked if dependsOn is set and not completed
        if (updates.dependsOn !== undefined) {
          const dep = this.get(updates.dependsOn);
          if (dep && dep.status !== 'completed') {
            updated.status = 'blocked';
          }
        }

        return updated;
      }),
    );
  }

  /**
   * Delete a task
   */
  delete(id: string): void {
    const wasSelected = this.selectedTaskId() === id;
    this._tasks.update((list) => list.filter((t) => t.id !== id));
    if (wasSelected) this.selectedTaskId.set(this._tasks()[0]?.id ?? null);
  }

  /**
   * Set task status
   */
  setStatus(id: string, status: TaskStatus): void {
    this.edit(id, { status });

    // Update dependent tasks when this task completes
    if (status === 'completed') {
      this._unblockDependentTasks(id);
    }
  }

  /**
   * Set task anchor
   */
  setAnchor(id: string, anchor: TaskAnchor | null): void {
    this.edit(id, { anchor: anchor ?? undefined });
  }

  addLinkedNote(id: string, noteId: string): void {
    const task = this.get(id);
    if (!task || task.linkedNoteIds?.includes(noteId)) return;
    this.edit(id, { linkedNoteIds: [...(task.linkedNoteIds ?? []), noteId] });
  }

  /**
   * Set task dependency
   */
  setDependency(id: string, dependsOn: string | null): void {
    const task = this.get(id);
    if (!task) return;

    this.edit(id, { dependsOn: dependsOn ?? undefined });

    // Update status based on dependency
    if (dependsOn) {
      const dep = this.get(dependsOn);
      if (dep && dep.status !== 'completed') {
        this.setStatus(id, 'blocked');
      }
    } else if (task.status === 'blocked') {
      // Unblock if dependency is removed
      this.setStatus(id, 'ready');
    }
  }

  /**
   * Add a subtask to an existing task
   */
  addSubTask(
    taskId: string,
    subTask: {
      title: string;
      description?: string;
      status?: TaskStatus;
    },
  ): SubTask | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;

    const newSubTask: SubTask = {
      id: crypto.randomUUID(),
      title: subTask.title,
      description: subTask.description,
      status: subTask.status ?? 'ready',
      createdAt: Date.now(),
    };

    const updatedSubTasks = [...(task.subTasks ?? []), newSubTask];
    this.edit(taskId, { subTasks: updatedSubTasks });

    return newSubTask;
  }

  /**
   * Update a subtask
   */
  updateSubTask(
    taskId: string,
    subTaskId: string,
    updates: Partial<Omit<SubTask, 'id' | 'createdAt'>>,
  ): void {
    const task = this.get(taskId);
    if (!task?.subTasks) return;

    const updatedSubTasks = task.subTasks.map((st) =>
      st.id === subTaskId ? { ...st, ...updates, updatedAt: Date.now() } : st,
    );

    this.edit(taskId, { subTasks: updatedSubTasks });
  }

  /**
   * Delete a subtask
   */
  deleteSubTask(taskId: string, subTaskId: string): void {
    const task = this.get(taskId);
    if (!task?.subTasks) return;

    const updatedSubTasks = task.subTasks.filter((st) => st.id !== subTaskId);
    this.edit(taskId, { subTasks: updatedSubTasks });
  }

  /**
   * Get all tasks that depend on a specific task
   */
  getDependentTasks(taskId: string): TaskItem[] {
    return this._tasks().filter((t) => t.dependsOn === taskId);
  }

  /**
   * Check if a task can be started (ready or all dependencies completed)
   */
  canStart(id: string): boolean {
    const task = this.get(id);
    if (!task || task.status === 'completed') return false;

    if (!task.dependsOn) return true;

    const dep = this.get(task.dependsOn);
    return dep?.status === 'completed';
  }

  /**
   * Start a task (set to running if available)
   */
  start(id: string): boolean {
    if (!this.canStart(id)) return false;
    this.setStatus(id, 'running');
    return true;
  }

  /**
   * Complete a task
   */
  complete(id: string): void {
    this.setStatus(id, 'completed');
  }

  /**
   * Set acceptance criteria for a task
   */
  setAcceptanceCriteria(id: string, criteria: string | null): void {
    this.edit(id, { acceptanceCriteria: criteria ?? undefined });
  }

  /**
   * Set branch for a task
   */
  setBranch(id: string, branch: string | null): void {
    this.edit(id, { branch: branch ?? undefined });
  }

  /**
   * Private helper to compute initial status based on dependencies
   */
  private _computeInitialStatus(
    requestedStatus: TaskStatus | undefined,
    dependsOn: string | undefined,
  ): TaskStatus {
    if (requestedStatus) return requestedStatus;

    if (dependsOn) {
      const dep = this.get(dependsOn);
      return dep?.status === 'completed' ? 'ready' : 'blocked';
    }

    return 'ready';
  }

  /**
   * Private helper to unblock dependent tasks when a task completes
   */
  private _unblockDependentTasks(completedTaskId: string): void {
    const dependents = this.getDependentTasks(completedTaskId);
    dependents.forEach((task) => {
      if (task.status === 'blocked') {
        this.setStatus(task.id, 'ready');
      }
    });
  }
}
