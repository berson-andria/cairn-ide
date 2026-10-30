import { CommonModule, NgClass, NgStyle } from '@angular/common';
import { Component, inject, input, InputSignal, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorkspaceNodeStore } from '../../../../core/store/workspace/workspace.store';
import { indentStyle, getIconName } from '../../../../shared/utils/node.utils';

@Component({
  selector: 'new-node',
  template: `
    <div class="node-row file" [ngStyle]="indentStyle()" [ngClass]="{ 'add-node': display() }">
      <span class="accordion"></span>
      <span>
        <img
          [src]="'assets/node-icons/' + getIconName() + '.svg'"
          class="node-icon"
          alt="node-icon"
        />
      </span>
      <div class="node-name">
        <input
          type="text"
          [(ngModel)]="nodeName"
          (ngModelChange)="nodeNameEntry($event)"
          (keydown.enter)="saveNode()"
          (blur)="closeForm()"
          [ngClass]="{ 'is-danger': danger() }"
        />
        @if (danger()) {
          <span class="alert">
            @if (danger() && nodeName.length > 0) {
              A file/folder with the name <b>{{ nodeName }}</b> already exist in this location.
              Please choose another name.
            } @else {
              {{ nodeType() | titlecase }} name can't be empty
            }
          </span>
        }
      </div>
    </div>
  `,
  styles: `
    .node-row {
      display: flex;
      align-items: center;
      height: 22px;
      box-sizing: border-box;
      color: var(--explorer-text);
      cursor: pointer;
      background-color: var(--explorer-bg);
      &.is-active {
        background-color: var(--explorer-item-hover-bg);
      }
    }
    .node-name {
      position: relative;
      width: 100%;
      margin: 0;
      padding: 0;
      .alert {
        position: absolute;
        top: 105%;
        left: 0;
        padding: 0.5em;
        background-color: #9f2732;
        border: 1px solid #ff001b;
        border-radius: 0.25em;
        color: white;
        font-size: smaller;
      }
    }
    .is-danger {
      border-color: #d73445;
    }
    .accordion {
      width: 16px;
    }
    input {
      width: 100%;
    }
  `,
  imports: [NgStyle, FormsModule, NgClass, CommonModule],
})
export class NewNode {
  nodeStore = inject(WorkspaceNodeStore);

  level = input(0);
  nodeType: InputSignal<string> = input.required();
  display = input.required();
  danger = signal(false);

  save = output<string>();
  nodeName = '';
  indentStyle() {
    return indentStyle(this.level(), 10);
  }
  getIconName() {
    return getIconName(this.nodeName, this.nodeType(), false);
  }
  nodeNameEntry(value: string) {
    this.danger.set(
      Object.values(this.nodeStore.rootNodes()).filter((node) => node.name === value).length > 0,
    );
  }

  saveNode() {
    if (!this.danger()) {
      this.save.emit(this.nodeName);
      this.closeForm();
    }
  }

  closeForm() {
    this.nodeName = '';
    this.nodeStore.closeInlineCreationForm();
  }
}
