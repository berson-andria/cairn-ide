import { Component, inject, input } from '@angular/core';
import { NodeStore } from '../../core/store/node.store';
import { NoOpenFolder } from './no-git/no-git-folder';
import { NoRepository } from './no-git/no-repository';
import { GitGraph } from './graph/git-graph';
import { GitChanges } from './changes/git-changes';
import { GitService } from './services/git.service';
export type GitView = 'Graph' | 'Changes';
@Component({
  selector: 'app-git',
  templateUrl: './git.html',
  imports: [NoOpenFolder, NoRepository, GitGraph, GitChanges],
  styles: `
    :host {
      flex: 1;
      display: flex;
      justify-content: center;
    }
  `,
})
export class Git {
  nodeStore = inject(NodeStore);
  git = inject(GitService);
  activeView = input.required<GitView>();
}
