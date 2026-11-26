import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { TaskService, type TaskItem } from '../task.service';
import { LayoutService } from '../../../core/services/layout.service';
import { AutoExpandDirective } from '../../../shared/directives/auto-expand';

@Component({
  selector: 'app-new-task',
  standalone: true,
  templateUrl: './new-task.html',
  styleUrl: './new-task.scss',
  imports: [AutoExpandDirective],
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
  readonly anchorPath = signal<string[]>([]);
  readonly acceptanceCriteria = signal('');
  readonly branch = signal('');
  readonly showOptions = signal(false);
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
    const selected = await this.layout.openAnchor({ kind: 'task' });
    if (selected?.kind === 'file') this.anchorPath.update((v) => [...v, selected.path]);
  }

  async createTask(): Promise<void> {
    const title = this.title().trim();
    if (!title) return;
    const task = await this.taskService.add({
      title,
      description: this.description().trim() || undefined,
      dependsOn: this.dependsOn() || undefined,
      // TODO(slice B): support multiple anchors in NewTask
      anchors: this.anchorPath()
        ? this.anchorPath().map((path) => ({ kind: 'file', path: path }))
        : undefined,
      subTasks: this.subtasks().map((subtaskTitle) => ({ title: subtaskTitle })),
      acceptanceCriteria: this.acceptanceCriteria().trim() || undefined,
      branch: this.branch().trim() || undefined,
    });
    if (!task) return;
    this.taskService.select(task.id);
    this.dialogRef?.close(task);
  }

  cancel(): void {
    this.dialogRef?.close();
  }
}
