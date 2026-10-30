import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';

@Component({
  selector: 'left-panel',
  standalone: true,
  imports: [ResizeHandle],
  templateUrl: './left-panel.html',
  styleUrl: './left-panel.scss',
  // null = no inline style, so the default (--left-panel-width token) applies.
  host: { '[style.width.px]': 'width()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeftPanel {
  protected readonly width = signal<number | null>(null);
  protected readonly minWidth = 200;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** At most half of the shell body. Re-evaluated on every drag move. */
  protected readonly maxWidth = () => this.host.nativeElement.parentElement!.clientWidth * 0.5;
}
