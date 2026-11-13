import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { GitService } from '../../services/git.service';
import { NodeStore } from '../../../../core/store/node.store';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, of, from, forkJoin } from 'rxjs';
import { convertToDaysAndHours } from '../../../../shared/utils/utils';
import { GitClient } from '../../services/git-client.service';
import { LayoutService } from '../../../../core/services/layout.service';
import {
  lucidePlus,
  lucideUnlink,
  lucideGitBranch,
  lucideCloudCheck,
  lucideTrash,
} from '@ng-icons/lucide';
import { GitBranch } from '../../parser/branch.parser';
import { DialogRef } from '@angular/cdk/dialog';

@Component({
  templateUrl: './branch.html',
  styleUrl: './branch.scss',
  imports: [NgIcon],
  providers: [
    provideIcons({ lucidePlus, lucideUnlink, lucideGitBranch, lucideCloudCheck, lucideTrash }),
  ],
})
export class GitBranchComponent {
  private readonly ref = inject<DialogRef<string | undefined>>(DialogRef);
  protected readonly git = inject(GitService);
  protected readonly gitClient = inject(GitClient);
  protected readonly nodeStore = inject(NodeStore);
  protected readonly layout = inject(LayoutService);

  readonly branchNameQuery = signal('');

  /** Branches matching the search box. Everything below derives from this. */
  private readonly visibleBranches = computed(() => {
    const all = this.git.branchList();
    const query = this.branchNameQuery().trim().toLowerCase();
    const tracked = new Set(all.filter((b) => !b.remote && b.upstream).map((b) => b.upstream));
    return all
      .filter((b) => !(b.remote && tracked.has(b.name)))
      .filter((b) => !query || b.name.toLowerCase().includes(query));
  });

  /** Local branches, with the current one pinned to the top. */
  readonly local = computed(() =>
    this.visibleBranches()
      .filter((b) => !b.remote)
      .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)),
  );
  readonly remote = computed(() =>
    this.visibleBranches()
      .filter((b) => b.remote && !b.name.endsWith('/HEAD'))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  readonly remoteCommitDetails = toSignal(
    toObservable(this.remote).pipe(
      switchMap((branches) => {
        if (!branches || branches.length === 0) return of([]);

        // Maps branches to their respective Git async tasks
        const detailTasks = branches.map((b) => from(this.git.commitDetails(b.hash)));

        return forkJoin(detailTasks);
      }),
    ),
    { initialValue: [] },
  );
  readonly localCommitDetails = toSignal(
    toObservable(this.local).pipe(
      switchMap((branches) => {
        if (!branches || branches.length === 0) return of([]);

        // Maps branches to their respective Git async tasks
        const detailTasks = branches.map((b) => from(this.git.commitDetails(b.hash)));

        return forkJoin(detailTasks);
      }),
    ),
    { initialValue: [] },
  );
  readonly isEmpty = computed(() => this.local().length === 0 && this.remote().length === 0);
  // branches = signal<GitBranch[]>([]);
  // branchFilter = signal('');
  // newBranch = signal('');
  // branchError = signal<string | null>(null);

  convertToDaysAndHours = convertToDaysAndHours;
  constructor() {
    effect(() => {
      // if (!this.layout.is()) return; // closed: no git calls
      this.git.statusVersion();
      untracked(() => void this.git.loadBranches());
    });
  }

  onSearchBranch(event: Event) {
    this.branchNameQuery.set((event.target as HTMLInputElement).value);
  }
  async switchTo(branch: GitBranch) {
    await this.gitClient.switchTo(branch);
    this.ref.close();
  }
}
