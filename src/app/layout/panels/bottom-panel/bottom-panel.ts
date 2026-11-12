import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';
import { Git, GitView } from '../../../feature/git/git';
import { Terminal } from '../../../feature/terminal/terminal';
import { DiagnosticsService } from '../../../core/services/diagnostics.service';
import { TerminalService } from '../../../feature/terminal/terminal.service';
import { NodeStore } from '../../../core/store/node.store';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideCloudUpload,
  lucideEllipsis,
  lucideGitBranch,
  lucideMinus,
  lucidePlus,
  lucideRefreshCcw,
  lucideRotateCcw,
  lucideUnlink,
} from '@ng-icons/lucide';
import { LayoutService } from '../../../core/services/layout.service';
import { GitResult, GitService } from '../../../feature/git/services/git.service';
import { Problems } from '../../../feature/problems/problems';

import { MenuDirective } from '../../../shared/directives/menu.directive';
import { forkJoin, from, of, switchMap } from 'rxjs';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { convertToDaysAndHours } from '../../../shared/utils/utils';
import { GitBranch } from '../../../feature/git/parser/branch.parser';
import { GitNoticeManager } from '../../../feature/git/ui/git-notice';
import { firstLine, GitUiFile } from '../../../feature/git/ui/git-ui';
import {
  GitDialogService,
  OverwriteStrategy,
} from '../../../feature/git/services/git-dialog.service';
import { confirmAction } from '../../../feature/git/ui/git-dialogs';
import { plural } from '../../../feature/git/features/dialogs/dialog-shared';
import { GitCommitService } from '../../../feature/git/services/git-commit.service';

@Component({
  selector: 'bottom-panel',
  standalone: true,
  imports: [ResizeHandle, Terminal, Git, Problems, NgIcon, MenuDirective],
  templateUrl: './bottom-panel.html',
  styleUrl: './bottom-panel.scss',
  host: {
    '[style.height.px]': 'height()',
    '[class.collapsed]': 'layoutService.isBottomPanelCollapsed()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    provideIcons({
      lucidePlus,
      lucideMinus,
      lucideGitBranch,
      lucideRotateCcw,
      lucideRefreshCcw,
      lucideEllipsis,
      lucideChevronRight,
      lucideUnlink,
      lucideCloudUpload,
    }),
  ],
})
export class BottomPanel {
  protected readonly layoutService = inject(LayoutService);
  protected readonly nodeStore = inject(NodeStore);
  protected readonly git = inject(GitService);
  private readonly commits = inject(GitCommitService);
  protected readonly dialogs = inject(GitDialogService);
  protected readonly height = signal<number | null>(null);
  protected readonly minHeight = 100;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly maxHeight = () => this.host.nativeElement.parentElement!.clientHeight * 0.7;
  protected activeGitView: GitView = 'Changes';

  protected readonly terminals = inject(TerminalService);
  private readonly injector = inject(Injector);
  protected readonly counts = inject(DiagnosticsService).counts;

  filterProblems = signal('');
  branchFilter = signal('');
  newBranch = signal('');
  branchError = signal<string | null>(null);
  readonly pickerOpen = signal(false);

  notice = signal<{ kind: 'error' | 'info'; text: string } | null>(null);
  private noticeManager = new GitNoticeManager(this.notice);

  gitBranchName = computed(() => {
    const status = this.git.status();
    return status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch');
  });
  gitChangesCount = computed(() => {
    const staged = this.git.staged();
    const unstaged = this.git.unstaged();
    return staged.length + unstaged.length;
  });

  conflictFiles = computed<GitUiFile[]>(() =>
    this.git.conflicts().map((f) => ({ path: f.path, status: '!', source: f, mode: 'unstaged' })),
  );
  convertToDaysAndHours = convertToDaysAndHours;
  constructor() {
    effect(() => {
      const terminalVisible =
        this.layoutService.isToolkitActive('Terminal') &&
        !this.layoutService.isBottomPanelCollapsed();
      if (terminalVisible) {
        afterNextRender(() => this.terminals.activeSession()?.term.focus(), {
          injector: this.injector,
        });
      }
    });
    effect(() => {
      if (!this.pickerOpen()) return; // closed: no git calls
      this.git.statusVersion();
      untracked(() => void this.git.loadBranches());
    });
  }

  protected createNewSession(): void {
    void this.terminals.create(this.nodeStore.rootPath());
  }

  protected onFilterProblems(event: Event): void {
    this.filterProblems.set((event.target as HTMLInputElement).value);
  }

  async pull() {
    this.runAction(this.git.pull.bind(this.git), 'Pulled');
    // const result = await ;
    // this.noticeManager.report(result, firstLine(result.output) || 'Pulled.');
  }

  // ───────────── branches ─────────────
  readonly branchNameQuery = signal('');

  /** Branches matching the search box. Everything below derives from this. */
  private readonly filtered = computed(() => {
    const q = this.branchNameQuery().trim().toLowerCase();
    const all = this.git.branchList();
    return q.length ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
  });

  /** Local branches, with the current one pinned to the top. */
  readonly local = computed(() =>
    this.filtered()
      .filter((b) => !b.remote)
      .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)),
  );
  readonly remote = computed(() =>
    this.filtered()
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
  toggleBranchPicker() {
    this.pickerOpen.update((v) => !v);
  }

  onSearchBranch(event: Event) {
    this.branchNameQuery.set((event.target as HTMLInputElement).value);
  }

  readonly needsPublish = computed(() => {
    const s = this.git.status();
    return !!s?.branch && !s.upstream;
  });
  async checkoutTo() {
    await this.git.loadBranches();
    const name = await this.dialogs.pickBranch(
      'Checkout to',
      this.git.branchList().filter((b) => !b.current),
      {
        submitLabel: 'Checkout',
      },
    );
    const branch = this.git.branchList().find((b) => b.name === name);
    if (!branch) return;
    this.switchTo(branch);
  }

  async createBranch(fromPicker = false) {
    let from: string | undefined;
    if (fromPicker) {
      await this.git.loadBranches();
      from = await this.dialogs.pickBranch('Create branch from', this.git.branchList(), {
        submitLabel: 'Next',
        message: 'Pick the starting point.',
      });
      if (!from) return;
    }
    const name = await this.dialogs.branchName('Create branch', 'Create', {
      message: from ? `Starting from ${from}.` : undefined,
    });
    if (name)
      await this.runAction(() => this.git.createBranch(name, { from }), `Switched to ${name}.`);
  }

  async mergeBranch() {
    await this.git.loadBranches();
    const current = this.git.status()?.branch;
    const name = await this.dialogs.pickBranch(
      'Merge branch',
      this.git.branchList().filter((b) => !b.current),
      {
        submitLabel: 'Merge',
        message: `Merge into ${current}.`,
      },
    );
    if (name) await this.runAction(() => this.git.merge(name), `Merged ${name}.`);
  }

  async deleteBranch() {
    await this.git.loadBranches();
    const local = this.git.branchList().filter((b) => !b.current && !b.remote);
    const name = await this.dialogs.pickBranch('Delete branch', local, {
      submitLabel: 'Delete',
      danger: true,
    });
    if (!name) return;
    await this.runAction(async () => {
      const r = await this.git.deleteBranch(name);
      if (r.ok || !/not fully merged/i.test(r.error)) return r;
      const force = await confirmAction(
        `"${name}" has commits that are not merged. Delete anyway?`,
        'Delete',
      );
      return force ? this.git.deleteBranch(name, true) : r;
    }, `Deleted ${name}.`);
  }

  async switchTo(branch: GitBranch) {
    const twin = branch.remote
      ? this.git
          .branchList()
          .find((b) => !b.remote && b.name === branch.name.slice(branch.name.indexOf('/') + 1))
      : undefined;
    const target = twin ?? branch;
    const result = await this.git.switchTo(target);
    if (result.ok || result.code !== 'overwrite') {
      this.noticeManager.report(result, `Switched to ${target.name}.`);
      return;
    }

    const strategy = await this.dialogs.overwriteStrategy(target.name);
    if (!strategy) return; // cancelled: nothing was changed
    if (
      strategy === 'force' &&
      !(await confirmAction(
        'Discard your local changes and switch? This cannot be undone.',
        'Force Checkout',
      ))
    )
      return;

    await this.runAction(() => this.switchWith(target, strategy), `Switched to ${target.name}.`);

    // this.noticeManager.report(await this.git.switchTo(target), `Switched to ${target.name}.`);
  }

  private async switchWith(branch: GitBranch, strategy: OverwriteStrategy): Promise<GitResult> {
    if (strategy === 'force') return this.git.switchTo(branch, { force: true });

    const before = (await this.git.stashes()).length;
    const stashed = await this.git.stash(`Auto-stash before switching to ${branch.name}`, true);
    if (!stashed.ok) return stashed;
    // "No local changes to save" also succeeds: only pop a stash we actually created
    const created = (await this.git.stashes()).length > before;

    const switched = await this.git.switchTo(branch);
    if (!switched.ok) {
      if (created) await this.git.stashPop(0); // put everything back
      return switched;
    }
    return strategy === 'migrate' && created ? this.git.stashPop(0) : switched;
  }

  runAction = async (action: () => Promise<GitResult>, success: string) => {
    await this.noticeManager.runAction(() => this.recoverable(action), success);
  };

  /** Runs the action; if the failure is one a dialog can fix, asks once and retries once. */
  private async recoverable(action: () => Promise<GitResult>): Promise<GitResult> {
    let result = await action();
    if (result.code === 'identity' && (await this.dialogs.identity())) {
      return action();
    }

    if (result.code === 'auth') {
      const signedIn = await this.dialogs.signIn();
      if (signedIn === 'saved') return action();
      if (signedIn === 'no-helper') {
        result = {
          ...result,
          error:
            'Git has no credential helper, so a login cannot be remembered. In a terminal: git config --global credential.helper manager',
        };
      }
      // 'cancelled' / 'ssh' / 'failed': fall through and show git's own error
    }

    if (result.code === 'ssh') {
      result = {
        ...result,
        error: `${result.error}\n\nSSH is used without prompts. Load your key into ssh-agent (ssh-add), connect once in a terminal to trust the host, or use an HTTPS remote.`,
      };
    }
    return result;
  }

  // ── Commit ──────────────────────────────────────────────────────────────────
  // 'staged' = what is staged, 'all' = git commit -a, 'amend' = rewrite the last commit.
  async commit(mode: 'staged' | 'all' | 'amend') {
    return this.commits.commit(mode);
  }

  async undoLastCommit() {
    if (!(await confirmAction('Undo the last commit? Its changes stay staged.', 'Undo Commit')))
      return;
    await this.runAction(() => this.git.undoLastCommit(), 'Last commit undone.');
  }

  // ── Changes ─────────────────────────────────────────────────────────────────
  async discardAll() {
    const count = this.git.unstaged().length;
    if (!count) return;
    const ok = await confirmAction(
      `Discard changes in ${count} file(s)? This cannot be undone.`,
      'Discard',
    );
    if (ok) await this.runAction(() => this.git.discard(this.git.unstaged()), 'Changes discarded.');
  }

  // ── Pull / Push ─────────────────────────────────────────────────────────────
  async pushForce() {
    const ok = await confirmAction(
      'Force push (with lease) overwrites the remote branch. Continue?',
      'Force Push',
    );
    if (ok) await this.runAction(() => this.git.push({ force: true }), 'Force pushed.');
  }
  async pullRebase() {
    const changes = this.git.status()?.files.length ?? 0;
    let autostash = false;

    if (changes) {
      const ok = await confirmAction(
        `You have ${changes} uncommitted ${plural(changes, 'change', 'changes')}. Stash them, pull with rebase, then restore them?`,
        'Stash and Pull',
      );
      if (!ok) return;
      autostash = true;
    }

    await this.runAction(() => this.git.pullRebase(autostash), 'Pulled (rebase).');
  }

  // ── Repository ──────────────────────────────────────────────────────────────
  async clone() {
    const r = await this.dialogs.cloneRepo('~/dev');
    if (!r) return;
    await this.runAction(() => this.git.clone(r.url, r.directory), 'Cloned.');
  }

  async addRemote() {
    const r = await this.dialogs.addRemote();
    if (r) await this.runAction(() => this.git.addRemote(r.name, r.url), `Remote ${r.name} added.`);
  }

  async removeRemote() {
    const remote = await this.dialogs.pickRemote(
      'Remove remote',
      await this.git.remotes(),
      'Remove',
    );
    if (!remote) return;
    if (await confirmAction(`Remove remote "${remote}"?`, 'Remove')) {
      await this.runAction(() => this.git.removeRemote(remote), `Remote ${remote} removed.`);
    }
  }

  // ── Stash ───────────────────────────────────────────────────────────────────
  async stashChanges(includeUntracked = false) {
    const message = await this.dialogs.stashMessage(includeUntracked);
    if (message === undefined) return;
    await this.runAction(() => this.git.stash(message, includeUntracked), 'Changes stashed.');
  }
  async stashLatest(action: 'apply' | 'pop') {
    await this.runAction(
      () => (action === 'apply' ? this.git.stashApply(0) : this.git.stashPop(0)),
      action === 'apply' ? 'Stash applied.' : 'Stash popped.',
    );
  }

  /** 'apply' | 'pop' | 'drop' on a stash picked from the list. */
  async stashPick(action: 'apply' | 'pop' | 'drop') {
    const stashes = await this.git.stashes();
    const picked = await this.dialogs.pick(`${action[0].toUpperCase()}${action.slice(1)} stash`, {
      items: stashes.map((s, i) => ({ value: String(i), label: `stash@{${i}}: ${s.message}` })), // ← adjust to GitStash's field names
      submitLabel: action[0].toUpperCase() + action.slice(1),
      danger: action === 'drop',
      emptyText: 'No stashes.',
    });
    if (picked === undefined) return;
    const index = Number(picked);
    if (
      action === 'drop' &&
      !(await confirmAction(`Drop stash@{${index}}? This cannot be undone.`, 'Drop'))
    )
      return;
    const run = {
      apply: () => this.git.stashApply(index),
      pop: () => this.git.stashPop(index),
      drop: () => this.git.stashDrop(index),
    }[action];
    await this.runAction(run, `Stash ${action} done.`);
  }

  // e.g. (click)="runNetwork(git.push.bind(git), 'Pushed.')"  ·  sync(): runNetwork(() => this.git.sync(), 'Synced.')

  async pullFrom() {
    const remote = await this.dialogs.pickRemote('Pull from', await this.git.remotes(), 'Next');
    if (!remote) return;
    await this.git.loadBranches();
    const remoteBranches = this.git
      .branchList()
      .filter((b) => b.remote && b.name.startsWith(`${remote}/`) && !b.name.endsWith('/HEAD'));
    const picked = await this.dialogs.pickBranch(`Pull from ${remote}`, remoteBranches, {
      submitLabel: 'Pull',
    });
    if (picked)
      await this.runAction(
        () => this.git.pullFrom(remote, picked.slice(remote.length + 1)),
        'Pulled.',
      );
  }

  async pushTo() {
    const remote = await this.dialogs.pickRemote('Push to', await this.git.remotes(), 'Push');
    if (remote) await this.runAction(() => this.git.pushTo(remote), `Pushed to ${remote}.`);
  }

  async publishBranch() {
    const remotes = await this.git.remotes();
    const remote =
      remotes.length === 1
        ? remotes[0]
        : await this.dialogs.pickRemote('Publish branch to', remotes, 'Publish');
    if (remote) await this.runAction(() => this.git.pushTo(remote), 'Branch published.');
  }

  async deleteRemoteBranch() {
    await this.git.loadBranches();
    const remoteBranches = this.git
      .branchList()
      .filter((b) => b.remote && !b.name.endsWith('/HEAD'));
    const name = await this.dialogs.pickBranch('Delete remote branch', remoteBranches, {
      submitLabel: 'Delete',
      danger: true,
    });
    if (!name) return;
    const slash = name.indexOf('/');
    const [remote, branch] = [name.slice(0, slash), name.slice(slash + 1)];
    if (
      await confirmAction(
        `Delete "${branch}" from ${remote}? This affects everyone using it.`,
        'Delete',
      )
    ) {
      await this.runAction(() => this.git.deleteRemoteBranch(remote, branch), `Deleted ${name}.`);
    }
  }

  async rebaseBranch() {
    await this.git.loadBranches();
    const name = await this.dialogs.pickBranch(
      'Rebase branch',
      this.git.branchList().filter((b) => !b.current),
      {
        submitLabel: 'Rebase',
        message: `Rebase ${this.git.status()?.branch} onto:`,
      },
    );
    if (name) await this.runAction(() => this.git.rebase(name), `Rebased onto ${name}.`);
  }

  async renameBranch() {
    const current = this.git.status()?.branch;
    if (!current) return;
    const name = await this.dialogs.branchName('Rename branch', 'Rename', { initial: current });
    if (name && name !== current)
      await this.runAction(() => this.git.renameBranch(current, name), `Renamed to ${name}.`);
  }

  async checkoutDetached() {
    await this.git.loadBranches();
    const ref = await this.dialogs.pickBranch(
      'Checkout detached',
      this.git.branchList().filter((b) => !b.current),
      { submitLabel: 'Checkout' },
    );
    if (ref) await this.runAction(() => this.git.checkoutDetached(ref), `Detached at ${ref}.`);
  }

  async dropAllStashes() {
    if (await confirmAction('Drop ALL stashes? This cannot be undone.', 'Drop All')) {
      await this.runAction(() => this.git.stashDropAll(), 'All stashes dropped.');
    }
  }

  async sync() {
    const upstream = this.git.status()?.upstream; // e.g. "origin/dev"
    if (!upstream) return;

    const ok = await confirmAction(
      `This action will pull and push commits from and to "${upstream}".`,
      'OK',
    );
    if (ok) await this.runAction(() => this.git.sync(), 'Synced.');
  }
}
