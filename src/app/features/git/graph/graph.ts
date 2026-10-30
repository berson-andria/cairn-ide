import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { bootstrapSave } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideCheck,
  lucideChevronDown,
  lucideEllipsis,
  lucideFile,
  lucideGitBranch,
  lucideGitCommitHorizontal,
  lucideMinus,
  lucidePlus,
  lucideRefreshCcw,
  lucideUndo,
} from '@ng-icons/lucide';
import { ask } from '@tauri-apps/plugin-dialog';
import { firstValueFrom } from 'rxjs';
// Adjust these paths to your folders.
import { GitResult, GitService } from '../services/git.service';
import { CommitFile, GitBranch, GitCommit } from '../parser/git-parsers';
import { GitFileStatus } from '../parser/git-status.parser';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { GitIdentity, GitIdentityDialog } from '../git-identity-dialog';
import { EditorCommands } from '../../editor/editor.commands';
import { GitDiffService } from '../services/git-diff.service';

export interface GitUiFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!';
  /** The git record this row stands for (what the actions operate on). */
  source: GitFileStatus;
}

type Menu = 'branch' | 'actions' | null;

const CHANGE_LETTERS = ['M', 'A', 'D', 'R', 'C', 'T'];
const sideLetter = (c: string) => (CHANGE_LETTERS.includes(c) ? c : 'M') as GitUiFile['status'];
const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

@Component({
  selector: 'git-graph',
  templateUrl: './graph.html',
  styleUrl: './graph.scss',
  imports: [FormsModule, NgIcon],
  providers: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideCheck,
      lucideChevronDown,
      lucideEllipsis,
      lucideFile,
      lucideGitBranch,
      lucideGitCommitHorizontal,
      lucidePlus,
      lucideRefreshCcw,
      lucideUndo,
      lucideMinus,
      bootstrapSave,
    }),
  ],
  standalone: true,
})
export class GitGraph {
  readonly git = inject(GitService);
  private readonly gitDiff = inject(GitDiffService);
  private store = inject(WorkspaceNodeStore);
  private dialog = inject(DialogService);
  private readonly commands = inject(EditorCommands);
  // private diffs = inject(DiffService);

  // ───────────── what the template shows ─────────────

  hasFolder = computed(() => !!this.store.rootPath());
  branchName = computed(() => {
    const status = this.git.status();
    return status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch');
  });
  ahead = computed(() => this.git.status()?.ahead ?? 0);
  behind = computed(() => this.git.status()?.behind ?? 0);
  hasUpstream = computed(() => !!this.git.status()?.upstream);

  stagedFiles = computed<GitUiFile[]>(() =>
    this.git.staged().map((f) => ({ path: f.path, status: sideLetter(f.index), source: f })),
  );
  changedFiles = computed<GitUiFile[]>(() =>
    this.git.unstaged().map((f) => ({
      path: f.path,
      status: f.kind === 'untracked' ? 'U' : sideLetter(f.worktree),
      source: f,
    })),
  );
  conflictFiles = computed<GitUiFile[]>(() =>
    this.git.conflicts().map((f) => ({ path: f.path, status: '!', source: f })),
  );
  stagedExpanded = true;
  commitMessage = signal('');
  expandedCommit = signal('');

  /** One line of feedback under the header: what failed (git's own words) or what just happened. */
  notice = signal<{ kind: 'error' | 'info'; text: string } | null>(null);
  private noticeTimer?: ReturnType<typeof setTimeout>;

  // ───────────── menus ─────────────

  menu = signal<Menu>(null);
  branches = signal<GitBranch[]>([]);
  branchFilter = signal('');
  newBranch = signal('');
  branchError = signal<string | null>(null);

  history = signal<GitCommit[]>([]);
  commitFileMap = signal<Map<string, CommitFile[] | null>>(new Map());

  /** Remote branches that a local branch already tracks are hidden: switching to the local one is the same thing. */
  visibleBranches = computed(() => {
    const all = this.branches();
    const query = this.branchFilter().trim().toLowerCase();
    const tracked = new Set(all.filter((b) => !b.remote && b.upstream).map((b) => b.upstream));
    return all
      .filter((b) => !(b.remote && tracked.has(b.name)))
      .filter((b) => !query || b.name.toLowerCase().includes(query));
  });

  constructor() {
    effect(async () => {
      this.history.set(await this.git.history(100));
    });
  }
  async getCommitFiles(hash: string) {
    if (this.commitFileMap().has(hash)) {
      this.toggleCommitFile(hash);
      return;
    }
    const commit = await this.git.commitDetails(hash);
    if (!commit) return;
    this.commitFileMap().set(hash, commit.files);
    this.toggleCommitFile(hash);
  }

  toggleCommitFile(hash: string) {
    this.expandedCommit.update((v) => (v === hash ? '' : hash));
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.menu() && !(event.target as HTMLElement).closest('.menu-anchor')) this.menu.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.menu.set(null);
  }

  toggleMenu(which: Exclude<Menu, null>) {
    this.menu.set(this.menu() === which ? null : which);
  }

  // ───────────── repository ─────────────

  async initializeGit() {
    this.report(await this.git.init(), 'Repository initialized.');
  }

  // ───────────── committing ─────────────

  async commit() {
    const message = this.commitMessage().trim();
    if (!message || !this.stagedFiles().length || this.git.busy()) return;

    let result = await this.git.commit(message);

    // Git refuses to commit until it knows who you are. The dialog saves the identity; then retry once.
    if (!result.ok && result.code === 'identity') {
      if (!(await this.askForIdentity())) {
        this.report({ ...result, error: 'Commit cancelled: git needs your name and email first.' });
        return;
      }
      result = await this.git.commit(message);
    }

    if (result.ok) this.commitMessage.set('');
    this.report(result, 'Committed.');
  }

  /** Opens the identity dialog. Resolves true if an identity was saved, false if the user cancelled. */
  private async askForIdentity(): Promise<boolean> {
    const current = await this.git.getIdentity(); // pre-fills whatever is already configured
    const ref = this.dialog.open<GitIdentity | undefined>(GitIdentityDialog, {
      title: 'Your Git identity',
      data: current,
    });
    return !!(await firstValueFrom(ref.closed));
  }

  /** "Git identity…" in the menu: change it any time, not only after a failed commit. */
  async editIdentity() {
    this.menu.set(null);
    if (await this.askForIdentity()) this.notice.set({ kind: 'info', text: 'Git identity saved.' });
  }

  // ───────────── staging and discarding ─────────────

  async stageFile(file: GitUiFile) {
    this.report(await this.git.stage([file.path]));
  }

  async unstageFile(file: GitUiFile) {
    this.report(await this.git.unstage([file.path]));
  }

  async stageAll() {
    this.report(await this.git.stageAll());
  }

  async unstageAll() {
    this.report(await this.git.unstageAll());
  }

  async discardFile(file: GitUiFile) {
    const question =
      file.status === 'U'
        ? `Delete the untracked file "${file.path}"?`
        : `Discard your changes to "${file.path}"?`;
    if (!(await this.confirm(`${question}\n\nThis cannot be undone.`, 'Discard'))) return;
    this.report(await this.git.discard([file.source]));
  }

  async discardAll() {
    const files = this.changedFiles();
    if (!files.length) return;
    const untracked = files.filter((f) => f.status === 'U').length;
    const detail = untracked
      ? ` (${untracked} untracked file${untracked === 1 ? '' : 's'} will be deleted)`
      : '';
    if (
      !(await this.confirm(
        `Discard all changes in ${files.length} file${files.length === 1 ? '' : 's'}${detail}?\n\nThis cannot be undone.`,
        'Discard all',
      ))
    )
      return;
    this.report(await this.git.discard(files.map((f) => f.source)));
  }

  async openDiff(hash: string, file: CommitFile) {
    const request = this.gitDiff.requestForCommits(`${hash}^`, hash, file);
    if (request) {
      const error = await this.gitDiff.open(request);
      if (error) this.notice.set({ kind: 'error', text: error });
    }
  }

  // ───────────── branches ─────────────

  async toggleBranchMenu() {
    if (this.menu() === 'branch') return this.menu.set(null);
    this.menu.set('branch');
    this.branchFilter.set('');
    this.newBranch.set('');
    this.branchError.set(null);
    this.branches.set(await this.git.branches());
  }

  async switchTo(branch: GitBranch) {
    this.menu.set(null);
    // Git refuses when local changes would be overwritten; its message says which files.
    this.report(await this.git.switchTo(branch), `Switched to ${branch.name}.`);
  }

  async createBranch() {
    const name = this.newBranch().trim();
    const invalid = await this.git.checkBranchName(name);
    if (invalid) return this.branchError.set(invalid);

    const result = await this.git.createBranch(name);
    if (!result.ok) return this.branchError.set(result.error);
    this.menu.set(null);
    this.report(result, `Created and switched to ${name}.`);
  }

  // ───────────── remote and other actions (header menu, footer) ─────────────

  async runAction(action: () => Promise<GitResult>, success: string) {
    this.menu.set(null);
    this.report(await action(), success);
  }

  async pull() {
    this.menu.set(null);
    const result = await this.git.pull();
    this.report(result, firstLine(result.output) || 'Pulled.');
  }

  /** Footer button: bring in what's new, then send what's local. */
  async sync() {
    if (!this.hasUpstream()) return this.report(await this.git.push(), 'Branch published.');
    if (this.behind()) {
      const pulled = await this.git.pull();
      if (!pulled.ok) return this.report(pulled);
    }
    if (this.git.status()?.ahead) return this.report(await this.git.push(), 'Pushed.');
    this.report(await this.git.fetch(), 'Up to date.');
  }

  // ───────────── helpers ─────────────

  private confirm(message: string, okLabel: string) {
    return ask(message, {
      title: 'Source Control',
      kind: 'warning',
      okLabel,
      cancelLabel: 'Cancel',
    });
  }

  private report(result: GitResult, success?: string) {
    clearTimeout(this.noticeTimer);
    if (!result.ok) {
      this.notice.set({ kind: 'error', text: result.error || 'Git reported an error.' });
      return;
    }
    if (success) {
      this.notice.set({ kind: 'info', text: success });
      this.noticeTimer = setTimeout(() => this.notice.set(null), 4000);
    } else {
      this.notice.set(null);
    }
  }

  // statusLabel(status: GitUiFile['status']): string {
  //   return {
  //     M: 'Modified',
  //     A: 'Added',
  //     D: 'Deleted',
  //     R: 'Renamed',
  //     C: 'Copied',
  //     T: 'Type changed',
  //     U: 'Untracked',
  //     '!': 'Conflict',
  //   }[status];
  // }

  // statusClass(status: CommitFile['status']): string {
  //   // const suffix = status === '!' ? 'conflict' : status.toLowerCase();
  //   // return `status status--${suffix}`;
  // }
}
