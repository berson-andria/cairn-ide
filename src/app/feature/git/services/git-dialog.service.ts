import { Injectable, Type, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { PickerDialogComponent, PickerDialogData } from '../features/dialogs/picker-dialog';
import { FormDialog, FormDialogData, FormDialogResult } from '../features/dialogs/form-dialog';

import { GitBranch } from '../parser/branch.parser';
import { GitService } from './git.service';
import { plural } from '../features/dialogs/dialog-shared';
import { ChoiceDialog, ChoiceDialogData } from '../features/dialogs/choice-dialog';
import { GitIdentityDialog } from '../features/dialogs/identity-dialog';

export type SwitchStrategy = 'stash' | 'carry' | 'discard';
export type OverwriteStrategy = 'stash' | 'migrate' | 'force';
/**
 * Single entry point for every Git dialog. It is a service (not a helper function) because
 * inject() only works while Angular is constructing something: calling it from a click handler
 * after an await throws NG0203.
 *
 * Confirmations (OK / Cancel) are NOT here: use confirmAction() from the Tauri dialog plugin.
 * Every method resolves to undefined when the user cancels.
 */
@Injectable({ providedIn: 'root' })
export class GitDialogService {
  private readonly git = inject(GitService);
  private readonly dialog = inject(DialogService);

  // ───────────── generic: pass a title and a data object ─────────────

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

  // ───────────── identity (own dialog: it has the global / local scope) ─────────────

  /** Resolves to true if an identity was saved, false if the user cancelled. */
  async identity(): Promise<boolean> {
    const current = await this.git.getIdentity();
    const ref = this.dialog.open(GitIdentityDialog, {
      title: 'Your Git identity',
      data: current,
    });
    return !!(await firstValueFrom(ref.closed, { defaultValue: undefined }));
  }

  /**
   * Asks for a login and stores it in the credential helper.
   *  'saved'     retry the git command
   *  'cancelled' user closed the dialog
   *  'no-helper' git has no credential helper, so nothing could remember the login
   *  'ssh'       the remote is SSH / local: there is no password to enter
   */
  async signIn(remote?: string): Promise<'saved' | 'cancelled' | 'no-helper' | 'ssh' | 'failed'> {
    const target = await this.git.credentialTarget(remote);
    if (!target) return 'ssh';
    if (!(await this.git.credentialHelper())) return 'no-helper';

    const r = await this.form(`Sign in to ${target.host}`, {
      message:
        'Use your username and a personal access token. Most hosts no longer accept account passwords.',
      fields: [
        { key: 'username', label: 'Username', value: target.username },
        { key: 'secret', label: 'Token', secret: true },
      ],
      submitLabel: 'Sign in',
    });
    if (!r) return 'cancelled';
    return (await this.git.saveCredentials(target, r['username'], r['secret'])).ok
      ? 'saved'
      : 'failed';
  }

  // ───────────── presets: the menu items, one line each ─────────────

  async cloneRepo(
    defaultDirectory: string,
  ): Promise<{ url: string; directory: string } | undefined> {
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

  /** Commit message box. When amending, an empty message keeps the previous one. */
  async commitMessage(
    options: { amend?: boolean; initial?: string } = {},
  ): Promise<string | undefined> {
    const r = await this.form(options.amend ? 'Amend commit' : 'Commit', {
      fields: [
        {
          key: 'message',
          label: 'Message',
          value: options.initial ?? '',
          multiline: true,
          optional: !!options.amend,
        },
      ],
      submitLabel: options.amend ? 'Amend' : 'Commit',
    });
    return r?.['message'];
  }

  /** Branch name validated by git itself (check-ref-format). */
  async branchName(
    title: string,
    submitLabel: string,
    options: { message?: string; initial?: string } = {},
  ): Promise<string | undefined> {
    const r = await this.form(title, {
      message: options.message,
      fields: [
        {
          key: 'name',
          label: 'Branch name',
          value: options.initial ?? '',
          validate: (v) => this.git.checkBranchName(v),
        },
      ],
      submitLabel,
    });
    return r?.['name'];
  }

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

  /** Optional stash message. Resolves to '' for "no message", undefined for cancel. */
  async stashMessage(includeUntracked = false): Promise<string | undefined> {
    const r = await this.form(includeUntracked ? 'Stash including untracked' : 'Stash changes', {
      fields: [{ key: 'message', label: 'Message (optional)', optional: true }],
      submitLabel: 'Stash',
    });
    return r?.['message'];
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

  /** What to do with uncommitted changes before switching branch. */
  async switchStrategy(target: string, changeCount: number): Promise<SwitchStrategy | undefined> {
    return (await this.choose(`Switch to ${target}?`, {
      message: `You have ${changeCount} uncommitted ${plural(changeCount, 'change', 'changes')}.`,
      legend: 'What to do with your changes',
      submitLabel: 'Switch Branch',
      initial: 'stash',
      options: [
        { value: 'stash', label: 'Stash and switch', hint: 'restore them later' },
        { value: 'carry', label: 'Bring changes along', hint: 'may conflict' },
        { value: 'discard', label: 'Discard changes and switch', danger: true },
      ],
    })) as SwitchStrategy | undefined;
  }

  // ───────────── internals ─────────────

  private async open<R>(
    component: Type<unknown>,
    title: string,
    data: unknown,
  ): Promise<R | undefined> {
    const ref = this.dialog.open(component as any, { title, data });
    // defaultValue: if the dialog is dismissed without a result (backdrop / Esc) we get undefined, not an error
    return (await firstValueFrom(ref.closed, { defaultValue: undefined })) as R | undefined;
  }
}
