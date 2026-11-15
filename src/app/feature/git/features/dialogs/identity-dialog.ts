import { Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { FormsModule } from '@angular/forms';
import { GitService } from '../../services/git.service';
import { DIALOG_STYLES } from './dialog-shared';

export interface GitIdentity {
  name: string;
  email: string;
}

/** Opened through DialogService; closes with the saved identity, or undefined if cancelled. */
@Component({
  selector: 'git-identity-dialog',
  standalone: true,
  imports: [FormsModule],
  styles: [DIALOG_STYLES, `
    .identity { display: flex; flex-direction: column; }
    .identity > label { display: block; margin: 0 0 var(--space-6); font-size: var(--font-size-small); color: var(--color-text-secondary); }
    .identity > input { box-sizing: border-box; width: 100%; margin-bottom: var(--space-10); padding: var(--space-6) var(--space-8); border: 1px solid var(--color-border); border-radius: var(--radius-chip); background: var(--color-surface-panel); color: var(--color-text-primary); font: inherit; outline: none; }
    .identity > input:focus { border-color: var(--color-action); }
    .identity > input.invalid { border-color: var(--color-error-fg); }
    .field-error { margin: calc(-1 * var(--space-8)) 0 var(--space-8); font-size: var(--font-size-small); color: var(--color-error-fg); }
    .scope { margin: var(--space-4) 0 0; padding: 0; border: 0; }
    .scope legend { margin-bottom: var(--space-4); padding: 0; color: var(--color-text-faint); text-transform: uppercase; font-size: var(--font-size-label); }
    .radio { display: flex; align-items: center; gap: var(--space-8); padding: var(--space-4) var(--space-8); border-radius: var(--space-4); }
    .radio:hover { background: var(--color-surface-raised); }
    .hint { margin-top: var(--space-8); }
    .error { padding: var(--space-6) var(--space-8); border-radius: var(--radius-chip); background: var(--color-error-bg); color: var(--color-error-fg); }
  `],
  template: `
    <form class="identity" (ngSubmit)="save()" novalidate>
      <p class="lead">
        Git puts a name and an email on every commit you make. Enter the ones you want to appear on
        yours.
      </p>

      <label for="git-name">Name</label>
      <input
        id="git-name"
        name="name"
        type="text"
        autocomplete="name"
        placeholder="Ada Lovelace"
        [class.invalid]="showErrors() && nameError()"
        [(ngModel)]="nameValue"
      />
      @if (showErrors() && nameError(); as message) {
        <span class="field-error">{{ message }}</span>
      }

      <label for="git-email">Email</label>
      <input
        id="git-email"
        name="email"
        type="email"
        autocomplete="email"
        placeholder="ada@example.com"
        [class.invalid]="showErrors() && emailError()"
        [(ngModel)]="emailValue"
      />
      @if (showErrors() && emailError(); as message) {
        <span class="field-error">{{ message }}</span>
      }

      <fieldset class="scope">
        <legend>Use this for</legend>
        <label class="check radio">
          <input
            type="radio"
            name="scope"
            [checked]="scope() === 'global'"
            (change)="scope.set('global')"
          />
          All repositories on this computer
        </label>
        <label class="check radio">
          <input
            type="radio"
            name="scope"
            [checked]="scope() === 'local'"
            (change)="scope.set('local')"
          />
          This repository only
        </label>
      </fieldset>

      <p class="hint">
        This only sets who your commits are credited to. Pushing and pulling use your own
        credentials (an SSH key or an HTTPS login), which you set up outside this app.
      </p>

      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }

      <div class="actions">
        <button type="button" class="btn-primary" (click)="cancel()">Cancel</button>
        <button type="submit" class="btn-action" [disabled]="saving()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </form>
  `,
})
export class GitIdentityDialog {
  private git = inject(GitService);
  private dialogRef = inject<DialogRef<GitIdentity | undefined>>(DialogRef);
  private rawData = inject(DIALOG_DATA, { optional: true }) as any;

  nameValue = signal('');
  emailValue = signal('');
  scope = signal<'global' | 'local'>('global');
  saving = signal(false);
  error = signal<string | null>(null);
  /** Field errors only appear after the first Save attempt, so the form isn't red before anyone typed. */
  showErrors = signal(false);

  nameError = computed(() => {
    const value = this.nameValue().trim();
    if (!value) return 'Enter your name.';
    if (value.startsWith('-')) return 'A name cannot start with "-".';
    return null;
  });

  emailError = computed(() => {
    const value = this.emailValue().trim();
    if (!value) return 'Enter your email.';
    if (value.startsWith('-') || !/^[^\s@]+@[^\s@]+$/.test(value))
      return 'Enter a valid email address.';
    return null;
  });

  constructor() {
    // DialogService wraps the child's data as { title, childComponent, childData }. Depending on how
    // DialogWrapper builds the child's injector, this token holds either that wrapper or the child's
    // own data: take whichever it is.
    const data =
      this.rawData && 'childData' in this.rawData ? this.rawData.childData : this.rawData;
    this.nameValue.set(data?.name ?? '');
    this.emailValue.set(data?.email ?? '');
  }

  async save() {
    this.showErrors.set(true);
    if (this.nameError() || this.emailError() || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);
    const result = await this.git.setIdentity(this.nameValue(), this.emailValue(), this.scope());
    this.saving.set(false);

    if (!result.ok) {
      this.error.set(result.error || 'Git could not save this.');
      return; // stay open so it can be corrected and retried
    }
    this.dialogRef.close({ name: this.nameValue().trim(), email: this.emailValue().trim() });
  }

  cancel() {
    this.dialogRef.close(undefined);
  }
}
