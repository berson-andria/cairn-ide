import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { TaskService, type TaskItem } from '../task.service';
import { LayoutService } from '../../../core/services/layout.service';

@Component({
  selector: 'app-new-task',
  standalone: true,
  templateUrl: './new-task.html',
  styleUrl: './new-task.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewTask {
  readonly taskService = inject(TaskService);
  private readonly layout = inject(LayoutService);
  private readonly dialogRef = inject<DialogRef<TaskItem | undefined>>(DialogRef, {
    optional: true,
  });

  readonly title = signal('');
  readonly description = signal('');
  readonly subtasks = signal<string[]>([]);
  readonly subtaskDraft = signal('');
  readonly dependsOn = signal('');
  readonly anchorPath = signal('');
  readonly acceptanceCriteria = signal('');
  readonly branch = signal('');
  readonly showOptions = signal(true);
  readonly showSubtaskInput = signal(false);
  readonly tasks = this.taskService.tasks;

  addSubtask(): void {
    const value = this.subtaskDraft().trim();
    if (!value) return;
    this.subtasks.update((items) => [...items, value]);
    this.subtaskDraft.set('');
    this.showSubtaskInput.set(false);
  }

  removeSubtask(index: number): void {
    this.subtasks.update((items) => items.filter((_, itemIndex) => itemIndex !== index));
  }

  async attachAnchor(): Promise<void> {
    const selected = await this.layout.openComponent({ kind: 'file' });
    if (selected?.kind === 'file') this.anchorPath.set(selected.path);
  }

  createTask(): void {
    const title = this.title().trim();
    if (!title) return;
    const task = this.taskService.add({
      title,
      description: this.description().trim() || undefined,
      dependsOn: this.dependsOn() || undefined,
      anchor: this.anchorPath() ? { kind: 'file', path: this.anchorPath() } : undefined,
      subTasks: this.subtasks().map((subtaskTitle) => ({
        id: crypto.randomUUID(),
        title: subtaskTitle,
        status: 'ready',
        createdAt: Date.now(),
      })),
      acceptanceCriteria: this.acceptanceCriteria().trim() || undefined,
      branch: this.branch().trim() || undefined,
    });
    this.taskService.select(task.id);
    this.dialogRef?.close(task);
  }

  cancel(): void {
    this.dialogRef?.close();
  }
}
