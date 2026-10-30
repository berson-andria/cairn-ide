import { Injectable, Signal, signal } from '@angular/core';
import { TodoFile, TodoStatus, TodoSubtask, TodoTask } from './todo.model';

/** Owns todo state and is the single place where todo mutations happen. */
@Injectable({ providedIn: 'root' })
export class TodoService {
  private readonly _todos = signal<readonly TodoTask[]>([]);

  /** Consumers can read/react to tasks but cannot set the signal directly. */
  readonly todos: Signal<readonly TodoTask[]> = this._todos.asReadonly();

  addTask(title: string): TodoTask | undefined {
    const cleanTitle = title.trim();
    if (!cleanTitle) return undefined;

    const task: TodoTask = {
      id: this.createId(),
      title: cleanTitle,
      status: 'open',
      createdAt: new Date(),
      linkedFiles: [],
      subtasks: [],
    };
    this._todos.update((tasks) => [...tasks, task]);
    return task;
  }

  /** Replace state after loading it from storage or a project file. */
  setTasks(tasks: readonly TodoTask[]): void {
    this._todos.set(
      tasks.map((task) => ({
        ...task,
        createdAt: new Date(task.createdAt.getTime()),
        linkedFiles: [...task.linkedFiles],
        subtasks: task.subtasks.map((subtask) => ({ ...subtask })),
      })),
    );
  }

  updateTitle(taskId: string, title: string): void {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    this.updateTask(taskId, (task) => ({ ...task, title: cleanTitle }));
  }

  setStatus(taskId: string, status: TodoStatus): void {
    this.updateTask(taskId, (task) => ({ ...task, status }));
  }

  toggleDone(taskId: string): void {
    const task = this.findTask(taskId);
    if (task) this.setStatus(taskId, task.status === 'done' ? 'open' : 'done');
  }

  deleteTask(taskId: string): void {
    this._todos.update((tasks) => tasks.filter((task) => task.id !== taskId));
  }

  attachNote(taskId: string, noteId?: string): void {
    this.updateTask(taskId, (task) => {
      const updated = { ...task };
      if (noteId) updated.noteId = noteId;
      else delete updated.noteId;
      return updated;
    });
  }

  linkFile(taskId: string, file: TodoFile): void {
    const path = file.path.trim();
    if (!path) return;
    this.updateTask(taskId, (task) =>
      task.linkedFiles.some((item) => item.path === path)
        ? task
        : { ...task, linkedFiles: [...task.linkedFiles, { ...file, path }] },
    );
  }

  unlinkFile(taskId: string, path: string): void {
    this.updateTask(taskId, (task) => ({
      ...task,
      linkedFiles: task.linkedFiles.filter((file) => file.path !== path),
    }));
  }

  addSubtask(taskId: string, title: string): TodoSubtask | undefined {
    const cleanTitle = title.trim();
    if (!cleanTitle || !this.findTask(taskId)) return undefined;
    const subtask: TodoSubtask = { id: this.createId(), title: cleanTitle, status: 'open' };
    this.updateTask(taskId, (task) => ({ ...task, subtasks: [...task.subtasks, subtask] }));
    return subtask;
  }

  updateSubtaskTitle(taskId: string, subtaskId: string, title: string): void {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    this.updateTask(taskId, (task) => ({
      ...task,
      subtasks: task.subtasks.map((subtask) =>
        subtask.id === subtaskId ? { ...subtask, title: cleanTitle } : subtask,
      ),
    }));
  }

  setSubtaskStatus(taskId: string, subtaskId: string, status: TodoStatus): void {
    this.updateTask(taskId, (task) => ({
      ...task,
      subtasks: task.subtasks.map((subtask) =>
        subtask.id === subtaskId ? { ...subtask, status } : subtask,
      ),
    }));
  }

  deleteSubtask(taskId: string, subtaskId: string): void {
    this.updateTask(taskId, (task) => ({
      ...task,
      subtasks: task.subtasks.filter((subtask) => subtask.id !== subtaskId),
    }));
  }

  replaceSubtasks(taskId: string, subtasks: readonly TodoSubtask[]): void {
    this.updateTask(taskId, (task) => ({
      ...task,
      subtasks: subtasks.map((subtask) => ({ ...subtask })),
    }));
  }

  private findTask(taskId: string): TodoTask | undefined {
    return this._todos().find((task) => task.id === taskId);
  }

  private updateTask(taskId: string, update: (task: TodoTask) => TodoTask): void {
    this._todos.update((tasks) => tasks.map((task) => (task.id === taskId ? update(task) : task)));
  }

  private createId(): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `todo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    );
  }
}
