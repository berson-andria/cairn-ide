import { Directive, ElementRef, Input, OnChanges, Renderer2, SimpleChanges } from '@angular/core';

@Directive({
  selector: '[appBadge]',
  standalone: true,
})
export class BadgeDirective implements OnChanges {
  @Input('appBadge') badgeContent: string | number | null | undefined = '';

  //   @Input() badgeColor: string = '#4960f7';

  private badgeElement: HTMLElement | null = null;

  constructor(
    private el: ElementRef,
    private renderer: Renderer2,
  ) {
    this.renderer.setStyle(this.el.nativeElement, 'position', 'relative');
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['badgeContent'] || changes['badgeColor']) {
      this.updateBadge();
    }
  }

  private updateBadge(): void {
    if (
      this.badgeContent === null ||
      this.badgeContent === undefined ||
      this.badgeContent === '' ||
      this.badgeContent === 0
    ) {
      this.removeBadge();
      return;
    }

    if (!this.badgeElement) {
      this.badgeElement = this.renderer.createElement('span');
      this.renderer.addClass(this.badgeElement, 'custom-app-badge');
      this.renderer.appendChild(this.el.nativeElement, this.badgeElement);
    }

    this.renderer.setProperty(this.badgeElement, 'textContent', this.badgeContent.toString());
  }

  private removeBadge(): void {
    if (this.badgeElement) {
      this.renderer.removeChild(this.el.nativeElement, this.badgeElement);
      this.badgeElement = null;
    }
  }
}
