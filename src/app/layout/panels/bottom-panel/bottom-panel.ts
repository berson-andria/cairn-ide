import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';
import { LayoutService } from '../../layout-service';

@Component({
  selector: 'bottom-panel',
  standalone: true,
  imports: [ResizeHandle],
  templateUrl: './bottom-panel.html',
  styleUrl: './bottom-panel.scss',
  host: { '[style.height.px]': 'height()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BottomPanel {
  protected readonly layoutService = inject(LayoutService);

  protected readonly height = signal<number | null>(null);
  protected readonly minHeight = 100;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly maxHeight = () => this.host.nativeElement.parentElement!.clientHeight * 0.7;
}
