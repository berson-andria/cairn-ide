import { computed, effect, inject, Injectable, Signal, signal } from '@angular/core';
import { SETTINGS, SettingDef, SettingValue } from './settings.model';
import { LayoutService, Density, Side, TerminalSpan } from '../../core/services/layout.service';

const STORAGE_KEY = 'app.settings.v1';

interface Binding {
  get: () => SettingValue;
  set: (value: SettingValue) => void;
}

/**
 * Single access point for every setting.
 *
 * - Layout settings are *bound* to LayoutService signals (LayoutService stays the source of truth,
 *   so dragging a gutter or pressing a toggle also updates the settings UI and is persisted).
 * - Every other setting lives in `overrides` (only values that differ from the default are stored).
 * - Persistence is localStorage behind load() / save(): swap those two for a Tauri store / settings.json later.
 *
 * Read from anywhere (reactive):   settings.get<number>('editor.fontSize')
 *                                  readonly fontSize = settings.select<number>('editor.fontSize');
 *
 * Inject this service once at startup (e.g. in IdeShell) so the saved layout is restored immediately.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly layout = inject(LayoutService);

  readonly definitions = SETTINGS;
  private readonly byKey = new Map(SETTINGS.map((d) => [d.key, d]));
  private readonly overrides = signal<Record<string, SettingValue>>({});

  private readonly bindings: Record<string, Binding> = {
    'workbench.density': {
      get: () => this.layout.density(),
      set: (v) => this.layout.density.set(v as Density),
    },
    'workbench.sideBar.location': {
      get: () => (this.layout.side() === 'swapped' ? 'right' : 'left'),
      set: (v) => this.layout.side.set((v === 'right' ? 'swapped' : 'normal') as Side),
    },
    'workbench.panel.alignment': {
      get: () => this.layout.terminalSpan(),
      set: (v) => this.layout.terminalSpan.set(v as TerminalSpan),
    },
    'workbench.sideBar.visible': {
      get: () => !this.layout.isPrimaryPanelCollapsed(),
      set: (v) => this.layout.isPrimaryPanelCollapsed.set(!v),
    },
    'workbench.secondarySideBar.visible': {
      get: () => !this.layout.isSecondaryPanelCollapesed(),
      set: (v) => this.layout.isSecondaryPanelCollapesed.set(!v),
    },
    'workbench.panel.visible': {
      get: () => !this.layout.isTerminalPanelCollapesed(),
      set: (v) => this.layout.isTerminalPanelCollapesed.set(!v),
    },
    'workbench.sideBar.width': {
      get: () => this.layout.explorerWidth(),
      set: (v) => this.layout.explorerWidth.set(v as number),
    },
    'workbench.secondarySideBar.width': {
      get: () => this.layout.agentWidth(),
      set: (v) => this.layout.agentWidth.set(v as number),
    },
    'workbench.panel.height': {
      get: () => this.layout.terminalHeigth(),
      set: (v) => this.layout.terminalHeigth.set(v as number),
    },
  };

  readonly modifiedCount = computed(() =>
    this.definitions.reduce((n, d) => n + (this.isModified(d.key) ? 1 : 0), 0),
  );

  constructor() {
    this.restore(this.load());
    effect(() => this.save(this.snapshot()));
  }

  /** Current value. Reactive when called inside a template, computed() or effect(). */
  get<T extends SettingValue = SettingValue>(key: string): T {
    const def = this.def(key);
    const bound = this.bindings[key];
    if (bound) return bound.get() as T;
    return (this.overrides()[key] ?? def.default) as T;
  }

  /** A signal for one setting, handy as a component field. */
  select<T extends SettingValue = SettingValue>(key: string): Signal<T> {
    return computed(() => this.get<T>(key));
  }

  /** Validates (type, range, allowed options) then applies. Invalid values are ignored. */
  set(key: string, raw: unknown): void {
    const def = this.def(key);
    const value = coerce(def, raw);
    if (value === undefined) return;

    const bound = this.bindings[key];
    if (bound) {
      bound.set(value);
      return;
    }
    this.overrides.update((o) => {
      const next = { ...o };
      if (value === def.default) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  reset(key: string): void {
    this.set(key, this.def(key).default);
  }

  resetAll(): void {
    this.overrides.set({});
    Object.keys(this.bindings).forEach((key) => this.reset(key));
  }

  isModified(key: string): boolean {
    return this.get(key) !== this.def(key).default;
  }

  // ---------------------------------------------------------------- internals
  private def(key: string): SettingDef {
    const def = this.byKey.get(key);
    if (!def) throw new Error(`Unknown setting "${key}"`);
    return def;
  }

  private snapshot(): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const def of this.definitions) {
      const v = this.get(def.key);
      if (v !== def.default) out[def.key] = v;
    }
    return out;
  }

  private restore(saved: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(saved)) {
      if (this.byKey.has(key)) this.set(key, value);
    }
  }

  // Swap these two for a Tauri store / settings.json file if you want settings outside the webview.
  private load(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private save(values: Record<string, SettingValue>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch {
      /* storage unavailable or full: settings simply won't persist */
    }
  }
}

function coerce(def: SettingDef, raw: unknown): SettingValue | undefined {
  switch (def.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
      let n = raw;
      if (def.min !== undefined) n = Math.max(def.min, n);
      if (def.max !== undefined) n = Math.min(def.max, n);
      return Number.isInteger(def.step ?? 1) ? Math.round(n) : n;
    }
    case 'select':
      return typeof raw === 'string' && def.options?.some((o) => o.value === raw) ? raw : undefined;
    case 'text':
      return typeof raw === 'string' ? raw : undefined;
  }
}
