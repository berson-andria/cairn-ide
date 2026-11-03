import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFilePlus2, lucideRefreshCcw } from '@ng-icons/lucide';
import {
  bootstrapArrowsCollapse,
  bootstrapChevronDown,
  bootstrapChevronRight,
  bootstrapFolderPlus,
} from '@ng-icons/bootstrap-icons';
import { NodeDndDirective } from './node/node-dnd.directive';
import { FileNodeComponent } from './node/file-node/file-node';
import { FolderNodeComponent } from './node/folder-node/folder-node';
import { NewNode } from './node/new-node/new-node';
import { KeybindingService } from '../../core/services/command/keybinding.service';
import { InlineCreationMode } from '../../core/store/workspace/workspace.state';
import { WorkspaceNodeStore } from '../../core/store/workspace/workspace.store';
import { EditorCommands } from '../editor/editor.commands';
import { LayoutService } from '../../layout/layout-service';
import { EmptyExplorer } from './empty-explorer';

@Component({
  selector: 'file-tree',
  templateUrl: './tree.html',
  styleUrl: './tree.scss',
  imports: [FileNodeComponent, FolderNodeComponent, EmptyExplorer, NewNode, CommonModule, NgIcon],
  providers: [
    provideIcons({
      lucideFilePlus2,
      bootstrapFolderPlus,
      lucideRefreshCcw,
      bootstrapArrowsCollapse,
      bootstrapChevronDown,
      bootstrapChevronRight,
    }),
  ],
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Files") ? 1: "none"' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
})
export class FileTree {
  nodeStore = inject(WorkspaceNodeStore);
  commands = inject(EditorCommands);
  keys = inject(KeybindingService);

  layoutService = inject(LayoutService);

  private elementRef = inject(ElementRef);

  childFolder = computed(() => {
    const rootNodes = Object.values(this.nodeStore.rootNodes());
    return rootNodes.filter((child) => 'children' in child);
  });

  childFiles = computed(() => {
    const rootNodes = Object.values(this.nodeStore.rootNodes());
    return rootNodes.filter((child) => 'extension' in child);
  });
  constructor() {
    inject(DestroyRef).onDestroy(() => this.keys.setContext('explorerFocus', false));
    effect(() => {
      if (this.nodeStore.activeNodeId()) {
        setTimeout(() => this.scrollActiveNodeIntoView(), 0);
      }
    });
  }

  async addStandaloneFile() {
    const files = await this.nodeStore.addStandaloneFiles();
    for (const id of files) {
      await this.commands.openFile(id);
    }
  }

  handleAreaClick(event: MouseEvent, container: HTMLElement, placeholder: HTMLElement) {
    const clickedElement = event.target as HTMLElement;

    const clickedBackground = clickedElement === container;
    const clickedPlaceholder = placeholder.contains(clickedElement);

    if (clickedBackground || clickedPlaceholder) {
      this.nodeStore.resetActiveNode();
      this.nodeStore.clearSelection();
    }
  }

  /** Focus moving between rows (or into the rename input) stays inside the explorer: only leaving clears it. */
  onFocusOut(event: FocusEvent, container: HTMLElement) {
    if (!container.contains(event.relatedTarget as Node | null)) {
      this.keys.setContext('explorerFocus', false);
    }
  }

  /** Dropping on empty space (or the placeholder) moves into the project root. */
  onRootDragOver(event: DragEvent) {
    if (NodeDndDirective.canDrop(this.nodeStore, null)) event.preventDefault();
  }
  onRootDrop(event: DragEvent) {
    event.preventDefault();
    void NodeDndDirective.drop(this.nodeStore, null);
  }

  addNode(mode: InlineCreationMode) {
    this.nodeStore.showInlineCreationForm(mode);

    setTimeout(() => {
      const container = this.elementRef.nativeElement.querySelector('.container') as HTMLElement;
      if (!container) return;

      const activeRow = container.querySelector('.node-row.add-node') as HTMLElement;
      if (!activeRow) return;

      const inputEl = activeRow.querySelector('input[type="text"]') as HTMLInputElement;
      if (!inputEl) return;

      const containerRect = container.getBoundingClientRect();
      const rowRect = activeRow.getBoundingClientRect();

      const stickyFolders = Array.from(
        container.querySelectorAll('.node-row.folder.is-open'),
      ) as HTMLElement[];

      let totalStickyHeaderHeight = 0;

      stickyFolders.forEach((folder) => {
        const folderRect = folder.getBoundingClientRect();
        if (folderRect.top < rowRect.top && folderRect.top >= containerRect.top) {
          totalStickyHeaderHeight = Math.max(
            totalStickyHeaderHeight,
            folderRect.bottom - containerRect.top,
          );
        }
      });

      const relativeTop = rowRect.top - containerRect.top + container.scrollTop;
      const relativeBottom = relativeTop + rowRect.height;

      const viewTopLimit = container.scrollTop + totalStickyHeaderHeight;
      const viewBottomLimit = container.scrollTop + container.clientHeight;

      const applyFocus = () => {
        inputEl.focus();
        inputEl.select();
      };

      let didScroll = false;

      if (relativeTop < viewTopLimit) {
        didScroll = true;
        container.scrollTo({
          top: relativeTop - totalStickyHeaderHeight - 520,
          behavior: 'smooth',
        });
      } else if (relativeBottom > viewBottomLimit) {
        didScroll = true;
        container.scrollTo({
          top: relativeBottom - container.clientHeight + 520,
          behavior: 'smooth',
        });
      }

      if (didScroll) {
        const handleScrollEnd = () => {
          applyFocus();
          container.removeEventListener('scrollend', handleScrollEnd);
        };

        container.addEventListener('scrollend', handleScrollEnd);

        setTimeout(() => {
          container.removeEventListener('scrollend', handleScrollEnd);
          applyFocus();
        }, 400);
      } else {
        applyFocus();
      }
    }, 0);
  }

  saveNewNode(nodeName: string, mode: InlineCreationMode) {
    this.nodeStore.submitInlineCreation(nodeName, mode, null);
  }

  private scrollActiveNodeIntoView(): void {
    const container = this.elementRef.nativeElement.querySelector('.container') as HTMLElement;
    if (!container) return;

    const activeRow = container.querySelector('.node-row.is-active') as HTMLElement;
    if (!activeRow) return;

    const containerRect = container.getBoundingClientRect();
    const rowRect = activeRow.getBoundingClientRect();

    const stickyFolders = Array.from(
      container.querySelectorAll('.node-row.folder.is-open'),
    ) as HTMLElement[];

    let totalStickyHeaderHeight = 0;

    stickyFolders.forEach((folder) => {
      const folderRect = folder.getBoundingClientRect();
      if (folderRect.top < rowRect.top && folderRect.top >= containerRect.top) {
        totalStickyHeaderHeight = Math.max(
          totalStickyHeaderHeight,
          folderRect.bottom - containerRect.top,
        );
      }
    });

    const relativeTop = rowRect.top - containerRect.top + container.scrollTop;
    const relativeBottom = relativeTop + rowRect.height;

    const viewTopLimit = container.scrollTop + totalStickyHeaderHeight;
    const viewBottomLimit = container.scrollTop + container.clientHeight;

    if (relativeTop < viewTopLimit) {
      container.scrollTo({
        top: relativeTop - totalStickyHeaderHeight - 120,
        behavior: 'smooth',
      });
    } else if (relativeBottom > viewBottomLimit) {
      container.scrollTo({
        top: relativeBottom - container.clientHeight + 120,
        behavior: 'smooth',
      });
    }
  }
}
