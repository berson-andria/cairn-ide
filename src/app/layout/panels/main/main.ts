import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDropList, CdkDrag } from '@angular/cdk/drag-drop';
import { BottomPanel } from '../bottom-panel/bottom-panel';
import { EmptyWorkspace } from './empty-workspace';
import { TabStore, TabContentType } from '../../../core/store/tab.store';
import { NodeStore } from '../../../core/store/node.store';
import { NoFolderOpen } from './no-folder';
import { FileNode } from '../../../core/store/node.state';
import { EditorService } from '../../../feature/editor/services/editor.service';
import { EditorCommands } from '../../../feature/editor/editor.commands';
import { NoteView } from '../../../feature/notes/note-view/note-view';
import { Editor } from '../../../feature/editor/editor';
import { FileIcon } from '../../../shared/components/file-icon';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFileWarning, lucideX } from '@ng-icons/lucide';
import { LayoutService, Toolkit } from '../../../core/services/layout.service';
import { GitService } from '../../../feature/git/services/git.service';
import { statusStyle } from '../../../feature/git/ui/git-ui';
import { getFileNameFromPath } from '../../../shared/utils/node.utils';
import { TaskView } from '../../../feature/tasks/task-view/task-view';
import { Chat } from '../../../feature/chat/chat';

/** What the tab strip draws: a file, diff, task, review, note, or chat tab. */
interface TabView {
  id: string;
  kind: 'file' | 'diff' | 'task' | 'review' | 'note' | 'chat';
  type: TabContentType;
  label: string;
  dirty: boolean;
  active: boolean;
  iconFileName?: string;
  tooltip: string;
}

@Component({
  selector: 'main-panel',
  templateUrl: './main-panel.html',
  styleUrl: './main-panel.scss',
  imports: [
    CommonModule,
    BottomPanel,
    EmptyWorkspace,
    NoFolderOpen,
    Editor,
    NoteView,
    TaskView,
    Chat,
    FileIcon,
    CdkDrag,
    CdkDropList,
    NgIcon,
  ],
  providers: [provideIcons({ lucideFileWarning, lucideX })],
})
export class MainPanel {
  readonly nodeStore = inject(NodeStore);
  readonly editorService = inject(EditorService);
  readonly command = inject(EditorCommands);
  readonly injector = inject(Injector);
  protected layoutService = inject(LayoutService);
  protected git = inject(GitService);

  private elementRef = inject(ElementRef);

  readonly tabStore = inject(TabStore);

  tabs = computed<TabView[]>(() => {
    const nodes = this.nodeStore.nodes();
    const diffs = this.tabStore.diffTabs();
    const active = this.tabStore.activeTabId();

    return this.tabStore.openedTabs().flatMap((tab): TabView[] => {
      const { id, type } = tab;

      switch (type) {
        case 'DiffEditor': {
          const diff = diffs[id];
          if (diff) {
            const { original, modified } = diff.request;
            // A diff is dirty when the working file on its modified side has unsaved edits.
            const fileId = modified.kind === 'worktree' ? modified.fileId : null;
            return [
              {
                id,
                kind: 'diff',
                type,
                label: diff.title ?? tab.title ?? 'Diff',
                dirty: !!fileId && this.tabStore.isDirty(fileId),
                active: id === active,
                iconFileName: getFileNameFromPath(<any>tab.data),
                tooltip:
                  original.path !== modified.path
                    ? `${original.path} → ${modified.path}`
                    : modified.path,
              },
            ];
          }
          const label = tab.title ?? 'Diff';
          return [
            {
              id,
              kind: 'diff',
              type,
              label,
              dirty: this.tabStore.isDirty(id),
              active: id === active,
              tooltip: label,
            },
          ];
        }

        case 'CodeEditor': {
          const node = nodes[id] as FileNode | undefined;
          const label = node?.name ?? tab.title ?? id;
          return [
            {
              id,
              kind: 'file',
              type,
              label,
              dirty: this.tabStore.isDirty(id),
              active: id === active,
              tooltip: node?.path ?? label,
            },
          ];
        }

        case 'Task': {
          const label = tab.title ?? 'Task';
          return [
            {
              id,
              kind: 'task',
              type,
              label,
              dirty: this.tabStore.isDirty(id),
              active: id === active,
              tooltip: label,
            },
          ];
        }

        case 'Note': {
          const label = tab.title ?? 'Notes';
          return [
            {
              id,
              kind: 'note',
              type,
              label,
              dirty: this.tabStore.isDirty(id),
              active: id === active,
              tooltip: label,
            },
          ];
        }

        case 'Chat': {
          const label = tab.title ?? 'Chat';
          return [
            {
              id,
              kind: 'chat',
              type,
              label,
              dirty: this.tabStore.isDirty(id),
              active: id === active,
              tooltip: label,
            },
          ];
        }

        default: {
          const label = tab.title ?? id;
          return [
            {
              id,
              kind: 'file',
              type,
              label,
              dirty: this.tabStore.isDirty(id),
              active: id === active,
              tooltip: label,
            },
          ];
        }
      }
    });
  });

  activeTab = computed(() => this.tabs().find((t) => t.active) ?? null);
  dirtyFileCount = computed(() => this.tabStore.dirtyIds().length);

  fileBadge(tab: TabView) {
    if (tab.kind !== 'diff' && tab.kind !== 'file') return null;
    const path = tab.kind === 'diff' ? tab.tooltip : this.nodeStore.nodes()[tab.id]!.path;
    return this.git.badgeFor(path);
  }

  private readonly destroyRef = inject(DestroyRef);

  readonly strip = viewChild<ElementRef<HTMLElement>>('strip');
  readonly overflowing = signal(false);
  readonly atEnd = signal(true);

  constructor() {
    effect(() => {
      // activeTabId (not the explorer's active node): opening a diff doesn't change the explorer's active node.
      if (this.tabStore.activeTabId()) {
        setTimeout(() => this.scrollActiveIntoView(), 0);
      }
    });
    effect(() => {
      const tab = this.activeTab();
      if (!tab) return;
      afterNextRender(
        () => {
          this.elementRef.nativeElement
            .querySelector(`[data-tab-id="${tab.id}"]`)
            ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        },
        { injector: this.injector },
      );
    });

    effect((onCleanup) => {
      const stripEl = this.strip()?.nativeElement;
      if (!stripEl) return;
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(stripEl);
      onCleanup(() => observer.disconnect());
    });

    // Tabs opening, closing or renaming change scrollWidth without resizing the strip
    effect(() => {
      this.tabs();
      afterNextRender(() => this.measure(), { injector: this.injector });
    });
  }

  statusStyle(tab: TabView) {
    const badge = this.fileBadge(tab);
    return badge ? statusStyle(<any>badge.letter).color : 'inherit';
  }

  measure() {
    const el = this.strip()?.nativeElement;
    if (!el) return;
    this.overflowing.set(el.scrollWidth > el.clientWidth + 1);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  scrollActiveIntoView(): void {
    const container = this.elementRef.nativeElement.querySelector('.opened-tabs') as HTMLElement;
    const active = container?.querySelector<HTMLElement>('.tab--active, .is-active');

    if (!container || !active) return;

    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    let left = container.scrollLeft;

    if (activeRect.left < containerRect.left) {
      left += activeRect.left - containerRect.left;
    } else if (activeRect.right > containerRect.right) {
      left += activeRect.right - containerRect.right;
    } else {
      return; // Already visible
    }

    container.scrollTo({ left, behavior: 'smooth' });
  }

  openTab(id: string) {
    this.tabStore.activate(id); // handles all kinds
    if (this.nodeStore.nodes()[id]) {
      this.nodeStore.selectNode(id, 'single');
    }
  }

  /** Asks about unsaved changes when needed, for file and diff tabs alike. */
  async closeTab(id: string) {
    const tab = this.tabStore.getTab(id);
    if (tab && tab.type !== 'CodeEditor' && tab.type !== 'DiffEditor') {
      return this.tabStore.closeTab(id);
    }
    const result = await this.command.closeTab(id);
    this.tabStore.closeTab(id);
    return result;
  }

  onTabDrop(e: any) {
    this.tabStore.reorder(e.previousIndex, e.currentIndex);
  }
  onTabsWheel(event: WheelEvent, el: HTMLElement) {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }

  protected toggleToolkit(toolkit: Toolkit) {
    if (this.layoutService.activeToolkit() === toolkit) {
      this.layoutService.toggleBottomPanel();
    } else if (!this.layoutService.isBottomPanelCollapsed()) {
      this.layoutService.toggleToolkit(toolkit);
    } else {
      this.layoutService.toggleToolkit(toolkit);
      this.layoutService.toggleBottomPanel();
    }
  }

  isDirty(nodeId: string) {
    return this.tabStore.isDirty(nodeId);
  }
}
