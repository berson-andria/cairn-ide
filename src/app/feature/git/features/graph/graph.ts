import { Component, inject } from '@angular/core';
import { NodeStore } from '../../../../core/store/node.store';
import { GitService } from '../../services/git.service';
import { NoRepository } from '../no-git/no-repository';
import { NoOpenFolder } from '../no-git/no-git-folder';

@Component({
  selector: 'git-graph',
  templateUrl: './graph.html',
  styleUrl: './graph.scss',
  imports: [NoRepository, NoOpenFolder],
})
export class GitGraph {
  protected readonly git = inject(GitService);
  protected readonly nodeStore = inject(NodeStore);
}
