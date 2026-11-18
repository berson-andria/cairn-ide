import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { getIconId, ItemType } from '../utils/icon-theme';

@Component({
  selector: 'file-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="file-icon" width="16px" height="16px" aria-hidden="true">
      <use [attr.href]="'#' + id()"></use>
    </svg>
  `,
})
export class FileIcon {
  name = input.required<string>();
  type = input.required<ItemType>();
  id = computed(() => getIconId(this.name(), this.type()));
}
