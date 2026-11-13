import { Component, inject } from '@angular/core';
import { EditorCommands } from '../../../editor/editor.commands';
import { GitClient } from '../../services/git-client.service';

@Component({
  selector: 'git-no-repository',
  template: `
    <div class="m">
      <div style="font-size:15px;font-weight:600">This folder isn't a Git repository</div>
      <div class="s" style="max-width:600px">
        Cairn uses Git to show you what a task changed before you approve it, and to keep your own
        history. Tasks and notes still work without it.
      </div>
      <div
        style="display:flex;gap: var(--space-6);
  flex-wrap: wrap;"
      >
        <button class="btn-action full_width" (click)="clone()">Initialize repository</button>
        <button class="btn-primary full_width" (click)="commands.openFolder()">
          Choose another folder
        </button>
      </div>
      <div class="s" style="margin-top:10px;font-size:11px">
        Running a task stays disabled until a repository exists.
      </div>
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
    .s {
      color: #a39b8b;
      font-size: 12px;
      line-height: 1.55;
      margin: 1em 0;
    }
    button {
      max-width: 300px;
    }
  `,
})
export class NoRepository {
  protected readonly commands = inject(EditorCommands);
  readonly gitClient = inject(GitClient);

  async clone() {
    const r = await this.gitClient.cloneRepo('~/dev');
  }
}
