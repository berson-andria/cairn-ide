import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucidePlay,
  lucideReply,
  lucideRotateCcw,
  lucideSquare,
  lucideTrash,
} from '@ng-icons/lucide';
import { TaskService, type TaskItem, type TaskStatus } from '../task.service';
import { RunService } from '../../../core/services/runs/run.service';

@Component({
  selector: 'app-task',
  templateUrl: './task.html',
  styleUrl: './task.scss',
  imports: [NgIcon],
  providers: [
    provideIcons({ lucideTrash, lucidePlay, lucideReply, lucideRotateCcw, lucideSquare }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Task {
  private readonly taskService = inject(TaskService);
  readonly task = input.required<TaskItem>();
  readonly selected = input(false);
  readonly taskSelected = output<TaskItem>();
  readonly runService = inject(RunService);

  deleteTask(event: MouseEvent): void {
    event.stopPropagation();
    this.taskService.delete(this.task().id);
  }

  runTask(event: MouseEvent) {
    event.stopPropagation();
    this.runService.run(this.task().id);
  }

  canceltask(event: MouseEvent) {
    event.stopPropagation();
    this.runService.cancel();
  }

  rerunTask(event: MouseEvent) {
    event.stopPropagation();
    this.taskService
      .setStatus(this.task().id, 'ready')
      .then((_) => this.runService.run(this.task().id));
  }

  statusLabel(status: TaskStatus): string {
    return status === 'completed'
      ? 'Done'
      : status === 'ready'
        ? 'Ready'
        : status[0].toUpperCase() + status.slice(1);
  }
}
