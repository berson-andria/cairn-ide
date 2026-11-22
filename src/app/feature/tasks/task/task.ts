import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucidePlay,
  lucideReply,
  lucideRotateCcw,
  lucideShieldClose,
  lucideSquare,
  lucideTrash,
} from '@ng-icons/lucide';
import { TaskService, type TaskItem, type TaskStatus } from '../task.service';
import { RunService } from '../../../core/services/runs/run.service';
import { WorkflowService } from '../../../core/services/runs/workflow.service';

@Component({
  selector: 'app-task',
  templateUrl: './task.html',
  styleUrl: './task.scss',
  imports: [NgIcon],
  providers: [
    provideIcons({
      lucideTrash,
      lucidePlay,
      lucideReply,
      lucideRotateCcw,
      lucideSquare,
      lucideShieldClose,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Task {
  private readonly taskService = inject(TaskService);
  readonly workflow = inject(WorkflowService);

  readonly task = input.required<TaskItem>();
  readonly selected = input(false);
  readonly taskSelected = output<TaskItem>();

  deleteTask(event: MouseEvent): void {
    event.stopPropagation();
    this.taskService.delete(this.task().id);
  }

  runTask(event: MouseEvent) {
    event.stopPropagation();
    this.taskService.perform(this.task(), 'run');
  }

  canceltask(event: MouseEvent) {
    event.stopPropagation();
    this.taskService.perform(this.task(), 'cancelRun');
  }

  rerunTask(event: MouseEvent) {
    event.stopPropagation();
    this.taskService.perform(this.task(), 'retry');
  }

  statusLabel(status: TaskStatus): string {
    return status === 'completed'
      ? 'Done'
      : status === 'ready'
        ? 'Ready'
        : status[0].toUpperCase() + status.slice(1);
  }
}
