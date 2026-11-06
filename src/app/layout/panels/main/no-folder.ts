import { Component, inject } from '@angular/core';
import { EditorCommands } from '../../../feature/editor/editor.commands';
import { NodeStore } from '../../../core/store/node.store';

@Component({
  selector: 'no-folder',
  template: `
    <div style="flex:1;display:flex;min-height:0">
      <div style="flex:1;display:flex;justify-content:center;padding-top:150px">
        <div style="width:520px">
          <div style="font-size:32px;font-weight:600;line-height:1.2">Open a folder to begin</div>
          <div class="s" style="font-size:14px;margin:12px 0 24px;line-height:1.55">
            Cairn keeps tasks and notes as plain files in a .ide folder inside your project, so they
            travel with your git history.
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn-primary" (click)="commands.openFolder()">Open Folder</button
            ><button class="btn-primary" (click)="openFile()">Open File</button
            ><button class="btn-primary">New Window</button>
          </div>
          <div class="s" style="letter-spacing:.08em;text-transform:uppercase;margin:34px 0 4px">
            Recent
          </div>
          <div class="action-list">
            <span>auth-client</span><span class="s">~/dev/auth-client</span>
          </div>
          <div class="action-list">
            <span>cairn-ide</span><span class="s">~/dev/cairn-ide</span>
          </div>
          <div class="action-list">
            <span>portfolio-site</span><span class="s">~/dev/portfolio-site</span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      height: 100%;
      width: 100%;
    }
    .s {
      color: #a39b8b;
      font-size: 12px;
    }
  `,
})
export class NoFolderOpen {
  readonly commands = inject(EditorCommands);
  readonly nodeStore = inject(NodeStore);

  async openFile() {
    const files = await this.nodeStore.addStandaloneFiles();
    for (const id of files) {
      this.commands.openFile(id);
    }
  }
}
