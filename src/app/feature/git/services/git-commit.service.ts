import { Injectable, inject, signal } from '@angular/core';
import { GitDialogService } from './git-dialog.service';
import { fail, GitService, StashScope } from './git.service';
import { EditorCommands } from '../../editor/editor.commands';
import { GitNoticeManager } from '../ui/git-notice';
import { TabStore } from '../../../core/store/tab.store';
import { confirmAction } from '../ui/git-dialogs';

export type CommitMode = 'staged' | 'all' | 'amend';

/**
 * The one commit flow, for the commit box and the menu alike. Every prompt comes before anything
 * touches the repository, so cancelling at any point changes nothing.
 */
@Injectable({ providedIn: 'root' })
export class GitCommitService {
  private readonly git = inject(GitService);
  private readonly dialogs = inject(GitDialogService);
  private readonly tabStore = inject(TabStore);
  private readonly commands = inject(EditorCommands);

  notice = signal<{ kind: 'error' | 'info'; text: string } | null>(null);
  private noticeManager = new GitNoticeManager(this.notice);

  /**
   * Resolves to true when a commit was made, so the caller can clear its message box.
   * `draft` is text already typed in a commit box.
   */
  async commit(mode: CommitMode, draft = ''): Promise<boolean> {
    if (this.git.busy()) return false;
    const amend = mode === 'amend';

    // 1. Unsaved editors first: saving changes what git sees, and the checks below depend on it.
    if (!(await this.confirmUnsaved('commit'))) return false;

    // 2. What goes into the commit.
    let stageAll = false;
    if (!amend) {
      const hasStaged = this.git.staged().length > 0;
      const hasUnstaged = this.git.unstaged().length > 0;
      if (!hasStaged && !hasUnstaged) return this.nothingToCommit();

      if (mode === 'all') {
        stageAll = hasUnstaged;
      } else if (!hasStaged) {
        const ok = await confirmAction(
          'There are no staged changes. Stage all changes and commit them?',
          'Stage All & Commit',
        );
        if (!ok) return false;
        stageAll = true;
      }
    } else {
      const s = this.git.status();
      const pushed = !!s?.upstream && s.ahead === 0;
      if (
        pushed &&
        !(await confirmAction(
          'This commit is already pushed. Amending it means you will have to force push. Continue?',
          'Amend',
        ))
      ) {
        return false;
      }
    }

    // 3. The message: from the box if there is one, otherwise ask.
    const typed = draft.trim();
    const message = amend
      ? await this.dialogs.commitMessage({
          amend: true,
          initial: typed || (await this.git.lastCommitMessage()),
        })
      : typed || (await this.dialogs.commitMessage({ message: 'Enter a commit message.' }));
    if (!message?.trim()) return false; // cancelled

    // 4. Only now change anything. An identity problem asks for name and email, then retries.
    const result = await this.dialogs.withRecovery(async () => {
      if (stageAll) {
        const staged = await this.git.stageAll();
        if (!staged.ok) return staged;
      }
      return this.git.commit(message.trim(), { amend });
    });
    this.noticeManager.report(result, amend ? 'Commit amended.' : 'Committed.');
    return result.ok;
  }

  private async confirmUnsaved(action: 'stash' | 'commit'): Promise<boolean> {
    const count = this.tabStore.dirtyIds().length;
    if (!count) return true;
    const choice = await this.dialogs.unsavedChoice(count, action);
    if (!choice) return false;
    if (choice === 'save') {
      await this.commands.saveAll();
      await this.git.refresh(); // the file watcher may not have caught up yet
    }
    return true;
  }

  private nothingToCommit(): false {
    this.noticeManager.report(fail('Nothing to commit.'));
    return false;
  }
  async stash(scope: StashScope = 'all', includeUntracked = false): Promise<boolean> {
    if (this.git.busy()) return false;

    const staged = this.git.staged().length;
    const unstaged = this.git.unstaged().length;
    const available =
      scope === 'staged' ? staged : scope === 'unstaged' ? unstaged : staged + unstaged;
    if (!available) {
      this.noticeManager.report(
        fail(scope === 'staged' ? 'No staged changes to stash.' : 'No changes to stash.'),
      );
      return false;
    }

    if (!(await this.confirmUnsaved('stash'))) return false;
    const message = await this.dialogs.stashMessage(scope, includeUntracked);
    if (message === undefined) return false;

    const labels = {
      all: 'Changes stashed.',
      staged: 'Staged changes stashed.',
      unstaged: 'Unstaged changes stashed.',
    };
    const result = await this.git.stash(message, scope, includeUntracked);
    this.noticeManager.report(result, labels[scope]);
    return result.ok;
  }
}
