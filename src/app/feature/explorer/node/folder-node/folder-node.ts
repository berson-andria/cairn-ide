import { Component, computed, effect, inject, input, InputSignal, signal } from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { FileNode } from '../file-node/file-node';
import { NewNode } from '../new-node/new-node';
import { NodeDndDirective } from '../node-dnd.directive';
import { RenameNode } from '../rename-node/rename-node';
import { InlineCreationMode } from '../../../../core/store/node.state';
import { NodeStore } from '../../../../core/store/node.store';
import { FileIcon } from '../../../../shared/components/file-icon';
import { GitService } from '../../../git/services/git.service';
import { statusStyle } from '../../../git/ui/git-ui';
import { LayoutService } from '../../../../core/services/layout.service';

@Component({
  selector: 'folder-node',
  templateUrl: './folder-node.html',
  styleUrls: ['./folder-node.scss', '../node.scss'],
  imports: [NgClass, NgStyle, NgIcon, NewNode, FileNode, FileIcon, RenameNode, NodeDndDirective],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
})
export class FolderNode {
  nodeStore = inject(NodeStore);
  protected readonly git = inject(GitService);
  readonly layout = inject(LayoutService);
  nodeId: InputSignal<string> = input.required();

  level: InputSignal<number> = input.required();
  indentMultiplier = 10;
  danger = signal(false);

  rowHeight: InputSignal<number> = input(22);
  maxZIndex: InputSignal<number> = input(100);

  protected childNodes = computed(() => {
    const allNodes = Object.values(this.nodeStore.nodes());
    return allNodes.filter((node) => node.parentId === this.nodeId());
  });
  isChildActive = computed(() => {
    return (
      this.nodeStore.activeNodeId() &&
      Object.values(this.childNodes()).some((v) => v.id === this.nodeStore.activeNodeId())
    );
  });

  protected childFolders = computed(() => this.childNodes().filter((node) => 'children' in node));
  protected childFiles = computed(() => this.childNodes().filter((node) => 'extension' in node));

  uiState = computed(() => {
    return this.nodeStore.explorerUiState()[this.nodeStore.nodes()[this.nodeId()].id];
  });
  isActive = computed(() => {
    return this.nodeStore.nodes()[this.nodeId()].id == this.nodeStore.activeNodeId();
  });

  isSelected = computed(() => this.nodeStore.selectedNodeIds().includes(this.nodeId()));
  isCut = computed(() => this.nodeStore.isCutNode(this.nodeId()));
  isRenaming = computed(() => this.nodeStore.renamingNodeId() === this.nodeId());

  folderBadge = computed(() => this.git.folderBadge(this.nodeStore.nodes()[this.nodeId()].path));

  constructor() {
    effect(async () => {
      if (this.uiState().isExpanded) await this.nodeStore.fetchFolderContents(this.nodeId());
    });
  }

  onClick(event: MouseEvent) {
    if (this.isRenaming()) return;
    if (event.ctrlKey || event.metaKey) return this.nodeStore.selectNode(this.nodeId(), 'toggle');
    if (event.shiftKey) return this.nodeStore.selectNode(this.nodeId(), 'range');
    this.nodeStore.selectNode(this.nodeId(), 'single');
    void this.toggleFolder();
  }

  async toggleFolder() {
    const id = this.nodeId();
    this.nodeStore.toggleFolderExpansion(id); // instant feedback
    // Safe to call on every open: the store skips folders that are already loaded and shares in-flight scans.
  }

  newNodeNameChange(nodeName: string) {
    this.danger.set(
      Object.values(this.childNodes()).filter((node) => node.name == nodeName).length > 0,
    );
  }

  saveNewNode(nodeName: string, mode: InlineCreationMode) {
    this.nodeStore.submitInlineCreation(nodeName, mode, this.nodeStore.nodes()[this.nodeId()].id);
  }

  statusColor() {
    return this.folderBadge() ? statusStyle(<any>this.folderBadge()!.letter).color : 'inherit';
  }
  statusBg() {
    return this.folderBadge() ? statusStyle(<any>this.folderBadge()!.letter).background : 'inherit';
  }

  get indentStyle() {
    return {
      'padding-left': `${this.level() * this.indentMultiplier + 5}px`,
    };
  }

  get lineIndentStyle() {
    return {
      left: `${this.level() * this.indentMultiplier + 10}px`,
      'z-index': `${this.maxZIndex() - this.level() - 1}`,
    };
  }
  get stickyStyles() {
    return {
      top: `${this.level() * this.rowHeight()}px`,
      'z-index': `${this.maxZIndex() - this.level()}`,
    };
  }
}
