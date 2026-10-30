import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { LayoutService } from '../../layout/layout-service';

@Component({
  selector: 'review-list',
  template: `
    <div
      class="rail-section"
      [class.rail-section--active]="layoutService.isRailSectionActive('Review')"
    >
      <div class="rail-section--header" (click)="layoutService.toggleRailSection('Review')">
        <span class="rail-section__title">
          @if (layoutService.isRailSectionActive('Review')) {
            <ng-icon name="bootstrapChevronDown" />
          } @else {
            <ng-icon name="bootstrapChevronRight" />
          }
          Review
        </span>
        <span class="rail-section__meta rail-section__meta--attention">2</span>
      </div>
      <div class="rail__body"></div>
    </div>
  `,
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Review")? 1: "none"' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
})
export class ReviewList {
  layoutService = inject(LayoutService);
}
