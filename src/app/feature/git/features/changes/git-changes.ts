import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GitService } from '../../services/git.service';
import { GitDiffService } from '../../services/git-diff.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideArrowUp,
  lucideChevronDown,
  lucideChevronRight,
  lucideEllipsis,
  lucideFileSymlink,
  lucideGitGraph,
  lucideHardDriveDownload,
  lucideMinus,
  lucidePlus,
  lucideRotateCcw,
  lucideUndo,
} from '@ng-icons/lucide';
import { MenuDirective } from '../../../../shared/directives/menu.directive';
import { EditorCommands } from '../../../editor/editor.commands';
import { GitUiFile, sideLetter, statusLabel, statusStyle } from '../../ui/git-ui';
import { getFileNameFromPath } from '../../../../shared/utils/node.utils';
import { FileIcon } from '../../../../shared/components/file-icon';
import { NodeStore } from '../../../../core/store/node.store';
import { NoRepository } from '../no-git/no-repository';
import { LayoutService, Toolkit } from '../../../../core/services/layout.service';
import { GitClient } from '../../services/git-client.service';
import { CommitMode } from '../../client/commit.pipeline';
import { GitStash } from '../../parser/log.parser';
import { Stash } from '../stash/stash';

@Component({
  selector: 'git-changes',
  templateUrl: './git-changes.html',
  styleUrl: './git-changes.scss',
  imports: [FormsModule, NgIcon, MenuDirective, FileIcon, NoRepository, Stash],
  providers: [
    provideIcons({
      lucideFileSymlink,
      lucideUndo,
      lucideEllipsis,
      lucideHardDriveDownload,
      lucideMinus,
      lucideRotateCcw,
      lucideArrowUp,
      lucidePlus,
      lucideChevronDown,
      lucideChevronRight,
      lucideGitGraph,
      lucideArchive,
    }),
  ],
  standalone: true,
})
export class GitChanges {
  protected readonly layout = inject(LayoutService);
  protected readonly git = inject(GitService);
  protected readonly gitClient = inject(GitClient);
  protected readonly nodeStore = inject(NodeStore);
  private readonly gitDiff = inject(GitDiffService);
  protected editorCommand = inject(EditorCommands);

  protected readonly focusSection = signal<'changes' | 'stash' | null>('changes');

  readonly stashList = signal<GitStash[]>([]);
  readonly displayedSatshes = computed(() => {
    return this.stashMessageFilter().trim().length
      ? this.stashList().filter((stash) => stash.message.includes(this.stashMessageFilter()))
      : this.stashList();
  });

  // ───────────── what the template shows ─────────────
  protected branchName = computed(() => {
    const status = this.git.status();
    return status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch');
  });

  protected ahead = computed(() => this.git.status()?.ahead ?? 0);
  protected behind = computed(() => this.git.status()?.behind ?? 0);
  protected hasUpstream = computed(() => !!this.git.status()?.upstream);

  protected stagedFiles = computed<GitUiFile[]>(() =>
    this.git
      .staged()
      .map((f) => ({ path: f.path, status: sideLetter(f.index), source: f, mode: 'staged' })),
  );
  protected changedFiles = computed<GitUiFile[]>(() => {
    return this.git.unstaged().map((f) => ({
      path: f.path,
      status: f.kind === 'untracked' ? 'U' : sideLetter(f.worktree),
      source: f,
      mode: 'unstaged',
    }));
  });
  protected conflictFiles = computed<GitUiFile[]>(() =>
    this.git.conflicts().map((f) => ({ path: f.path, status: '!', source: f, mode: 'unstaged' })),
  );
  protected gitChangesCount = computed(() => {
    const staged = this.git.staged();
    const unstaged = this.git.unstaged();
    return staged.length + unstaged.length;
  });

  readonly hasChanges = computed(() => this.stagedFiles().length + this.changedFiles().length > 0);

  protected commitMessage = signal('');
  protected stashMessageFilter = signal('');
  protected stagedExpanded = true;
  protected changesExpanded = true;

  protected stagedOpen = true;
  protected ChangesOpen = true;

  statusLabel = statusLabel;
  statusClass = statusStyle;
  getFileNameFromPath = getFileNameFromPath;

  constructor() {
    void this.loadStashes();
  }

  async loadStashes(): Promise<void> {
    this.stashList.set(await this.git.stashes());
  }

  async filesInStash(stash: GitStash) {
    return await this.git.stashFiles(stash.hash);
  }

  toggleFocusSection(section: 'changes' | 'stash') {
    this.focusSection.update((v) => {
      return v === section ? null : section;
    });
  }

  protected toggleToolkit(toolkit: Toolkit) {
    if (this.layout.activeToolkit() === toolkit) {
      this.layout.toggleBottomPanel();
    } else if (!this.layout.isBottomPanelCollapsed()) {
      this.layout.toggleToolkit(toolkit);
    } else {
      this.layout.toggleToolkit(toolkit);
      this.layout.toggleBottomPanel();
    }
  }
  protected path(file: GitUiFile) {
    const name = getFileNameFromPath(file.path);
    return file.path.substring(0, file.path.lastIndexOf(name) - 1);
  }

  // ── commit ──────────────────────────────────────────────────────────────────
  private async commitAndClear(mode: CommitMode): Promise<boolean> {
    const done = await this.gitClient.commit(mode, this.commitMessage());
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
    if (await this.commitAndClear('staged')) await this.gitClient;
  }

  async commitAndSync() {
    if (!(await this.commitAndClear('staged'))) return;
    if (!this.git.status()?.upstream) return await this.gitClient.push();
    await this.gitClient.sync();
  }

  // ───────────── staging and discarding ─────────────

  async stageFile(file: GitUiFile) {
    await this.gitClient.stage([file.path]);
  }

  async unstageFile(file: GitUiFile) {
    await this.gitClient.unstage([file.path]);
  }

  async stageAll() {
    await this.gitClient.stageAll();
  }

  async unstageAll() {
    await this.gitClient.unstageAll();
  }

  async discardFile(file: GitUiFile) {
    await this.gitClient.discardAll([file.source]);
  }

  async discardAll() {
    await this.gitClient.discardAll();
  }

  /** A click on a row shows what changed. Untracked and conflicted files have nothing to compare, so they just open. */
  async openDiff(file: GitUiFile) {
    const mode = !file.source.unstaged ? 'staged' : 'unstaged';
    try {
      await this.gitDiff.openChange(file.source, mode);
    } catch (error) {
      // this.notice.set({ kind: 'error', text: `Could not open ${file.path}.` });
    }
  }

  openFile(file: GitUiFile) {
    const abs = this.git.absolutePathOf(file.path);
    if (abs) void this.editorCommand.openPath(abs);
  }

  // ───────────── remote and other actions (header menu, footer) ─────────────

  async pull() {
    await this.gitClient.pull();
  }
}
