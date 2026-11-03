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
      <button
        style="font:inherit;font-size:13px;padding:8px 16px;border-radius:6px;cursor:pointer;width:100%;background:#E8E2D6;color:#1C1A17;border:0;font-weight:600"
        (click)="command.openFolder()"
      >
        Open Folder</button
      ><button
        style="font:inherit;font-size:13px;padding:8px 16px;border-radius:6px;cursor:pointer;width:100%;background:none;color:#E8E2D6;border:1px solid #4A443A;margin-top:8px"
      >
        Clone Repository
      </button>
    </div>
  `,
})
export class EmptyExplorer {
  readonly command = inject(EditorCommands);
}
