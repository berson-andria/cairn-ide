import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';

@Component({
  selector: 'bottom-panel',
  standalone: true,
  imports: [ResizeHandle],
  templateUrl: './bottom-panel.html',
  styleUrl: './bottom-panel.scss',
  // null = no inline style, so the default (--bottom-panel-height token) applies.
  host: { '[style.height.px]': 'height()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BottomPanel {
  protected readonly height = signal<number | null>(null);
  protected readonly minHeight = 100;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** At most 70% of the main column, so the tabs and workspace never disappear. */
  protected readonly maxHeight = () => this.host.nativeElement.parentElement!.clientHeight * 0.7;
}
