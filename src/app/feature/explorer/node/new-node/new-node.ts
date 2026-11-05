import { CommonModule, NgClass, NgStyle } from '@angular/common';
import { Component, inject, input, InputSignal, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NodeStore } from '../../../../core/store/node.store';
import { indentStyle } from '../../../../shared/utils/node.utils';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { FileIcon } from '../../../../shared/components/file-icon';
import { ItemType } from '../../../../shared/utils/icon-theme';

@Component({
  selector: 'new-node',
  template: `
    <div class="node-row file" [ngStyle]="indentStyle()" [ngClass]="{ 'add-node': display() }">
      <span class="accordion">
        @if (nodeType() === 'folder') {
          <ng-icon name="bootstrapChevronRight" />
        }
      </span>
      <file-icon [name]="nodeName" [type]="nodeType()" />
      <div class="node-name input-form">
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
      height: 22px; /* Locked structural row height matches TS calculation */
      box-sizing: border-box;
      border-radius: 0.25em;
      width: 100% !important;
      gap: 0.25em;
      cursor: pointer;
      background-color: var(--color-surface-panel);
      &.is-active {
        background-color: var(--color-surface-hover);
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
        background-color: var(--color-error-bg);
        border-radius: 0.25em;
        color: var(--color-error-fg);
        font-size: smaller;
      }
    }
    .is-danger {
      border-color: var(--color-warning-bg);
    }
    .accordion {
      width: 16px;
    }
    input {
      width: 100%;
    }
  `,
  imports: [NgStyle, FormsModule, NgClass, NgIcon, CommonModule, FileIcon],
  providers: [provideIcons({ bootstrapChevronRight })],
})
export class NewNode {
  nodeStore = inject(NodeStore);

  level = input(0);
  nodeType: InputSignal<ItemType> = input.required();
  display = input.required();
  danger = signal(false);

  save = output<string>();
  nodeName = '';
  indentStyle() {
    return indentStyle(this.level(), 10);
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
