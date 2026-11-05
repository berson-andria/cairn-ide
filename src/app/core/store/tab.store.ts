import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { DiffTab, DiffRequest, diffTabId, diffTitle } from '../../feature/editor/features/diff-tab';

export type TabContentType =
  | 'CodeEditor'
  | 'DiffEditor'
  | 'Task'
  | 'Review'
  | 'Note'
  | 'chat'
  | 'Chat';

export interface Tab<T = unknown> {
  id: string;
  type: TabContentType;
  title?: string;
  data?: T;
}

export interface TabState {
  openedTabs: Tab[];
  focusHistory: Tab[];
  diffTabs: Record<string, DiffTab>;
  dirty: Record<string, true>;
}

const focused = (history: Tab[], tab: Tab): Tab[] => [
  tab,
  ...history.filter((h) => h.id !== tab.id),
];

const without = <T>(record: Record<string, T>, keys: string[]): Record<string, T> => {
  const next = { ...record };
  keys.forEach((key) => delete next[key]);
  return next;
};

export const initialTabState: TabState = {
  openedTabs: [],
  focusHistory: [],
  diffTabs: {},
  dirty: {},
};

/**
 * TabStore manages all tabs opened in the main IDE panel (CodeEditor, DiffEditor, Task, Review, Note, Chat).
 * Tracks tab ordering, focus history, active tab, diff metadata, and dirty state synchronously.
 */
export const TabStore = signalStore(
  { providedIn: 'root' },
  withState<TabState>(initialTabState),
  withComputed(({ openedTabs, focusHistory, dirty }) => ({
    /** Currently active tab object, or null if no tabs are open. */
    activeTab: computed(() => focusHistory()[0] ?? null),
    /** Currently active tab ID, or null if no tabs are open. */
    activeTabId: computed(() => focusHistory()[0]?.id ?? null),
    /** Currently active tab content type, or null if no tabs are open. */
    activeTabType: computed(() => focusHistory()[0]?.type ?? null),
    /** Array of open tab IDs in order */
    openTabs: computed(() => openedTabs().map((t) => t.id)),
    openTabIds: computed(() => openedTabs().map((t) => t.id)),

    dirtyIds: computed(() => Object.keys(dirty())),

    dirtyCount: computed(() => Object.keys(dirty()).length),
  })),
  withMethods((store) => ({
    isDirty: (id: string) => !!store.dirty()[id],

    setDirty(id: string, dirty: boolean) {
      patchState(store, (s) => {
        if (!!s.dirty[id] === dirty) return {};
        return { dirty: dirty ? { ...s.dirty, [id]: true as const } : without(s.dirty, [id]) };
      });
    },

    /**
     * Opens a tab or focuses it if already open.
     * Merges updates into existing tab if already present.
     */
    openTab(tab: Tab) {
      patchState(store, (s) => {
        const existingIndex = s.openedTabs.findIndex((t) => t.id === tab.id);
        const resolvedTab = existingIndex >= 0 ? { ...s.openedTabs[existingIndex], ...tab } : tab;
        const openedTabs =
          existingIndex >= 0
            ? s.openedTabs.map((t) => (t.id === tab.id ? resolvedTab : t))
            : [...s.openedTabs, tab];

        return {
          openedTabs,
          focusHistory: focused(s.focusHistory, resolvedTab),
        };
      });
    },

    /** Opens or focuses a file in Monaco CodeEditor. */
    openCodeEditor(id: string, title?: string) {
      this.openTab({ id, type: 'CodeEditor', ...(title ? { title } : {}) });
    },

    /** Alias for openCodeEditor. */
    openFile(id: string, title?: string) {
      this.openCodeEditor(id, title);
    },

    /** Opens (or focuses, if already open) a diff editor tab. Returns the diff tab id. */
    openDiff(request: DiffRequest, title?: string): string {
      const id = diffTabId(request);
      const resolvedTitle = title ?? diffTitle(request);
      const diffTab: DiffTab = { id, title: resolvedTitle, request };
      const tab: Tab = { id, type: 'DiffEditor', title: resolvedTitle };

      patchState(store, (s) => {
        const existingIndex = s.openedTabs.findIndex((t) => t.id === id);
        const resolvedTab = existingIndex >= 0 ? { ...s.openedTabs[existingIndex], ...tab } : tab;
        const openedTabs =
          existingIndex >= 0
            ? s.openedTabs.map((t) => (t.id === id ? resolvedTab : t))
            : [...s.openedTabs, tab];

        return {
          diffTabs: { ...s.diffTabs, [id]: diffTab },
          openedTabs,
          focusHistory: focused(s.focusHistory, resolvedTab),
        };
      });

      return id;
    },

    /** Alias for openDiff. */
    openDiffEditor(request: DiffRequest, title?: string): string {
      return this.openDiff(request, title);
    },

    /** Opens or focuses a Task view tab. Returns the task tab id. */
    openTask(id: string, title: string, data?: unknown): string {
      this.openTab({ id, type: 'Task', title, ...(data !== undefined ? { data } : {}) });
      return id;
    },

    /** Opens or focuses a Note view tab. Returns the note tab id. */
    openNote(id: string, title: string, data?: unknown): string {
      this.openTab({ id, type: 'Note', title, ...(data !== undefined ? { data } : {}) });
      return id;
    },

    /** Opens or focuses a Review view tab. Returns the review tab id. */
    openReview(id: string, title: string, data?: unknown): string {
      this.openTab({
        id,
        type: 'Review',
        title,
        ...(data !== undefined ? { data } : {}),
      });
      return id;
    },

    /** Opens or focuses a Chat view tab. Returns the chat tab id. */
    openChat(id: string, title: string, data?: unknown): string {
      this.openTab({
        id,
        type: 'chat',
        title,
        ...(data !== undefined ? { data } : {}),
      });
      return id;
    },

    /** Focuses an already opened tab by ID. */
    activate(id: string) {
      const tab = store.openedTabs().find((t) => t.id === id);
      if (!tab) return;
      patchState(store, (s) => ({ focusHistory: focused(s.focusHistory, tab) }));
    },

    /** Focuses an already opened tab. */
    activateTab(tab: Tab) {
      this.activate(tab.id);
    },

    /** Updates properties of an existing open tab (e.g. title or data). */
    updateTab(id: string, updates: Partial<Omit<Tab, 'id'>>) {
      patchState(store, (s) => {
        const updateFn = (t: Tab) => (t.id === id ? { ...t, ...updates } : t);
        return {
          openedTabs: s.openedTabs.map(updateFn),
          focusHistory: s.focusHistory.map(updateFn),
        };
      });
    },

    /** Closes a single tab by ID. Returns the newly active tab ID or null. */
    closeTab(id: string): string | null {
      return this.closeMany([id]);
    },

    /** Closes multiple tabs by ID. Returns the newly active tab ID or null. */
    closeMany(ids: string[]): string | null {
      if (!ids.length) return store.activeTabId();
      const gone = new Set(ids);
      const newTabs = store.openedTabs().filter((t) => !gone.has(t.id));
      const newHistory = store.focusHistory().filter((t) => !gone.has(t.id));
      const diffTabs = without({ ...store.diffTabs() }, ids);

      patchState(store, {
        openedTabs: newTabs,
        focusHistory: newHistory,
        diffTabs,
      });

      return newHistory[0]?.id ?? null;
    },

    /** Closes all open tabs except the specified one. Returns the active tab ID. */
    closeOthers(id: string): string | null {
      const toClose = store
        .openedTabs()
        .filter((t) => t.id !== id)
        .map((t) => t.id);
      return this.closeMany(toClose);
    },

    /** Closes all tabs to the right of the given tab ID. Returns the active tab ID. */
    closeTabsToRight(id: string): string | null {
      const tabs = store.openedTabs();
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1 || index === tabs.length - 1) return store.activeTabId();
      const toClose = tabs.slice(index + 1).map((t) => t.id);
      return this.closeMany(toClose);
    },

    /** Closes all open tabs. */
    closeAll() {
      patchState(store, { openedTabs: [], diffTabs: {}, focusHistory: [] });
    },

    /** Reorders tabs in the tab strip by index. */
    reorder(from: number, to: number) {
      patchState(store, (s) => {
        const last = s.openedTabs.length - 1;
        if (from === to || from < 0 || to < 0 || from > last || to > last) return {};
        const tabs = [...s.openedTabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        return { openedTabs: tabs };
      });
    },

    /** Returns whether a given tab ID is a diff tab. */
    isDiffTab(id: string): boolean {
      return (
        store.openedTabs().some((t) => t.id === id && t.type === 'DiffEditor') ||
        !!store.diffTabs()[id]
      );
    },

    /** Look up a tab by its ID. */
    getTab(id: string): Tab | undefined {
      return store.openedTabs().find((t) => t.id === id);
    },

    /** Checks whether a tab with the specified ID is currently open. */
    isOpen(id: string): boolean {
      return store.openedTabs().some((t) => t.id === id);
    },

    /** Returns all open tabs matching the specified type. */
    getTabsByType(type: TabContentType): Tab[] {
      return store.openedTabs().filter((t) => t.type === type);
    },

    /** Cycles the active tab forward (+1) or backward (-1). */
    cycleTab(direction: 1 | -1) {
      const tabs = store.openedTabs();
      if (tabs.length < 2) return;
      const currentId = store.activeTabId();
      const current = tabs.findIndex((t) => t.id === currentId);
      const nextIndex = (current + direction + tabs.length) % tabs.length;
      this.activate(tabs[nextIndex].id);
    },

    /** Switches to the next tab in the tab-bar. */
    nextTab() {
      this.cycleTab(1);
    },

    previousTab() {
      this.cycleTab(-1);
    },
  })),
);
