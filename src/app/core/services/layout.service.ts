import { effect, inject, Injectable, NgZone, signal } from '@angular/core';
import { GlobalSearch } from '../../features/search/global-search/global-search';
import { FileSearch } from '../../features/search/file-search/file-search';
import { DialogService } from './dialog/dialog.service';
import { TerminalService } from '../../features/tooling/terminal/terminal.service';
import { WorkspaceNodeStore } from '../store/workspace/workspace.store';

/** compact: no gap, no radius. comfortable: spaced, rounded panels. Visuals live in ide-shell.scss. */
export type Density = 'compact' | 'comfortable';
export type PanelId = 'explorer' | 'agent' | 'terminal';

/**
 * What the terminal spans (panels keep their own sizes whichever side they are on):
 *  all           terminal under everything (full width)
 *  editor        terminal under the editor only, explorer + agent full height
 *  with-explorer terminal under explorer + editor, agent full height
 *  with-agent    terminal under editor + agent, explorer full height
 */
export type TerminalSpan = 'all' | 'editor' | 'with-explorer' | 'with-agent';
/** swapped: activity bar + explorer on the right, agent on the left. */
export type Side = 'normal' | 'swapped';

interface PanelConfig {
  /** CSS custom property (set on the workspace element) that drives the panel size. */
  cssVar: string;
  axis: 'x' | 'y';
  /** +1: the panel grows when the pointer moves right/down. -1: grows when it moves left/up. */
  sign: 1 | -1;
  min: number;
  max: number;
}

/**
 * Panels are resized live, at most once per this many ms.
 * The gutter itself follows the pointer every frame through a transform, so it stays straight.
 * 0 = resize on every frame. Raise it (e.g. 33) if the editor / terminal relayout is heavy.
 */
const LIVE_RESIZE_INTERVAL = 0;

@Injectable({
  providedIn: 'root',
})
export class LayoutService {
  dialogService = inject(DialogService);
  terminal = inject(TerminalService);
  store = inject(WorkspaceNodeStore);
  private readonly zone = inject(NgZone);

  readonly isSecondaryPanelCollapesed = signal(true);
  readonly isPrimaryPanelCollapsed = signal(false);
  readonly isTerminalPanelCollapesed = signal(true);

  /** Last *open* size of each panel. Committed when a drag ends. */
  explorerWidth = signal<number>(280);
  agentWidth = signal<number>(320);
  terminalHeigth = signal<number>(320);

  activeResizer = signal<PanelId | null>(null);
  activePrimaryPanel = signal<'Explorer' | 'Commit' | 'Graph'>('Explorer');
  activeSecondaryPanel = signal<'Agent' | 'Todo' | 'Note'>('Agent');

  readonly density = signal<Density>('compact');
  readonly terminalSpan = signal<TerminalSpan>('all');
  readonly side = signal<Side>('normal');

  readonly MIN_WIDTH = 250;
  readonly MAX_WIDTH = 600;

  private readonly MIN_HEIGHT = 50;
  private readonly MAX_HEIGHT = 500;
  readonly COLLAPSE_THRESHOLD = 60;

  private readonly config: Record<PanelId, PanelConfig> = {
    explorer: {
      cssVar: '--explorer-w',
      axis: 'x',
      sign: 1,
      min: this.MIN_WIDTH,
      max: this.MAX_WIDTH,
    },
    agent: { cssVar: '--agent-w', axis: 'x', sign: -1, min: this.MIN_WIDTH, max: this.MAX_WIDTH },
    terminal: {
      cssVar: '--terminal-h',
      axis: 'y',
      sign: -1,
      min: this.MIN_HEIGHT,
      max: this.MAX_HEIGHT,
    },
  };

  private readonly state = {
    explorer: { size: this.explorerWidth, collapsed: this.isPrimaryPanelCollapsed },
    agent: { size: this.agentWidth, collapsed: this.isSecondaryPanelCollapesed },
    terminal: { size: this.terminalHeigth, collapsed: this.isTerminalPanelCollapesed },
  };

  /** The .workspace element of IdeShell: sizes are written on it as CSS variables. */
  private readonly workspaceEl = signal<HTMLElement | null>(null);

  constructor() {
    effect(async () => {
      // if (!this.isTerminalPanelCollapesed() && !this.terminal.activeSession()) {
      //   await this.terminal.create(this.store.rootPath());
      // }
    });

    // Keeps the CSS variables in sync with the signals (toggles, first render, drag end).
    effect(() => {
      const el = this.workspaceEl();
      if (!el) return;
      (Object.keys(this.state) as PanelId[]).forEach((panel) => {
        const { size, collapsed } = this.state[panel];
        this.applySize(el, panel, size(), collapsed());
      });
    });
  }

  registerWorkspace(el: HTMLElement | null): void {
    this.workspaceEl.set(el);
  }

  setActivePrimaryPanel(content: 'Explorer' | 'Commit' | 'Graph') {
    this.activePrimaryPanel.set(content);
  }
  setActiveSecondaryPanel(content: 'Agent' | 'Todo' | 'Note') {
    this.activeSecondaryPanel.set(content);
  }

  startDrag(event: PointerEvent, panel: PanelId): void {
    const workspace = this.workspaceEl();
    if (!workspace || event.button !== 0) return;
    event.preventDefault();

    const cfg = this.config[panel];
    const state = this.state[panel];
    const handle = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    // Swapped sides: the explorer sits on the right and the agent on the left, so their drag direction flips.
    const sign: 1 | -1 =
      cfg.axis === 'x' && this.side() === 'swapped' ? (-cfg.sign as 1 | -1) : cfg.sign;
    const read = (e: { clientX: number; clientY: number }) =>
      cfg.axis === 'x' ? e.clientX : e.clientY;

    const startPos = read(event);
    // A collapsed panel starts from 0, so it tracks the pointer 1:1 from its edge.
    const startSize = state.collapsed() ? 0 : state.size();

    let latestPos = startPos;
    let targetSize = state.size();
    let targetCollapsed = state.collapsed();
    let appliedShown = startSize; // size currently applied to the layout
    let lastApply = 0;
    let frame = 0;

    const flush = () => {
      frame = 0;
      const raw = startSize + sign * (latestPos - startPos);
      targetCollapsed = raw < this.COLLAPSE_THRESHOLD;
      if (!targetCollapsed) {
        targetSize = Math.round(Math.min(cfg.max, Math.max(cfg.min, raw)));
      }
      const shown = targetCollapsed ? 0 : targetSize;

      // Throttled live resize of the panels (layout)...
      const now = performance.now();
      if (shown !== appliedShown && now - lastApply >= LIVE_RESIZE_INTERVAL) {
        this.applySize(workspace, panel, targetSize, targetCollapsed);
        appliedShown = shown;
        lastApply = now;
      }

      // ...while the gutter tracks the pointer every frame (compositor only).
      const residual = sign * (shown - appliedShown);
      handle.style.transform =
        cfg.axis === 'x' ? `translateX(${residual}px)` : `translateY(${residual}px)`;

      // Panels still catching up: keep going until they match the pointer.
      if (shown !== appliedShown) frame = requestAnimationFrame(flush);
    };

    const abort = new AbortController();

    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
      if (frame) cancelAnimationFrame(frame);
      abort.abort();
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);

      // Apply the final size and drop the preview offset in the same frame.
      this.applySize(workspace, panel, targetSize, targetCollapsed);
      handle.style.transform = '';

      this.zone.run(() => {
        if (!targetCollapsed) state.size.set(targetSize);
        state.collapsed.set(targetCollapsed);
        this.activeResizer.set(null);
      });
    };

    // No change detection per pointermove: listeners run outside Angular.
    this.zone.runOutsideAngular(() => {
      handle.setPointerCapture(pointerId);
      handle.addEventListener(
        'pointermove',
        (e) => {
          latestPos = read(e);
          if (!frame) frame = requestAnimationFrame(flush);
        },
        { signal: abort.signal },
      );
      handle.addEventListener('pointerup', end, { signal: abort.signal });
      handle.addEventListener('pointercancel', end, { signal: abort.signal });
    });

    this.activeResizer.set(panel);
  }

  private applySize(el: HTMLElement, panel: PanelId, size: number, collapsed: boolean): void {
    el.style.setProperty(this.config[panel].cssVar, `${collapsed ? 0 : size}px`);
  }

  togglePrimarySideBar() {
    this.isPrimaryPanelCollapsed.update((v) => !v);
  }

  toggleSecondarySideBar() {
    this.isSecondaryPanelCollapesed.update((v) => !v);
  }

  toggleTerminalPanel() {
    this.isTerminalPanelCollapesed.update((v) => !v);
  }

  setTerminalSpan(span: TerminalSpan) {
    this.terminalSpan.set(span);
  }

  toggleSide() {
    this.side.update((s) => (s === 'normal' ? 'swapped' : 'normal'));
  }

  toggleDensity() {
    this.density.update((d) => (d === 'compact' ? 'comfortable' : 'compact'));
  }

  openGlobalSearch() {
    this.dialogService.open(GlobalSearch);
  }

  openFileSearch() {
    this.dialogService.open(FileSearch);
  }
}
