import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import {
  DiffTab,
  DiffRequest,
  diffTabId,
  diffTitle,
} from '../../features/editor/features/diff-tab';

interface TabsState {
  /** Tab-bar order: file ids and diff tab ids. */
  openTabs: string[];
  diffTabs: Record<string, DiffTab>;
  /** Most recently focused first; [0] is the active tab. */
  focusHistory: string[];
  /** File ids whose editor content differs from disk. A property of the model, not of a tab. */
  dirty: Record<string, true>;
}

const focused = (history: string[], id: string) => [id, ...history.filter((h) => h !== id)];

const without = <T>(record: Record<string, T>, keys: string[]) => {
  const next = { ...record };
  keys.forEach((key) => delete next[key]);
  return next;
};

/** Which tabs are open, which is focused, which files are dirty. Synchronous state only: no I/O, no dialogs. */
export const EditorTabsStore = signalStore(
  { providedIn: 'root' },
  withState<TabsState>({ openTabs: [], diffTabs: {}, focusHistory: [], dirty: {} }),
  withComputed(({ focusHistory, dirty }) => ({
    activeTabId: computed(() => focusHistory()[0] ?? null),
    dirtyIds: computed(() => Object.keys(dirty())),
  })),
  withMethods((store) => ({
    isDirty: (id: string) => !!store.dirty()[id],

    openFile(id: string) {
      patchState(store, (s) => ({
        openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
        focusHistory: focused(s.focusHistory, id),
      }));
    },

    /** Opens (or focuses, if already open) a diff. Returns the diff tab id. */
    openDiff(request: DiffRequest): string {
      const tab: DiffTab = { id: diffTabId(request), title: diffTitle(request), request };
      patchState(store, (s) => ({
        diffTabs: { ...s.diffTabs, [tab.id]: tab },
        openTabs: s.openTabs.includes(tab.id) ? s.openTabs : [...s.openTabs, tab.id],
        focusHistory: focused(s.focusHistory, tab.id),
      }));
      return tab.id;
    },

    activate(id: string) {
      if (!store.openTabs().includes(id)) return;
      patchState(store, (s) => ({ focusHistory: focused(s.focusHistory, id) }));
    },

    /** Dirty flags are left alone on purpose: a model can outlive a tab (another tab or a diff may still use it). */
    closeMany(ids: string[]) {
      if (!ids.length) return null;
      const gone = new Set(ids);
      const newTabs = [...store.openTabs()].filter((t) => !gone.has(t));
      const newHistory = [...store.focusHistory()].filter((t) => !gone.has(t));
      const diffTabs = without({ ...store.diffTabs() }, ids);
      patchState(store, { openTabs: newTabs, focusHistory: newHistory, diffTabs: diffTabs });
      return newHistory[0];
    },

    closeAll() {
      patchState(store, { openTabs: [], diffTabs: {}, focusHistory: [] });
    },

    reorder(from: number, to: number) {
      patchState(store, (s) => {
        const last = s.openTabs.length - 1;
        if (from === to || from < 0 || to < 0 || from > last || to > last) return {};
        const tabs = [...s.openTabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        return { openTabs: tabs };
      });
    },

    setDirty(id: string, dirty: boolean) {
      patchState(store, (s) => {
        if (!!s.dirty[id] === dirty) return {};
        return { dirty: dirty ? { ...s.dirty, [id]: true as const } : without(s.dirty, [id]) };
      });
    },
    isDiffTab(id: string) {
      return Object.keys(store.diffTabs()).some((k) => k === id);
    },
  })),
);
