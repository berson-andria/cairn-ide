import { Component, inject } from '@angular/core';
import { EditorCommands } from '../../../editor/editor.commands';
import { GitDialogService } from '../../services/git-dialog.service';
import { GitClient } from '../../services/git-client.service';

@Component({
  selector: 'git-no-folder',
  template: `
    <div class="m">
      <div style="font-size:15px;font-weight:600">No folder open</div>
      <div class="s" style="margin:8px 0">Open a folder to see its changes.</div>
      <button class="btn-action full_width" (click)="commands.openFolder()">Open Folder</button>
      <button class="btn-primary full_width" style="margin-top: var(--space-10);" (click)="clone()">
        Clone Repository
      </button>
    </div>
  `,
  styles: `
    :host {
      width: 100%;
      height: 100%;
    }
    .m {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 40px;
      margin: auto;
    }
    button {
      max-width: 300px;
    }
    .s {
      color: var(--color-text-faint);
      font-size: var(--font-size-ui);
      line-height: 1.55;
    }
  `,
})
export class NoOpenFolder {
  protected readonly commands = inject(EditorCommands);
  readonly gitClient = inject(GitClient);

  async clone() {
    const r = await this.gitClient.cloneRepo('~/dev');
    if (!r) return;
  }
}
