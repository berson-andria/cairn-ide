import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TaskService, type TaskItem } from '../task.service';
import { NoteService } from '../../notes/note.service';
import { LayoutService } from '../../../core/services/layout.service';

@Component({
  selector: 'app-task-view',
  templateUrl: './task-view.html',
  styleUrl: './task-view.scss',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskView {
  readonly taskInput = input<TaskItem | null>(null, { alias: 'task' });
  readonly taskId = input<string | undefined>();
  readonly taskService = inject(TaskService);
  private readonly noteService = inject(NoteService);
  private readonly layoutService = inject(LayoutService);
  readonly task = computed(() => {
    const id = this.taskId();
    return id
      ? (this.taskService.get(id) ?? null)
      : (this.taskInput() ?? this.taskService.selectedTask());
  });
  readonly editingDescription = signal(false);
  readonly canStart = computed(() => {
    const task = this.task();
    return !!task && this.taskService.canStart(task.id) && task.status !== 'running';
  });
  readonly linkedNotes = computed(() => {
    const ids = this.task()?.linkedNoteIds ?? [];
    return this.noteService.notes().filter((note) => ids.includes(note.id));
  });

  async updateTitle(title: string): Promise<void> {
    const task = this.task();
    if (task && title.trim()) await this.taskService.edit(task.id, { title: title.trim() });
  }

  async startTask(): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.start(task.id);
  }

  async setStatus(status: TaskItem['status']): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.setStatus(task.id, status);
  }

  async completeTask(): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.complete(task.id);
  }

  async updateDescription(description: string): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.edit(task.id, { description });
    this.editingDescription.set(false);
  }

  async attachLinkedItem(): Promise<void> {
    const task = this.task();
    if (!task) return;
    const selected = await this.layoutService.openComponent({ kind: 'task', id: task.id });
    if (!selected) return;
    if (selected.kind === 'file') {
      await this.taskService.setAnchor(task.id, { kind: 'file', path: selected.path });
    } else if (selected.kind === 'note') {
      await this.taskService.addLinkedNote(task.id, selected.id);
    }
  }

  statusLabel(status: TaskItem['status']): string {
    return status === 'completed'
      ? 'Done'
      : status === 'ready'
        ? 'Ready'
        : status[0].toUpperCase() + status.slice(1);
  }

  availabilityLabel(task: TaskItem): string {
    if (task.status === 'completed') return 'Completed';
    if (task.status === 'running') return 'Currently in progress';
    if (task.status === 'blocked') return 'Waiting on dependency';
    if (task.status === 'failed') {
    }
    return 'Ready to work';
  }
}
