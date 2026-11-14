import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { LayoutService } from '../../../core/services/layout.service';
import { EmptyTaskList } from '../empty-task-list';
import { TaskService, TaskItem, TaskStatus } from '../task.service';
import { Task } from '../task/task';
import { TabStore } from '../../../core/store/tab.store';

@Component({
  selector: 'task-list',
  template: `
    <div
      class="rail-section"
      [class.rail-section--active]="layoutService.isRailSectionActive('Work')"
    >
      <div class="rail-section--header" (click)="layoutService.toggleRailSection('Work')">
        <span class="rail-section__title">
          @if (layoutService.isRailSectionActive('Work')) {
            <ng-icon name="bootstrapChevronDown" />
          } @else {
            <ng-icon name="bootstrapChevronRight" />
          }
          Work
        </span>
        <span class="rail-section__meta">{{ tasks().length }}</span>
      </div>
      <div class="rail__body">
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
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
})
export class TaskList {
  readonly layoutService = inject(LayoutService);
  private readonly taskService = inject(TaskService);
  private readonly tabStore = inject(TabStore);
  readonly tasks = this.taskService.tasks;
  readonly taskSelected = output<TaskItem>();
  readonly selectedTaskId = this.taskService.selectedTaskId;
  readonly statuses: TaskStatus[] = ['running', 'ready', 'blocked', 'completed'];
  readonly tasksByStatus = computed(() => {
    const groups: Record<TaskStatus, TaskItem[]> = {
      ready: [],
      running: [],
      blocked: [],
      completed: [],
    };
    for (const item of this.tasks()) groups[item.status].push(item);
    return groups;
  });

  select(task: TaskItem): void {
    this.taskService.select(task.id);
    this.tabStore.openTask(task.id, task.title, task.id);
    this.taskSelected.emit(task);
  }

  statusLabel(status: TaskStatus): string {
    return status === 'completed' ? 'Done' : status[0].toUpperCase() + status.slice(1);
  }
}
