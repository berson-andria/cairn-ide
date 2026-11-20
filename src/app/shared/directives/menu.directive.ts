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

export type MenuPosition =
  | 'top'
  | 'bottom'
  | 'top left'
  | 'top right'
  | 'bottom left'
  | 'bottom right'
  | 'center left'
  | 'center right'
  | 'left' // alias of 'center left'
  | 'right'; // alias of 'center right'

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';
interface Placement {
  side: Side;
  align: Align;
}

/** Maps every public position to a side of the host + an alignment along that side. */
const PLACEMENTS: Record<MenuPosition, Placement> = {
  top: { side: 'top', align: 'center' },
  bottom: { side: 'bottom', align: 'center' },
  'top left': { side: 'top', align: 'start' },
  'top right': { side: 'top', align: 'end' },
  'bottom left': { side: 'bottom', align: 'start' },
  'bottom right': { side: 'bottom', align: 'end' },
  'center left': { side: 'left', align: 'center' },
  left: { side: 'left', align: 'center' },
  'center right': { side: 'right', align: 'center' },
  right: { side: 'right', align: 'center' },
};

const OPPOSITE_SIDE: Record<Side, Side> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

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
 *   <button [appMenu]="menu" menuPosition="bottom right">Open</button>
 *   <ng-template #menu> ... </ng-template>
 *
 * Positions
 *  - 'bottom' / 'top'            below / above the container, horizontally centred.
 *  - 'bottom left' / 'top left'  below / above, menu's left edge on the container's left edge.
 *  - 'bottom right' / 'top right' below / above, menu's right edge on the container's right edge.
 *  - 'center left'  ('left')     beside the container on its left, vertically centred.
 *  - 'center right' ('right')    beside the container on its right, vertically centred.
 *
 * Position is a preference, not a rule: if the menu would leave the viewport,
 * it flips to the opposite side (top<->bottom, left<->right) or, for edge-aligned
 * menus, to the opposite alignment (left<->right), as long as that actually fits.
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

  /** Defaults to below the container, aligned to its left edge. */
  readonly position = input<MenuPosition>('bottom left', { alias: 'menuPosition' });

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

    const place = (side: Side, align: Align) => {
      if (side === 'top' || side === 'bottom') {
        return {
          top: side === 'bottom' ? host.bottom + gap : host.top - menu.height - gap,
          left:
            align === 'start'
              ? host.left
              : align === 'end'
                ? host.right - menu.width
                : host.left + host.width / 2 - menu.width / 2,
        };
      }
      return {
        left: side === 'left' ? host.left - menu.width - gap : host.right + gap,
        top: host.top + host.height / 2 - menu.height / 2,
      };
    };

    let { side, align } = PLACEMENTS[this.position()] ?? PLACEMENTS['bottom left'];
    let pos = place(side, align);

    if (side === 'top' || side === 'bottom') {
      // Main axis (vertical): flip top <-> bottom if it doesn't fit.
      if (!fitsY(pos.top)) {
        const flipped = place(OPPOSITE_SIDE[side], align);
        if (fitsY(flipped.top)) {
          side = OPPOSITE_SIDE[side];
          pos = flipped;
        }
      }
      // Cross axis (horizontal): flip start <-> end if it doesn't fit.
      // A centred menu has nothing to flip; it is clamped below.
      if (align !== 'center' && !fitsX(pos.left)) {
        const flippedAlign: Align = align === 'start' ? 'end' : 'start';
        const flipped = place(side, flippedAlign);
        if (fitsX(flipped.left)) {
          align = flippedAlign;
          pos = flipped;
        }
      }
    } else if (!fitsX(pos.left)) {
      // Main axis (horizontal): flip left <-> right if it doesn't fit.
      const flipped = place(OPPOSITE_SIDE[side], align);
      if (fitsX(flipped.left)) {
        side = OPPOSITE_SIDE[side];
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
    this.renderer.setAttribute(panel, 'data-position', `${side}-${align}`);
  }
}
