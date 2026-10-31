import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { LayoutService } from '../../layout/layout-service';
import { EmptyTaskList } from './empty-task-list';

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
        <span class="rail-section__meta rail-section__meta--attention">2</span>
      </div>
      <div class="rail__body">
        <empty-task-list />
      </div>
    </div>
  `,
  styles: `
    :host {
      overflow: hidden;
    }
  `,
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Work")? 1: "none"' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, EmptyTaskList],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
})
export class TaskList {
  layoutService = inject(LayoutService);
}
