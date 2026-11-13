import { Injectable, Type, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { PickerDialogComponent, PickerDialogData } from '../features/dialogs/picker-dialog';
import { FormDialog, FormDialogData, FormDialogResult } from '../features/dialogs/form-dialog';
import { ChoiceDialog, ChoiceDialogData } from '../features/dialogs/choice-dialog';
import { GitIdentityDialog } from '../features/dialogs/identity-dialog';
import { plural } from '../features/dialogs/dialog-shared';
import type { GitBranch } from '../parser/branch.parser';
// Type-only: these add no runtime dependency on GitService, so no DI cycle is possible.
import type { GitIdentity, StashScope } from './git.service';

export type OverwriteStrategy = 'stash' | 'migrate' | 'force';

/**
 * Pure dialog I/O: opens one dialog, returns what the user entered, in git-domain vocabulary.
 * Never injects GitService and never calls git. Anything a dialog needs to SHOW - an identity to
 * pre-fill, a branch-name validator, a list of branches to pick from - is passed in by the
 * caller. That is what keeps this cycle-free: GitService and GitDialogService never depend on
 * each other; only the pipelines in git-client/* depend on both.
 *
 * Confirmations (OK / Cancel) are NOT here: use confirmAction() from the Tauri dialog plugin.
 * Every method resolves to undefined (or false) when the user cancels.
 */
@Injectable({ providedIn: 'root' })
export class GitDialogService {
  private readonly dialog = inject(DialogService);

  // ───────────── generic ─────────────

  /** One or more text inputs. Resolves to the trimmed values by field key. */
  form(title: string, data: FormDialogData): Promise<FormDialogResult | undefined> {
    return this.open<FormDialogResult>(FormDialog, title, data);
  }

  /** Pick one item from a (searchable) list. Resolves to the item's `value`. */
  pick(title: string, data: PickerDialogData): Promise<string | undefined> {
    return this.open<string>(PickerDialogComponent, title, data);
  }

  /** Radio buttons. Resolves to the chosen option's `value`. */
  choose(title: string, data: ChoiceDialogData): Promise<string | undefined> {
    return this.open<string>(ChoiceDialog, title, data);
  }

  // ───────────── identity ─────────────

  /** `current` pre-fills the form; the caller fetches it from GitService first. */
  async identity(current: GitIdentity): Promise<boolean> {
    const ref = this.dialog.open(GitIdentityDialog, { title: 'Your Git identity', data: current });
    return !!(await firstValueFrom(ref.closed, { defaultValue: undefined }));
  }

  // ───────────── presets: the menu items, one line each ─────────────

  async cloneRepo(defaultDirectory: string): Promise<{ url: string; directory: string } | undefined> {
    const r = await this.form('Clone repository', {
      fields: [
        { key: 'url', label: 'Repository URL', placeholder: 'https://github.com/owner/repo.git' },
        { key: 'directory', label: 'Clone into', value: defaultDirectory },
      ],
      submitLabel: 'Clone',
    });
    return r && { url: r['url'], directory: r['directory'] };
  }

  async addRemote(initialName = 'origin'): Promise<{ name: string; url: string } | undefined> {
    const r = await this.form('Add remote', {
      fields: [
        { key: 'name', label: 'Name', value: initialName },
        { key: 'url', label: 'URL', placeholder: 'https://github.com/owner/repo.git' },
      ],
      submitLabel: 'Add Remote',
    });
    return r && { name: r['name'], url: r['url'] };
  }

  async commitMessage(
    options: { amend?: boolean; initial?: string; message?: string } = {},
  ): Promise<string | undefined> {
    const r = await this.form(options.amend ? 'Amend commit' : 'Commit', {
      message: options.message,
      fields: [{ key: 'message', label: 'Message', value: options.initial ?? '', multiline: true }],
      submitLabel: options.amend ? 'Amend' : 'Commit',
    });
    return r?.['message'];
  }

  async stashMessage(scope: StashScope = 'all', includeUntracked = false): Promise<string | undefined> {
    const titles = {
      all: 'Stash changes',
      staged: 'Stash staged changes',
      unstaged: 'Stash unstaged changes',
    };
    const r = await this.form(
      includeUntracked && scope === 'all' ? 'Stash including untracked' : titles[scope],
      {
        message:
          scope === 'unstaged'
            ? 'Your staged changes stay in place. The stash also holds a copy of them, so commit them before applying it back.'
            : undefined,
        fields: [{ key: 'message', label: 'Message (optional)', optional: true }],
        submitLabel: 'Stash',
      },
    );
    return r?.['message'];
  }

  async unsavedChoice(
    count: number,
    action: 'commit' | 'stash' = 'commit',
  ): Promise<'save' | 'skip' | undefined> {
    const Verb = action === 'commit' ? 'Commit' : 'Stash';
    return (await this.choose('Unsaved files', {
      message: `${count} ${plural(count, 'file has', 'files have')} unsaved changes. Only what is saved to disk can be ${action === 'commit' ? 'committed' : 'stashed'}.`,
      legend: 'What to do with unsaved files',
      submitLabel: 'Continue',
      initial: 'save',
      options: [
        { value: 'save', label: `Save All & ${Verb}` },
        { value: 'skip', label: `${Verb} Without Saving`, hint: 'unsaved edits stay in the editor' },
      ],
    })) as 'save' | 'skip' | undefined;
  }

  /** `validate` is supplied by the caller (e.g. `(v) => git.checkBranchName(v)`); this never calls git. */
  async branchName(
    title: string,
    submitLabel: string,
    options: {
      message?: string;
      initial?: string;
      validate?: (v: string) => string | null | Promise<string | null>;
    } = {},
  ): Promise<string | undefined> {
    const r = await this.form(title, {
      message: options.message,
      fields: [
        { key: 'name', label: 'Branch name', value: options.initial ?? '', validate: options.validate },
      ],
      submitLabel,
    });
    return r?.['name'];
  }

  /** What to do when local changes would be overwritten by checkout (git's own refusal, not asked up front). */
  async overwriteStrategy(target: string): Promise<OverwriteStrategy | undefined> {
    return (await this.choose(`Switch to ${target}`, {
      message: 'Your local changes would be overwritten by checkout.',
      legend: 'What to do with your changes',
      submitLabel: 'Checkout',
      initial: 'stash',
      options: [
        { value: 'stash', label: 'Stash & Checkout', hint: 'restore later from the stash list' },
        {
          value: 'migrate',
          label: 'Migrate Changes',
          hint: 'apply them on the new branch, may conflict',
        },
        { value: 'force', label: 'Force Checkout', hint: 'discards your changes', danger: true },
      ],
    })) as OverwriteStrategy | undefined;
  }

  /** Pick a branch. Resolves to the branch name. */
  pickBranch(
    title: string,
    branches: GitBranch[],
    options: { submitLabel: string; message?: string; danger?: boolean },
  ): Promise<string | undefined> {
    return this.pick(title, {
      message: options.message,
      placeholder: 'Search branches',
      searchLabel: 'Branch',
      submitLabel: options.submitLabel,
      danger: options.danger,
      emptyText: 'No branches.',
      items: branches.map((b) => ({
        value: b.name,
        label: b.name,
        hint: b.current ? 'current' : b.remote ? 'remote' : undefined,
      })),
    });
  }

  /** Pick a remote name (origin, upstream...). */
  pickRemote(title: string, remotes: string[], submitLabel: string): Promise<string | undefined> {
    return this.pick(title, {
      items: remotes.map((r) => ({ value: r, label: r })),
      submitLabel,
      emptyText: 'This repository has no remotes.',
    });
  }

  // ───────────── internals ─────────────

  private async open<R>(component: Type<unknown>, title: string, data: unknown): Promise<R | undefined> {
    const ref = this.dialog.open(component as any, { title, data });
    return (await firstValueFrom(ref.closed, { defaultValue: undefined })) as R | undefined;
  }
}
