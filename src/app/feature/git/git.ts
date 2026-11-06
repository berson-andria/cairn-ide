import { Component, inject, input } from '@angular/core';
import { NodeStore } from '../../core/store/node.store';
import { NoOpenFolder } from './features/no-git/no-git-folder';
import { NoRepository } from './features/no-git/no-repository';
import { GitGraph } from './features/graph/git-graph';
import { GitChanges } from './features/changes/git-changes';
import { GitService } from './services/git.service';
export type GitView = 'Graph' | 'Changes';
@Component({
  selector: 'app-git',
  templateUrl: './git.html',
  imports: [NoOpenFolder, NoRepository, GitGraph, GitChanges],
  styles: `
    :host {
      height: 100%;
    }
  `,
})
export class Git {
  nodeStore = inject(NodeStore);
  git = inject(GitService);
  activeView = input.required<GitView>();
}
