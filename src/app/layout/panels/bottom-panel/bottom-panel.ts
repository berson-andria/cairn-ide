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
  lucideEllipsis,
  lucideGitBranch,
  lucideMinus,
  lucidePlus,
  lucideRotateCcw,
} from '@ng-icons/lucide';
import { LayoutService } from '../../../core/services/layout.service';
import { GitResult, GitService } from '../../../feature/git/services/git.service';
import { Problems } from '../../../feature/problems/problems';
import {
  editGitIdentity,
  firstLine,
  GitNoticeManager,
  GitUiFile,
  openGitIdentityDialog,
} from '../../../feature/git/git.helper';
import { MenuDirective } from '../../../shared/directives/menu.directive';
import { GitBranch } from '../../../feature/git/parser/git-parsers';
import { forkJoin, from, of, switchMap } from 'rxjs';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { convertToDaysAndHours } from '../../../shared/utils/utils';

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
      lucideEllipsis,
      lucideChevronRight,
    }),
  ],
})
export class BottomPanel {
  protected readonly layoutService = inject(LayoutService);
  protected readonly nodeStore = inject(NodeStore);
  protected readonly git = inject(GitService);
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
    this.git.conflicts().map((f) => ({ path: f.path, status: '!', source: f })),
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
    const result = await this.git.pull();
    this.noticeManager.report(result, firstLine(result.output) || 'Pulled.');
  }

  // ───────────── branches ─────────────
  readonly query = signal('');

  /** Branches matching the search box. Everything below derives from this. */
  private readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
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

  onSearch(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  async switchTo(branch: GitBranch) {
    // Git refuses when local changes would be overwritten; its message says which files.
    this.noticeManager.report(await this.git.switchTo(branch), `Switched to ${branch.name}.`);
  }

  async createBranch() {
    const name = this.newBranch().trim();
    const invalid = await this.git.checkBranchName(name);
    if (invalid) return this.branchError.set(invalid);

    const result = await this.git.createBranch(name);
    if (!result.ok) return this.branchError.set(result.error);
    this.noticeManager.report(result, `Created and switched to ${name}.`);
  }

  private async askForIdentity(): Promise<boolean> {
    return openGitIdentityDialog();
  }

  /** "Git identity…" in the menu: change it any time, not only after a failed commit. */
  async editIdentity() {
    await editGitIdentity(this.notice);
  }

  runAction = async (action: () => Promise<GitResult>, success: string) => {
    await this.noticeManager.runAction(action, success);
  };
}
