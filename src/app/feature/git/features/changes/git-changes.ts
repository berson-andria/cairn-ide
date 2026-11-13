import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { fail, GitResult, GitService } from '../../services/git.service';
import { DialogService } from '../../../../core/services/dialog/dialog.service';
import { GitDiffService } from '../../services/git-diff.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideChevronDown,
  lucideChevronRight,
  lucideEllipsis,
  lucideFileSymlink,
  lucideHardDriveDownload,
  lucideMinus,
  lucidePlus,
  lucideRefreshCcw,
  lucideUndo,
} from '@ng-icons/lucide';
import { MenuDirective } from '../../../../shared/directives/menu.directive';
import { EditorCommands } from '../../../editor/editor.commands';
import { firstLine, GitUiFile, sideLetter, statusLabel, statusStyle } from '../../ui/git-ui';
import { confirmAction } from '../../ui/git-dialogs';
import { GitNoticeManager } from '../../ui/git-notice';
import { GitBranch } from '../../parser/branch.parser';
import { GitDialogService } from '../../services/git-dialog.service';
import { TabStore } from '../../../../core/store/tab.store';
import { CommitMode, GitCommitService } from '../../services/git-commit.service';
import { getFileNameFromPath } from '../../../../shared/utils/node.utils';
import { FileIcon } from '../../../../shared/components/file-icon';

@Component({
  selector: 'git-changes',
  templateUrl: './git-changes.html',
  styleUrl: './git-changes.scss',
  imports: [FormsModule, NgIcon, MenuDirective, FileIcon],
  providers: [
    provideIcons({
      lucideFileSymlink,
      lucideUndo,
      lucideEllipsis,
      lucideHardDriveDownload,
      lucideMinus,
      lucideRefreshCcw,
      lucideArrowUp,
      lucidePlus,
      lucideChevronDown,
      lucideChevronRight,
    }),
  ],
  standalone: true,
})
export class GitChanges {
  readonly git = inject(GitService);
  protected readonly commits = inject(GitCommitService);
  private readonly gitDiff = inject(GitDiffService);
  private dialog = inject(GitDialogService);
  protected editorCommands = inject(EditorCommands);
  protected tabStore = inject(TabStore);
  protected editorCommand = inject(EditorCommands);

  // ───────────── what the template shows ─────────────
  dirtyFileCount = computed(() => this.tabStore.dirtyIds().length);
  branchName = computed(() => {
    const status = this.git.status();
    return status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch');
  });
  ahead = computed(() => this.git.status()?.ahead ?? 0);
  behind = computed(() => this.git.status()?.behind ?? 0);
  hasUpstream = computed(() => !!this.git.status()?.upstream);

  stagedFiles = computed<GitUiFile[]>(() =>
    this.git
      .staged()
      .map((f) => ({ path: f.path, status: sideLetter(f.index), source: f, mode: 'staged' })),
  );
  changedFiles = computed<GitUiFile[]>(() => {
    return this.git.unstaged().map((f) => ({
      path: f.path,
      status: f.kind === 'untracked' ? 'U' : sideLetter(f.worktree),
      source: f,
      mode: 'unstaged',
    }));
  });
  conflictFiles = computed<GitUiFile[]>(() =>
    this.git.conflicts().map((f) => ({ path: f.path, status: '!', source: f, mode: 'unstaged' })),
  );

  commitMessage = signal('');
  stagedExpanded = true;
  changesExpanded = true;

  /** One line of feedback under the header: what failed (git's own words) or what just happened. */
  notice = signal<{ kind: 'error' | 'info'; text: string } | null>(null);
  private noticeManager = new GitNoticeManager(this.notice);

  readonly hasChanges = computed(() => this.stagedFiles().length + this.changedFiles().length > 0);

  // ───────────── menus ─────────────

  branches = signal<GitBranch[]>([]);
  branchFilter = signal('');
  newBranch = signal('');
  branchError = signal<string | null>(null);

  stagedOpen = true;
  ChangesOpen = true;

  /** Remote branches that a local branch already tracks are hidden: switching to the local one is the same thing. */
  visibleBranches = computed(() => {
    const all = this.branches();
    const query = this.branchFilter().trim().toLowerCase();
    const tracked = new Set(all.filter((b) => !b.remote && b.upstream).map((b) => b.upstream));
    return all
      .filter((b) => !(b.remote && tracked.has(b.name)))
      .filter((b) => !query || b.name.toLowerCase().includes(query));
  });

  // ───────────── repository ─────────────

  async initializeGit() {
    this.noticeManager.report(await this.git.init(), 'Repository initialized.');
  }

  // ───────────── committing ─────────────

  private async askMessage(): Promise<string | null> {
    const typed = this.commitMessage().trim();
    if (typed) return typed;
    const message = await this.dialog.commitMessage({ message: 'Enter a commit message.' });
    if (!message) return null;
    this.commitMessage.set(message); // still there if the commit fails
    return message;
  }

  /** Offers to save open editors. false = cancelled. */
  private async confirmUnsaved(): Promise<boolean> {
    const count = this.dirtyFileCount();
    if (!count) return true;
    const choice = await this.dialog.unsavedChoice(count);
    if (!choice) return false;
    if (choice === 'save') await this.editorCommand.saveAll(); // ← use your tab store's save-all
    return true;
  }

  /** Nothing staged: offers to stage everything. false = nothing to commit, or cancelled. */
  private async ensureStaged(): Promise<boolean> {
    if (this.stagedFiles().length) return true;
    if (!this.changedFiles().length) {
      this.noticeManager.report(fail('Nothing to commit.'));
      return false;
    }
    const ok = await confirmAction(
      'There are no staged changes. Stage all changes and commit them?',
      'Stage All & Commit',
    );
    if (!ok) return false;
    const staged = await this.git.stageAll();
    if (!staged.ok) this.noticeManager.report(staged);
    return staged.ok;
  }

  // ── commit ──────────────────────────────────────────────────────────────────
  private async commitAndClear(mode: CommitMode): Promise<boolean> {
    const done = await this.commits.commit(mode, this.commitMessage());
    if (done) this.commitMessage.set('');
    return done;
  }

  commit() {
    return this.commitAndClear('staged');
  }
  commitAmend() {
    return this.commitAndClear('amend');
  }

  async commitAndPush() {
    if (await this.commitAndClear('staged')) await this.push();
  }

  async commitAndSync() {
    if (!(await this.commitAndClear('staged'))) return;
    if (!this.git.status()?.upstream) return this.push();
    await this.runSync();
  }

  // ── push / sync ─────────────────────────────────────────────────────────────

  /** The "Sync Changes" button: asks first, like VS Code. */
  async sync() {
    const upstream = this.git.status()?.upstream;
    if (!upstream) return;
    const ok = await confirmAction(
      `This action will pull and push commits from and to "${upstream}".`,
      'OK',
    );
    if (ok) await this.runSync();
  }

  private async runSync() {
    this.noticeManager.report(await this.dialog.withRecovery(() => this.git.sync()), 'Synced.');
  }

  /** Push; a branch without upstream is published to a remote the user picks (or the only one). */
  private async push() {
    let result: GitResult;
    if (this.git.status()?.upstream) {
      result = await this.dialog.withRecovery(() => this.git.push());
    } else {
      const remotes = await this.git.remotes();
      const remote =
        remotes.length === 1
          ? remotes[0]
          : await this.dialog.pickRemote('Publish branch to', remotes, 'Publish');
      if (!remote) return;
      result = await this.dialog.withRecovery(() => this.git.pushTo(remote));
    }
    this.noticeManager.report(result, 'Pushed.');
  }

  // ───────────── staging and discarding ─────────────

  async stageFile(file: GitUiFile) {
    this.noticeManager.report(await this.git.stage([file.path]));
  }

  async unstageFile(file: GitUiFile) {
    this.noticeManager.report(await this.git.unstage([file.path]));
  }

  async stageAll() {
    this.noticeManager.report(await this.git.stageAll());
  }

  async unstageAll() {
    this.noticeManager.report(await this.git.unstageAll());
  }

  async discardFile(file: GitUiFile) {
    const question =
      file.status === 'U'
        ? `Delete the untracked file "${file.path}"?`
        : `Discard your changes to "${file.path}"?`;
    if (!(await confirmAction(`${question}\n\nThis cannot be undone.`, 'Discard'))) return;
    this.noticeManager.report(await this.git.discard([file.source]));
  }

  async discardAll() {
    const files = this.changedFiles();
    if (!files.length) return;
    const untracked = files.filter((f) => f.status === 'U').length;
    const detail = untracked
      ? ` (${untracked} untracked file${untracked === 1 ? '' : 's'} will be deleted)`
      : '';
    if (
      !(await confirmAction(
        `Discard all changes in ${files.length} file${files.length === 1 ? '' : 's'}${detail}?\n\nThis cannot be undone.`,
        'Discard all',
      ))
    )
      return;
    this.noticeManager.report(await this.git.discard(files.map((f) => f.source)));
  }

  /** A click on a row shows what changed. Untracked and conflicted files have nothing to compare, so they just open. */
  async openDiff(file: GitUiFile) {
    const mode = !file.source.unstaged ? 'staged' : 'unstaged';
    try {
      await this.gitDiff.openChange(file.source, mode);
    } catch (error) {
      this.notice.set({ kind: 'error', text: `Could not open ${file.path}.` });
    }
  }

  openFile(file: GitUiFile) {
    const abs = this.git.absolutePathOf(file.path);
    if (abs) void this.editorCommands.openPath(abs);
  }

  // ───────────── remote and other actions (header menu, footer) ─────────────

  async pull() {
    const result = await this.git.pull();
    this.noticeManager.report(result, firstLine(result.output) || 'Pulled.');
  }

  // /** Footer button: bring in what's new, then send what's local. */
  // async sync() {
  //   if (!this.hasUpstream())
  //     return this.noticeManager.report(await this.git.push(), 'Branch published.');
  //   if (this.behind()) {
  //     const pulled = await this.git.pull();
  //     if (!pulled.ok) return this.noticeManager.report(pulled);
  //   }
  //   if (this.git.status()?.ahead)
  //     return this.noticeManager.report(await this.git.push(), 'Pushed.');
  //   this.noticeManager.report(await this.git.fetch(), 'Up to date.');
  // }

  // ───────────── template helpers ─────────────

  statusLabel = statusLabel;
  statusClass = statusStyle;
  getFileNameFromPath = getFileNameFromPath;

  /** Runs a git action, closes menus, and reports the result. */
  runAction = async (action: () => Promise<GitResult>, success: string) => {
    await this.noticeManager.runAction(action, success);
  };
}
