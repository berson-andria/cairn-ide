import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * Drag handle that resizes the element it is placed in (its parent).
 *
 *   axis="x"  resizes WIDTH   (vertical bar,   cursor col-resize)
 *   axis="y"  resizes HEIGHT  (horizontal bar, cursor row-resize)
 *   edge      which edge of the panel the handle sits on. "end" = right/bottom,
 *             "start" = left/top. This decides the drag direction:
 *               left panel   -> axis x, edge end    (drag right = bigger)
 *               bottom panel -> axis y, edge start  (drag up    = bigger)
 *
 * It does not store anything: it measures the panel, clamps, and emits the new
 * size in px. The panel owns the value and binds it to its own width/height.
 * The parent must be position: relative (or absolute) and is where the handle
 * is anchored.
 */
@Component({
  selector: 'app-resize-handle',
  standalone: true,
  template: ``,
  styleUrl: './resize-handle.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    tabindex: '0',
    '[attr.aria-orientation]': `axis() === 'x' ? 'vertical' : 'horizontal'`,
    '[attr.aria-valuenow]': 'current()',
    '[class.handle--x]': `axis() === 'x'`,
    '[class.handle--y]': `axis() === 'y'`,
    '[class.handle--start]': `edge() === 'start'`,
    '[class.handle--end]': `edge() === 'end'`,
    '[class.is-dragging]': 'dragging()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'stop($event)',
    '(pointercancel)': 'stop($event)',
    '(keydown)': 'onKeyDown($event)',
  },
})
export class ResizeHandle {
  readonly axis = input.required<'x' | 'y'>();
  readonly edge = input.required<'start' | 'end'>();
  readonly min = input(0);
  /** A number, or a function evaluated on every move (so it can follow the window size). */
  readonly max = input<number | (() => number)>(Infinity);
  /** Keyboard step in px. */
  readonly step = input(16);

  readonly sizeChange = output<number>();

  protected readonly dragging = signal(false);
  protected readonly current = signal<number | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private startPointer = 0;
  private startSize = 0;

  /** +1 when growing means moving toward the end (right/down), -1 otherwise. */
  private get sign(): 1 | -1 {
    return this.edge() === 'end' ? 1 : -1;
  }

  private measure(): number {
    const rect = this.host.nativeElement.parentElement!.getBoundingClientRect();
    return this.axis() === 'x' ? rect.width : rect.height;
  }

  private clamp(value: number): number {
    const max = this.max();
    const limit = typeof max === 'function' ? max() : max;
    return Math.round(Math.min(Math.max(value, this.min()), limit));
  }

  private emit(size: number): void {
    const next = this.clamp(size);
    this.current.set(next);
    this.sizeChange.emit(next);
  }

  protected onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture keeps events flowing even when the pointer leaves the thin handle
    // or the window, and keeps the resize cursor for the whole drag.
    this.host.nativeElement.setPointerCapture(e.pointerId);
    this.startPointer = this.axis() === 'x' ? e.clientX : e.clientY;
    this.startSize = this.measure();
    this.dragging.set(true);
  }

  protected onPointerMove(e: PointerEvent): void {
    if (!this.dragging()) return;
    const pointer = this.axis() === 'x' ? e.clientX : e.clientY;
    this.emit(this.startSize + (pointer - this.startPointer) * this.sign);
  }

  protected stop(e: PointerEvent): void {
    if (!this.dragging()) return;
    this.dragging.set(false);
    this.host.nativeElement.releasePointerCapture(e.pointerId);
  }

  protected onKeyDown(e: KeyboardEvent): void {
    const [back, forward] =
      this.axis() === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const direction = e.key === forward ? 1 : -1;
    this.emit(this.measure() + direction * this.step() * this.sign);
  }
}
