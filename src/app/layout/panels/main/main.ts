import { Component, computed, effect, ElementRef, inject, Injector } from '@angular/core';
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
import { baseName } from '../../../feature/editor/features/diff-tab';
import { Editor } from '../../../feature/editor/editor';
import { FileIcon } from '../../../shared/components/file-icon';

/** What the tab strip draws: a file, diff, task, review, note, or chat tab. */
interface TabView {
  id: string;
  kind: 'file' | 'diff' | 'task' | 'review' | 'note' | 'chat';
  type: TabContentType;
  label: string;
  dirty: boolean;
  active: boolean;
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
    FileIcon,
    CdkDrag,
    CdkDropList,
  ],
})
export class MainPanel {
  readonly nodeStore = inject(NodeStore);
  readonly editorService = inject(EditorService);
  readonly command = inject(EditorCommands);
  readonly injector = inject(Injector);

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

        case 'Review': {
          const label = tab.title ?? 'Review';
          return [
            {
              id,
              kind: 'review',
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

        case 'chat':
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

  constructor() {
    effect(() => {
      // activeTabId (not the explorer's active node): opening a diff doesn't change the explorer's active node.
      if (this.tabStore.activeTabId()) {
        setTimeout(() => this.scrollActiveIntoView(), 0);
      }
    });
  }

  scrollActiveIntoView(): void {
    const container = this.elementRef.nativeElement.querySelector('.opened-tabs') as HTMLElement;
    const active = container?.querySelector<HTMLElement>('.is-active');

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

  isDirty(nodeId: string) {
    return this.tabStore.isDirty(nodeId);
  }
}
