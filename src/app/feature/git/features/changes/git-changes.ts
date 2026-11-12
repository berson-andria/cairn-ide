import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GitResult, GitService } from '../../services/git.service';
import { DialogService } from '../../../../core/services/dialog/dialog.service';
import { GitDiffService } from '../../services/git-diff.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucideFileSymlink,
  lucideHardDriveDownload,
  lucideMinus,
  lucideUndo,
} from '@ng-icons/lucide';
import { MenuDirective } from '../../../../shared/directives/menu.directive';
import { EditorCommands } from '../../../editor/editor.commands';
import { firstLine, GitUiFile, sideLetter, statusLabel, statusStyle } from '../../ui/git-ui';
import { confirmAction } from '../../ui/git-dialogs';
import { GitNoticeManager } from '../../ui/git-notice';
import { GitBranch } from '../../parser/branch.parser';
import { GitDialogService } from '../../services/git-dialog.service';

@Component({
  selector: 'git-changes',
  templateUrl: './git-changes.html',
  styleUrl: './git-changes.scss',
  imports: [FormsModule, NgIcon, MenuDirective],
  providers: [
    provideIcons({
      lucideFileSymlink,
      lucideUndo,
      lucideEllipsis,
      lucideHardDriveDownload,
      lucideMinus,
    }),
  ],
  standalone: true,
})
export class GitChanges {
  readonly git = inject(GitService);
  private readonly gitDiff = inject(GitDiffService);
  private dialog = inject(GitDialogService);
  protected editorCommands = inject(EditorCommands);

  // ───────────── what the template shows ─────────────
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

  // ───────────── menus ─────────────

  branches = signal<GitBranch[]>([]);
  branchFilter = signal('');
  newBranch = signal('');
  branchError = signal<string | null>(null);

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

  async commit() {
    const message = this.commitMessage().trim();
    if (!message || !this.stagedFiles().length || this.git.busy()) return;

    let result = await this.git.commit(message);

    // Git refuses to commit until it knows who you are. The dialog saves the identity; then retry once.
    if (!result.ok && result.code === 'identity') {
      if (!(await this.dialog.identity())) {
        this.noticeManager.report({
          ...result,
          error: 'Commit cancelled: git needs your name and email first.',
        });
        return;
      }
      result = await this.git.commit(message);
    }

    if (result.ok) this.commitMessage.set('');
    this.noticeManager.report(result, 'Committed.');
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

  /** Footer button: bring in what's new, then send what's local. */
  async sync() {
    if (!this.hasUpstream())
      return this.noticeManager.report(await this.git.push(), 'Branch published.');
    if (this.behind()) {
      const pulled = await this.git.pull();
      if (!pulled.ok) return this.noticeManager.report(pulled);
    }
    if (this.git.status()?.ahead)
      return this.noticeManager.report(await this.git.push(), 'Pushed.');
    this.noticeManager.report(await this.git.fetch(), 'Up to date.');
  }

  // ───────────── template helpers ─────────────

  statusLabel = statusLabel;
  statusClass = statusStyle;

  /** Runs a git action, closes menus, and reports the result. */
  runAction = async (action: () => Promise<GitResult>, success: string) => {
    await this.noticeManager.runAction(action, success);
  };
}
