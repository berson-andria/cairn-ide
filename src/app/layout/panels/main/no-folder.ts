import { Component, inject } from '@angular/core';
import { EditorCommands } from '../../../feature/editor/editor.commands';
import { NodeStore } from '../../../core/store/node.store';
import { ProjectHistoryService } from '../../../core/services/project-history.service';
import { getFileNameFromPath } from '../../../shared/utils/node.utils';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideX } from '@ng-icons/lucide';

@Component({
  selector: 'no-folder',
  template: `
    <div style="flex:1;display:flex;min-height:0">
      <div style="flex:1;display:flex;justify-content:center;padding-top:150px">
        <div style="width:520px">
          <div style="font-size:32px;font-weight:600;line-height:1.2">Open a folder to begin</div>
          <div class="s" style="font-size:14px;margin:12px 0 24px;line-height:1.55">
            Praide keeps tasks and notes as plain files in a .ide folder inside your project, so
            they travel with your git history.
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn-primary" (click)="commands.openFolder()">Open Folder</button>
            <button class="btn-primary" (click)="openFile()">Open File</button>
            <button class="btn-primary" (click)="commands.newWindow()">New Window</button>
          </div>
          @if (history.history().projects.length) {
            <div class="s" style="letter-spacing:.08em;text-transform:uppercase;margin:34px 0 4px">
              Recent
            </div>
            @for (project of history.history().projects; track project.path) {
              <div class="action-list">
                <button
                  type="button"
                  [disabled]="project.missing"
                  (click)="openRecent(project.path)"
                >
                  {{ project.name }}
                  @if (project.missing) {
                    <span class="s">(Missing)</span>
                  }
                </button>
                <span class="s">{{ path(project.path, project.name) }}</span>
                <button
                  class="icon-btn"
                  type="button"
                  [disabled]="project.missing"
                  style="margin-left: auto;"
                  [attr.aria-label]="'Open ' + project.name + ' in new window'"
                  [title]="'Open ' + project.name + ' in new window'"
                  (click)="commands.newWindow(project.path)"
                >
                  <ng-icon name="lucideExternalLink" />
                </button>
                <button
                  class="icon-btn"
                  type="button"
                  [attr.aria-label]="'Remove ' + project.name + ' from history'"
                  (click)="history.remove(project.path)"
                >
                  <ng-icon name="lucideX" />
                </button>
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
      color: var(--color-text-muted);
      font-size: 12px;
    }
    .action-list {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: var(--space-6);
    }
  `,
  imports: [NgIcon],
  providers: [provideIcons({ lucideX, lucideExternalLink })],
})
export class NoFolderOpen {
  readonly commands = inject(EditorCommands);
  readonly nodeStore = inject(NodeStore);
  readonly history = inject(ProjectHistoryService);
  getFileNameFromPath = getFileNameFromPath;

  protected path(path: string, fileName: string) {
    const folder = path.substring(0, path.lastIndexOf(fileName) - 1);
    console.log(folder);
    return folder;
  }

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
