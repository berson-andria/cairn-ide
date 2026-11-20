import { Component, inject } from '@angular/core';
import { EditorCommands } from '../../../feature/editor/editor.commands';
import { NodeStore } from '../../../core/store/node.store';
import { ProjectHistoryService } from '../../../core/services/project-history.service';

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
            <button class="btn-primary" (click)="commands.openFolder()">Open Folder</button>
            <button class="btn-primary" (click)="openFile()">Open File</button>
            <button class="btn-primary" (click)="commands.newWindow()">New Window</button>
          </div>
          @if (history.history().projects.length) {
            <div class="s" style="letter-spacing:.08em;text-transform:uppercase;margin:34px 0 4px">
              Recent
              <button class="s" type="button" (click)="history.clear()">Clear</button>
            </div>
            @for (project of history.history().projects; track project.path) {
              <div class="action-list">
                <button type="button" [disabled]="project.missing" (click)="openRecent(project.path)">
                  {{ project.name }} @if (project.missing) { <span class="s">(Missing)</span> }
                </button>
                <span class="s">{{ project.path }}</span>
                <button
                  type="button"
                  [disabled]="project.missing"
                  [attr.aria-label]="'Open ' + project.name + ' in new window'"
                  (click)="commands.newWindow(project.path)"
                >New window</button>
                <button
                  type="button"
                  [attr.aria-label]="'Remove ' + project.name + ' from history'"
                  (click)="history.remove(project.path)"
                >Remove</button>
              </div>
            }
          }
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
  readonly history = inject(ProjectHistoryService);

  openRecent(path: string): void {
    void this.commands.openProject(path);
  }

  async openFile() {
    const files = await this.nodeStore.addStandaloneFiles();
    for (const id of files) {
      this.commands.openFile(id);
    }
  }
}
