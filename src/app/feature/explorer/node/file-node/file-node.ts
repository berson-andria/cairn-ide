import { NgClass, NgStyle } from '@angular/common';
import { Component, computed, inject, input, InputSignal, OnInit } from '@angular/core';
import { NodeDndDirective } from '../node-dnd.directive';
import { RenameNode } from '../rename-node/rename-node';
import { NodeStore } from '../../../../core/store/node.store';
import { indentStyle } from '../../../../shared/utils/node.utils';
import { EditorCommands } from '../../../editor/editor.commands';
import { EditorService } from '../../../editor/services/editor.service';
import { FileIcon } from '../../../../shared/components/file-icon';

@Component({
  selector: 'file-node',
  templateUrl: './file-node.html',
  styleUrl: '../node.scss',
  imports: [NgClass, NgStyle, RenameNode, NodeDndDirective, FileIcon],
})
export class FileNode {
  nodeStore = inject(NodeStore);
  commands = inject(EditorCommands);
  editorService = inject(EditorService);

  nodeId: InputSignal<string> = input.required();

  level: InputSignal<number> = input.required();
  indentMultiplier = 10;

  isActive = computed(() => {
    return this.nodeId() == this.nodeStore.activeNodeId();
  });
  isSelected = computed(() => this.nodeStore.selectedNodeIds().includes(this.nodeId()));
  isCut = computed(() => this.nodeStore.isCutNode(this.nodeId()));
  isRenaming = computed(() => this.nodeStore.renamingNodeId() === this.nodeId());
  fetched = false;

  indentStyle() {
    return indentStyle(this.level(), 10);
  }

  onClick(event: MouseEvent) {
    if (this.isRenaming()) return;
    if (event.ctrlKey || event.metaKey) return this.nodeStore.selectNode(this.nodeId(), 'toggle');
    if (event.shiftKey) return this.nodeStore.selectNode(this.nodeId(), 'range');
    this.nodeStore.selectNode(this.nodeId(), 'single');
    void this.openFile();
  }

  onDoubleClick() {
    // void this.openFile();
  }

  async openFile() {
    const id = this.nodeId();
    if (!this.fetched && !this.editorService.hasModel(id)) {
      await this.nodeStore.fetchFileContent(id);
      this.fetched = true;
    }
    this.commands.openFile(id);
  }
}
