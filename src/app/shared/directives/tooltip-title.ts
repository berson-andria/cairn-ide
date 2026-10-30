import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  ComponentRef,
  DestroyRef,
  Directive,
  ElementRef,
  EnvironmentInjector,
  ViewEncapsulation,
  createComponent,
  effect,
  inject,
  input,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

let nextId = 0;

@Component({
  selector: 'app-tooltip',
  template: '{{ text() }}',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { class: 'app-tooltip', role: 'tooltip', '[id]': 'id()' },
})
export class TooltipContent {
  readonly text = input('');
  readonly id = input('');
}

@Directive({
  selector: '[appTooltip]',
  host: {
    '(mouseenter)': 'show()',
    '(mouseleave)': 'hide()',
    '(focusin)': 'show()',
    '(focusout)': 'hide()',
    '(keydown.escape)': 'hide(true)',
    '[attr.aria-describedby]': 'tooltipRef ? tooltipId : null',
  },
})
export class TooltipTitle {
  readonly appTooltip = input<string | null | undefined>('');
  readonly tooltipPosition = input<TooltipPosition>('top');
  readonly tooltipDelay = input(300);
  readonly tooltipClass = input('');
  readonly tooltipDisabled = input(false);

  protected readonly tooltipId = `app-tooltip-${nextId++}`;
  protected tooltipRef: ComponentRef<TooltipContent> | null = null;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly doc = inject(DOCUMENT);
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private showTimer?: ReturnType<typeof setTimeout>;
  private hideTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Keep a visible tooltip in sync with text changes
    effect(() => {
      const text = this.appTooltip();
      if (!this.tooltipRef) return;
      if (!text) return this.hide(true);
      this.tooltipRef.setInput('text', text);
      this.tooltipRef.changeDetectorRef.detectChanges();
      this.updatePosition();
    });

    inject(DestroyRef).onDestroy(() => this.hide(true));
  }

  protected show() {
    clearTimeout(this.hideTimer);
    if (this.tooltipRef || this.tooltipDisabled() || !this.appTooltip()) return;

    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => this.create(), this.tooltipDelay());
  }

  protected hide(immediate = false) {
    clearTimeout(this.showTimer);
    const ref = this.tooltipRef;
    if (!ref) return;

    const el = ref.location.nativeElement as HTMLElement;
    el.classList.remove('visible');

    const destroy = () => {
      ref.destroy();
      if (this.tooltipRef === ref) this.tooltipRef = null;
    };

    if (immediate) {
      destroy();
    } else {
      this.hideTimer = setTimeout(destroy, 150); // matches CSS transition
    }
  }

  private create() {
    const ref = createComponent(TooltipContent, { environmentInjector: this.injector });
    ref.setInput('text', this.appTooltip() ?? '');
    ref.setInput('id', this.tooltipId);
    this.appRef.attachView(ref.hostView);

    const el = ref.location.nativeElement as HTMLElement;
    const extra = this.tooltipClass().split(' ').filter(Boolean);
    el.classList.add(...extra);
    this.doc.body.appendChild(el);

    this.tooltipRef = ref;
    ref.changeDetectorRef.detectChanges();
    this.updatePosition();
    requestAnimationFrame(() => el.classList.add('visible'));
  }

  private updatePosition() {
    if (!this.tooltipRef) return;
    const tip = this.tooltipRef.location.nativeElement as HTMLElement;
    const hostRect = this.host.nativeElement.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const gap = 8;
    const vw = this.doc.documentElement.clientWidth;
    const vh = this.doc.documentElement.clientHeight;

    let pos = this.tooltipPosition();

    // Flip if there's no room
    if (pos === 'top' && hostRect.top - tipRect.height - gap < 0) pos = 'bottom';
    else if (pos === 'bottom' && hostRect.bottom + tipRect.height + gap > vh) pos = 'top';
    else if (pos === 'left' && hostRect.left - tipRect.width - gap < 0) pos = 'right';
    else if (pos === 'right' && hostRect.right + tipRect.width + gap > vw) pos = 'left';

    let top = 0;
    let left = 0;
    switch (pos) {
      case 'top':
        top = hostRect.top - tipRect.height - gap;
        left = hostRect.left + (hostRect.width - tipRect.width) / 2;
        break;
      case 'bottom':
        top = hostRect.bottom + gap;
        left = hostRect.left + (hostRect.width - tipRect.width) / 2;
        break;
      case 'left':
        top = hostRect.top + (hostRect.height - tipRect.height) / 2;
        left = hostRect.left - tipRect.width - gap;
        break;
      case 'right':
        top = hostRect.top + (hostRect.height - tipRect.height) / 2;
        left = hostRect.right + gap;
        break;
    }

    // Clamp to viewport
    left = Math.max(4, Math.min(left, vw - tipRect.width - 4));
    top = Math.max(4, Math.min(top, vh - tipRect.height - 4));

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tip.dataset['position'] = pos;
  }
}
