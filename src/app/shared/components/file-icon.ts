import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { getIconId, ItemType } from '../utils/icon-theme';

@Component({
  selector: 'file-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="file-icon" [attr.width]="size()" [attr.height]="size()" aria-hidden="true">
      <use [attr.href]="'#' + id()"></use>
    </svg>
  `,
})
export class FileIcon {
  name = input.required<string>();
  type = input.required<ItemType>();
  size = input(16);
  id = computed(() => getIconId(this.name(), this.type()));
}
