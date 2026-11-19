import { Injectable, inject } from '@angular/core';
import { GitService, StashScope } from './git.service';
import { GitDialogService } from './git-dialog.service';
import type { GitBranch } from '../parser/branch.parser';
// Adjust these three to your real types/paths.
import { EditorCommands } from '../../editor/editor.commands';
import { TabStore } from '../../../core/store/tab.store';

import { GitPipelineContext } from '../client/context';
import { CommitMode, commitPipeline } from '../client/commit.pipeline';
import {
  stashPipeline,
  stashLatestPipeline,
  stashPickPipeline,
  dropAllStashesPipeline,
  StashOptions,
  stashActPipeline,
} from '../client/stash.pipeline';
import {
  switchToPipeline,
  checkoutToPipeline,
  createBranchPipeline,
  deleteBranchPipeline,
  mergeBranchPipeline,
  abortPipeline,
  rebaseBranchPipeline,
  renameBranchPipeline,
  checkoutDetachedPipeline,
} from '../client/branch.pipeline';
import { discardPipeline, undoLastCommitPipeline } from '../client/changes.pipeline';
import {
  pullPipeline,
  pullRebasePipeline,
  pullFromPipeline,
  pushPipeline,
  pushToPipeline,
  publishBranchPipeline,
  syncPipeline,
  addRemotePipeline,
  removeRemotePipeline,
  deleteRemoteBranchPipeline,
  cloneRepoPipeline,
  fetchPipeline,
} from '../client/remote.pipeline';
import { GitFileStatus } from '../parser/status.parser';
import { NoticeManager } from '../../../core/services/notification/notification.service';
import { GitStash } from '../parser/log.parser';

@Injectable({ providedIn: 'root' })
export class GitClient {
  private readonly tabStore = inject(TabStore);
  private readonly editor = inject(EditorCommands);

  private readonly ctx: GitPipelineContext = {
    git: inject(GitService),
    dialogs: inject(GitDialogService),
    notices: inject(NoticeManager),
    dirtyFileCount: () => this.tabStore.dirtyIds().length,
    saveAllOpenFiles: () => this.editor.saveAll(),
  };

  // ── commit / stash ────────────────────────────────────────────────────
  commit(mode: CommitMode, draft = ''): Promise<boolean> {
    return commitPipeline(this.ctx, mode, draft);
  }
  stash(options: StashOptions = {}): Promise<boolean> {
    return stashPipeline(this.ctx, options);
  }
  stashAct(action: 'apply' | 'pop' | 'drop', stash: GitStash): Promise<boolean> {
    return stashActPipeline(this.ctx, action, stash);
  }
  stashLatest(action: 'apply' | 'pop'): Promise<boolean> {
    return stashLatestPipeline(this.ctx, action);
  }
  stashPick(action: 'apply' | 'pop' | 'drop'): Promise<boolean> {
    return stashPickPipeline(this.ctx, action);
  }
  dropAllStashes(): Promise<boolean> {
    return dropAllStashesPipeline(this.ctx);
  }

  // ── working tree ──────────────────────────────────────────────────────
  // Plain pass-throughs: no dialog, no business logic, so no pipeline file needed. No notice on
  // a single stage/unstage click (that would spam a toast per checkbox); the "all" variants do.
  async stage(paths: string[]): Promise<void> {
    this.ctx.notices.report(await this.ctx.git.stage(paths));
  }
  async unstage(paths: string[]): Promise<void> {
    this.ctx.notices.report(await this.ctx.git.unstage(paths));
  }
  async stageAll(): Promise<void> {
    this.ctx.notices.report(await this.ctx.git.stageAll(), 'Staged all changes.');
  }
  async unstageAll(): Promise<void> {
    this.ctx.notices.report(await this.ctx.git.unstageAll(), 'Unstaged all changes.');
  }
  discardAll(files?: GitFileStatus[]): Promise<void> {
    return discardPipeline(this.ctx, files);
  }
  undoLastCommit(): Promise<void> {
    return undoLastCommitPipeline(this.ctx);
  }

  // ── branch ────────────────────────────────────────────────────────────
  switchTo(branch: GitBranch): Promise<void> {
    return switchToPipeline(this.ctx, branch);
  }
  checkoutTo(): Promise<void> {
    return checkoutToPipeline(this.ctx);
  }
  createBranch(fromPicker = false): Promise<void> {
    return createBranchPipeline(this.ctx, fromPicker);
  }
  deleteBranch(): Promise<void> {
    return deleteBranchPipeline(this.ctx);
  }
  mergeBranch(): Promise<void> {
    return mergeBranchPipeline(this.ctx);
  }
  abort(): Promise<void> {
    return abortPipeline(this.ctx);
  }
  rebaseBranch(): Promise<void> {
    return rebaseBranchPipeline(this.ctx);
  }
  renameBranch(): Promise<void> {
    return renameBranchPipeline(this.ctx);
  }
  checkoutDetached(): Promise<void> {
    return checkoutDetachedPipeline(this.ctx);
  }

  // ── remote ────────────────────────────────────────────────────────────
  fetch() {
    return fetchPipeline(this.ctx);
  }
  pull(): Promise<void> {
    return pullPipeline(this.ctx);
  }
  pullRebase(): Promise<void> {
    return pullRebasePipeline(this.ctx);
  }
  pullFrom(): Promise<void> {
    return pullFromPipeline(this.ctx);
  }
  push(options: { force?: boolean } = {}): Promise<void> {
    return pushPipeline(this.ctx, options);
  }
  pushTo(): Promise<void> {
    return pushToPipeline(this.ctx);
  }
  publishBranch(): Promise<void> {
    return publishBranchPipeline(this.ctx);
  }
  sync(): Promise<void> {
    return syncPipeline(this.ctx);
  }
  addRemote(): Promise<void> {
    return addRemotePipeline(this.ctx);
  }
  removeRemote(): Promise<void> {
    return removeRemotePipeline(this.ctx);
  }
  deleteRemoteBranch(): Promise<void> {
    return deleteRemoteBranchPipeline(this.ctx);
  }
  cloneRepo(defaultDirectory: string): Promise<string | undefined> {
    return cloneRepoPipeline(this.ctx, defaultDirectory);
  }
}
