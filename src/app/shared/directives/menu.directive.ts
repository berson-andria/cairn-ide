import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  EmbeddedViewRef,
  Renderer2,
  TemplateRef,
  ViewContainerRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

export type MenuX = 'left' | 'right';
export type MenuY = 'top' | 'bottom' | 'center';
export type MenuPosition = readonly [x: MenuX, y: MenuY];

const PANEL_CLASS = 'app-menu-panel';
/** Open panel → its directive, so a child menu can be found from its panel. */
const openMenus = new Map<HTMLElement, MenuDirective>();
/** Child panel → the panel of the menu it was opened from. */
const parentPanels = new WeakMap<HTMLElement, HTMLElement>();

/** Space kept between the menu and the viewport edge (px). */
const VIEWPORT_MARGIN = 8;

/**
 * Turns any element into a menu trigger.
 *
 *   <button [appMenu]="menu" [menuPosition]="['right', 'bottom']">Open</button>
 *   <ng-template #menu> ... </ng-template>
 *
 * Position = [x, y]
 *  - y 'bottom' / 'top': the menu opens below / above the container.
 *      x 'left'  -> menu's left edge lines up with the container's left edge.
 *      x 'right' -> menu's right edge lines up with the container's right edge.
 *  - y 'center': the menu opens beside the container, vertically centred.
 *      x 'left'  -> menu sits on the left of the container.
 *      x 'right' -> menu sits on the right of the container.
 *
 * Position is a preference, not a rule: if the menu would leave the viewport,
 * it flips to the opposite side on the same axis (left<->right, top<->bottom),
 * as long as the opposite side actually fits.
 */
@Directive({
  selector: '[appMenu]',
  exportAs: 'appMenu',
  standalone: true,
  host: {
    '(click)': 'toggle()',
    'aria-haspopup': 'menu',
    '[attr.aria-expanded]': 'isOpen()',
    '[class.active]': 'isOpen()',
  },
})
export class MenuDirective {
  /** The menu content: a template reference. */
  readonly content = input.required<TemplateRef<unknown>>({ alias: 'appMenu' });

  /** [x, y]. Defaults to below the container, aligned to its left edge. */
  readonly position = input<MenuPosition>(['left', 'bottom'], { alias: 'menuPosition' });

  /** Gap between the container and the menu (px). */
  readonly offset = input(4, { alias: 'menuOffset' });

  readonly opened = output<void>();
  readonly closed = output<void>();
  /** Emits the current open state whenever the menu opens or closes. */
  readonly openChange = output<boolean>();

  readonly isOpen = signal(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly vcr = inject(ViewContainerRef);
  private readonly renderer = inject(Renderer2);
  private readonly document = inject(DOCUMENT);

  private view: EmbeddedViewRef<unknown> | null = null;
  private panel: HTMLElement | null = null;
  private teardown: Array<() => void> = [];

  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true; // Angular has already destroyed our outputs by now
      this.close();
    });
  }

  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  open(): void {
    if (this.isOpen()) return;

    // Render the content and move it into a panel attached to <body>,
    // so it is never clipped by an ancestor's overflow.
    this.view = this.vcr.createEmbeddedView(this.content());
    this.view.detectChanges();

    const panel = this.renderer.createElement('div') as HTMLElement;
    this.renderer.addClass(panel, PANEL_CLASS);
    this.renderer.setAttribute(panel, 'role', 'menu');
    this.renderer.setStyle(panel, 'position', 'fixed');
    this.renderer.setStyle(panel, 'top', '0');
    this.renderer.setStyle(panel, 'left', '0');
    this.renderer.setStyle(panel, 'z-index', '1000');
    this.renderer.setStyle(panel, 'visibility', 'hidden'); // until measured
    this.view.rootNodes.forEach((node) => this.renderer.appendChild(panel, node));
    this.renderer.appendChild(this.document.body, panel);
    this.panel = panel;
    openMenus.set(panel, this);
    const parent = this.host.nativeElement.closest<HTMLElement>(`.${PANEL_CLASS}`);
    if (parent) parentPanels.set(panel, parent);

    this.updatePosition();
    this.renderer.setStyle(panel, 'visibility', 'visible');

    this.isOpen.set(true);
    this.listen();
    this.opened.emit();
    this.openChange.emit(true);
  }

  close(): void {
    if (!this.isOpen()) return;
    const panel = this.panel;

    // Children first, so none outlives its parent.
    for (const [childPanel, menu] of openMenus) {
      if (parentPanels.get(childPanel) === panel) menu.close();
    }

    this.teardown.forEach((fn) => fn());
    this.teardown = [];

    this.view?.destroy();
    this.view = null;
    this.panel?.remove();
    if (panel) openMenus.delete(panel);
    this.panel = null;

    this.isOpen.set(false);
    if (!this.destroyed) {
      this.closed.emit(); // emitting on a destroyed output is NG0953
      this.openChange.emit(false);
    }
  }

  /** Closes this menu and every menu it was opened from (after picking an item). */
  private closeAll(): void {
    const parentPanel = this.panel && parentPanels.get(this.panel);
    const parentMenu = parentPanel && openMenus.get(parentPanel);
    this.close();
    parentMenu?.closeAll();
  }

  /** True when the node is in our panel or in a menu opened from it. */
  private owns(node: Node): boolean {
    let panel = (node as Element).closest?.(`.${PANEL_CLASS}`) as HTMLElement | null;
    while (panel) {
      if (panel === this.panel) return true;
      panel = parentPanels.get(panel) ?? null;
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  private listen(): void {
    const win = this.document.defaultView!;
    const reposition = () => this.updatePosition();

    this.teardown.push(
      // Click outside closes the menu.
      this.renderer.listen(this.document, 'pointerdown', (e: Event) => {
        const target = e.target as Node;
        if (!this.host.nativeElement.contains(target) && !this.owns(target)) this.close();
      }),
      this.renderer.listen(this.document, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.close();
          this.host.nativeElement.focus?.();
        }
      }),
      // Clicking an item closes the menu (mark items with role="menuitem").
      this.renderer.listen(this.panel!, 'click', (e: Event) => {
        if ((e.target as HTMLElement).closest('[role="menuitem"]')) this.closeAll();
      }),
      this.renderer.listen(win, 'resize', reposition),
    );

    const observer = new ResizeObserver(reposition);
    observer.observe(this.panel!);
    this.teardown.push(() => observer.disconnect());

    this.document.addEventListener('scroll', reposition, true);
    this.teardown.push(() => this.document.removeEventListener('scroll', reposition, true));
  }

  private updatePosition(): void {
    const panel = this.panel;
    if (!panel) return;

    const host = this.host.nativeElement.getBoundingClientRect();
    const menu = panel.getBoundingClientRect();
    const vw = this.document.documentElement.clientWidth;
    const vh = this.document.documentElement.clientHeight;
    const gap = this.offset();

    const fitsX = (left: number) =>
      left >= VIEWPORT_MARGIN && left + menu.width <= vw - VIEWPORT_MARGIN;
    const fitsY = (top: number) =>
      top >= VIEWPORT_MARGIN && top + menu.height <= vh - VIEWPORT_MARGIN;

    const place = (x: MenuX, y: MenuY) => {
      if (y === 'center') {
        return {
          left: x === 'left' ? host.left - menu.width - gap : host.right + gap,
          top: host.top + host.height / 2 - menu.height / 2,
        };
      }
      return {
        left: x === 'left' ? host.left : host.right - menu.width,
        top: y === 'bottom' ? host.bottom + gap : host.top - menu.height - gap,
      };
    };

    let [x, y] = this.position();
    let pos = place(x, y);

    // Vertical axis: flip top <-> bottom if it doesn't fit (not applicable to 'center').
    if (y !== 'center' && !fitsY(pos.top)) {
      const flipped = place(x, y === 'top' ? 'bottom' : 'top');
      if (fitsY(flipped.top)) {
        y = y === 'top' ? 'bottom' : 'top';
        pos = flipped;
      }
    }

    // Horizontal axis: flip left <-> right if it doesn't fit.
    if (!fitsX(pos.left)) {
      const flipped = place(x === 'left' ? 'right' : 'left', y);
      if (fitsX(flipped.left)) {
        x = x === 'left' ? 'right' : 'left';
        pos = flipped;
      }
    }

    // If neither side fits (menu bigger than the free space), keep it on screen.
    const left = Math.min(
      Math.max(pos.left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, vw - menu.width - VIEWPORT_MARGIN),
    );
    const top = Math.min(
      Math.max(pos.top, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, vh - menu.height - VIEWPORT_MARGIN),
    );

    this.renderer.setStyle(panel, 'left', `${left}px`);
    this.renderer.setStyle(panel, 'top', `${top}px`);
    this.renderer.setAttribute(panel, 'data-position', `${x}-${y}`);
  }
}
