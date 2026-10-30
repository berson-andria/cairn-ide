import { provideIcons } from '@ng-icons/core';
import { Component, computed, effect, ElementRef, inject, Injector, Signal } from '@angular/core';
import { CdkDropList, CdkDrag } from '@angular/cdk/drag-drop';
import { bootstrapX } from '@ng-icons/bootstrap-icons';
import { CommonModule } from '@angular/common';
import { WorkspaceNodeStore } from '../../core/store/workspace/workspace.store';
import { FileNode } from '../../core/store/workspace/workspace.state';
import { getIconName } from '../../shared/utils/node.utils';
import { EditorService } from './services/editor.service';
import { EditorTabsStore } from '../../core/store/editor-tabs.store';
import { EditorCommands } from './editor.commands';
import { CodeEditorComponent } from './features/code-editor.component';
import { DiffEditorComponent } from './features/diff-editor.component';
import { baseName } from './features/diff-tab';

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

@Component({
  selector: 'editor-panel',
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  imports: [CommonModule, CodeEditorComponent, DiffEditorComponent, CdkDrag, CdkDropList],
  providers: [provideIcons({ bootstrapX })],
})
export class Editor {
  nodeStore = inject(WorkspaceNodeStore);
  tabStore = inject(EditorTabsStore);
  editorService = inject(EditorService);
  command = inject(EditorCommands);
  injector = inject(Injector);

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
            icon: getIconName(baseName(modified.path), 'file', false),
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
          icon: getIconName(node.name, 'file', false),
          dirty: this.tabStore.isDirty(id),
          active: id === active,
          tooltip: node.path,
        },
      ];
    });
  });

  activeTab = computed(() => this.tabs().find((t) => t.active) ?? null);
  /** Which editor is visible. Both stay alive while needed; the other is just hidden. */
  activeKind = computed(() => {
    const id = this.tabStore.activeTabId();
    return id && this.tabStore.diffTabs()[id] ? 'diff' : 'file';
  });
  hasDiffTabs = computed(() => Object.keys(this.tabStore.diffTabs()).length > 0);

  filePath: Signal<string[]> = computed(() => {
    const id = this.tabStore.activeTabId();
    if (!id) return [];
    const diff = this.tabStore.diffTabs()[id];
    const path = diff ? diff.request.modified.path : this.nodeStore.nodes()[id]?.path;
    return path ? this.getFilePathArray(path, this.nodeStore.rootPath()) : [];
  });

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
    const container = this.elementRef.nativeElement.querySelector('.opened-files') as HTMLElement;
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

  getFilePathArray(path: string, rootPath: string | null) {
    if (!path) {
      return [];
    }
    path = this.normalizePath(path, rootPath);
    return path.split('\\');
  }

  normalizePath(path: string, rootPath: string | null) {
    path = this.sanitizePath(path);
    let normalizedPath =
      rootPath && path.includes(rootPath)
        ? path.split(this.sanitizePath(rootPath) + '\\')[1]
        : path;
    return normalizedPath;
  }

  private sanitizePath(path: string): string {
    return path.replace(/[\/]/g, '\\');
  }
}
