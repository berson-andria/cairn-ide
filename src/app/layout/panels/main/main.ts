import { Component, computed, effect, ElementRef, inject, Injector } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDropList, CdkDrag } from '@angular/cdk/drag-drop';
import { BottomPanel } from '../bottom-panel/bottom-panel';
import { EmptyWorkspace } from './empty-workspace';
import { EditorTabsStore } from '../../../core/store/editor-tabs.store';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { NoFolderOpen } from './no-folder';
import { FileNode } from '../../../core/store/workspace/workspace.state';
import { getIconPath } from '../../../shared/utils/node.utils';
import { EditorService } from '../../../feature/editor/services/editor.service';
import { EditorCommands } from '../../../feature/editor/editor.commands';
import { baseName } from '../../../feature/editor/features/diff-tab';

/** What the tab strip draws: a file or a diff, described the same way. */
interface TabView {
  id: string;
  kind: 'file' | 'diff';
  label: string;
  icon: string;
  dirty: boolean;
  active: boolean;
  tooltip: string;
}
export type ContentType = 'CodeEditor' | 'DiffEditor' | 'Task' | 'Review' | 'Note' | 'chat';
@Component({
  selector: 'main-panel',
  templateUrl: './main-panel.html',
  styleUrl: './main-panel.scss',
  imports: [CommonModule, BottomPanel, EmptyWorkspace, NoFolderOpen, CdkDrag, CdkDropList],
})
export class MainPanel {
  readonly nodeStore = inject(WorkspaceNodeStore);
  readonly tabStore = inject(EditorTabsStore);
  readonly editorService = inject(EditorService);
  readonly command = inject(EditorCommands);
  readonly injector = inject(Injector);

  private elementRef = inject(ElementRef);

  tabs = computed<TabView[]>(() => {
    const nodes = this.nodeStore.nodes();
    const diffs = this.tabStore.diffTabs();
    const active = this.tabStore.activeTabId();

    return this.tabStore.openTabs().flatMap((id): TabView[] => {
      const diff = diffs[id];
      if (diff) {
        const { original, modified } = diff.request;
        // A diff is dirty when the working file on its modified side has unsaved edits.
        const fileId = modified.kind === 'worktree' ? modified.fileId : null;
        return [
          {
            id,
            kind: 'diff',
            label: diff.title,
            icon: getIconPath(baseName(modified.path), 'file'),
            dirty: !!fileId && this.tabStore.isDirty(fileId),
            active: id === active,
            tooltip:
              original.path !== modified.path
                ? `${original.path} → ${modified.path}`
                : modified.path,
          },
        ];
      }
      const node = nodes[id] as FileNode | undefined;
      if (!node) return []; // a stale id: nothing to draw
      return [
        {
          id,
          kind: 'file',
          label: node.name,
          icon: getIconPath(node.name, 'file'),
          dirty: this.tabStore.isDirty(id),
          active: id === active,
          tooltip: node.path,
        },
      ];
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
    this.tabStore.activate(id); // handles both kinds
    this.nodeStore.selectNode(id, 'single');
  }

  /** Asks about unsaved changes when needed, for file and diff tabs alike. */
  closeTab(id: string) {
    return this.command.closeTab(id);
  }

  onTabDrop(e: any) {
    this.tabStore.reorder(e.previousIndex, e.currentIndex);
  }

  isDirty(nodeId: string) {
    return this.tabStore.isDirty(nodeId);
  }
}
