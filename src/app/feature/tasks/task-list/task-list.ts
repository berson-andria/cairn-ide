import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';
import { LayoutService } from '../../../core/services/layout.service';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { EmptyTaskList } from '../empty-task-list';
import { TaskService, TaskItem, TaskStatus } from '../task.service';
import { Task } from '../task/task';
import { TabStore } from '../../../core/store/tab.store';
import { NewTask } from '../new/new-task';
import { NodeStore } from '../../../core/store/node.store';

@Component({
  selector: 'task-list',
  template: `
    <div
      class="rail-section"
      [class.rail-section--active]="layoutService.isRailSectionActive('Work')"
    >
      <div class="rail-section--header" (click)="layoutService.toggleRailSection('Work')">
        <span class="rail-section__title"> Tasks ● {{ tasks().length }}</span>
        @if (tasks().length > 0) {
          <button
            class="icon-btn"
            type="button"
            aria-label="Create new task"
            title="Create new task"
            (click)="$event.stopPropagation(); createTask()"
          >
            <ng-icon name="lucidePlus" />
          </button>
        }
      </div>
      <div class="rail__body">
        @if (!nodeStore.rootPath()) {
          <div class="empty-state__description">Open a folder to use tasks and notes</div>
        } @else {
          @if (taskService.errors().length) {
            <details class="muted">
              <summary>{{ taskService.errors().length }} files could not be loaded</summary>
              @for (error of taskService.errors(); track $index) {
                <div>{{ error.message }}</div>
              }
            </details>
          }
          @if (tasks().length === 0) {
            <empty-task-list />
          } @else {
            <div class="task-groups scrolling-el">
              @for (status of statuses; track status) {
                @let group = tasksByStatus()[status];
                @if (group.length) {
                  <div class="task-group-label">
                    <span>{{ statusLabel(status) }}</span
                    ><span>{{ group.length }}</span>
                  </div>
                  @for (item of group; track item.id) {
                    <app-task
                      [task]="item"
                      [selected]="selectedTaskId() === item.id"
                      (taskSelected)="select($event)"
                    />
                  }
                }
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      overflow: hidden;
    }
    .task-groups {
      flex: 1;
      min-height: 0;
    }
    .task-group-label {
      display: flex;
      justify-content: space-between;
      padding: var(--space-12) var(--space-14) var(--space-4);
      color: var(--color-text-muted);
      font-size: var(--font-size-label);
      letter-spacing: var(--letter-spacing-label);
      text-transform: uppercase;
    }
  `,
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Work")? 1: "none"' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, EmptyTaskList, Task],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight, lucidePlus })],
})
export class TaskList {
  readonly layoutService = inject(LayoutService);
  private readonly dialogService = inject(DialogService);
  readonly taskService = inject(TaskService);
  readonly nodeStore = inject(NodeStore);
  private readonly tabStore = inject(TabStore);
  readonly tasks = this.taskService.tasks;
  readonly taskSelected = output<TaskItem>();
  readonly selectedTaskId = this.taskService.selectedTaskId;
  readonly statuses: TaskStatus[] = [
    'running',
    'ready',
    'blocked',
    'needs_review',
    'failed',
    'completed',
  ];
  readonly tasksByStatus = computed(() => {
    const groups: Record<TaskStatus, TaskItem[]> = {
      ready: [],
      running: [],
      blocked: [],
      completed: [],
      needs_review: [],
      failed: [],
    };
    for (const item of this.tasks()) groups[item.status].push(item);
    return groups;
  });

  select(task: TaskItem): void {
    this.taskService.select(task.id);
    this.tabStore.openTask(task.id, task.title, task.id);
    this.taskSelected.emit(task);
  }

  createTask(): void {
    this.dialogService.open(NewTask, { width: 'min(92vw, 560px)' });
  }

  statusLabel(status: TaskStatus): string {
    return status === 'completed' ? 'Done' : status[0].toUpperCase() + status.slice(1);
  }
}
