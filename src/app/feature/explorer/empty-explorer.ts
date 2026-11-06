import { Component, inject } from '@angular/core';
import { EditorCommands } from '../editor/editor.commands';

@Component({
  selector: 'empty-explorer',
  template: `
    <div style="padding:50px 18px;text-align:center">
      <div style="font-size:14px;font-weight:500">No folder open</div>
      <div style="color:#A39B8B;font-size:12px;margin:8px 0 18px;line-height:1.55">
        Open a project to see its tasks, files, notes and reviews.
      </div>
      <button class="btn-action full_width" (click)="command.openFolder()">Open Folder</button
      ><button class="btn-primary full_width" style="margin-top: var(--space-10);">
        Clone Repository
      </button>
    </div>
  `,
})
export class EmptyExplorer {
  readonly command = inject(EditorCommands);
}
