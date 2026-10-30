import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { LayoutService } from '../../layout/layout-service';

@Component({
  selector: 'note-list',
  template: `
    <div
      class="rail-section"
      [class.rail-section--active]="layoutService.isRailSectionActive('Notes')"
    >
      <div class="rail-section--header" (click)="layoutService.toggleRailSection('Notes')">
        <span class="rail-section__title">
          @if (layoutService.isRailSectionActive('Notes')) {
            <ng-icon name="bootstrapChevronDown" />
          } @else {
            <ng-icon name="bootstrapChevronRight" />
          }
          Notes
        </span>
        <span class="rail-section__meta rail-section__meta--attention">2</span>
      </div>
      <div class="rail__body"></div>
    </div>
  `,
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Notes")? 1: "none"' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
})
export class NoteList {
  layoutService = inject(LayoutService);
}
