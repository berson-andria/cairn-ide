import { Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { FormsModule } from '@angular/forms';
// Adjust to your folders.
import { GitService } from './services/git.service';

export interface GitIdentity {
  name: string;
  email: string;
}

/** Opened through DialogService; closes with the saved identity, or undefined if cancelled. */
@Component({
  selector: 'git-identity-dialog',
  standalone: true,
  imports: [FormsModule],
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
        <label class="radio">
          <input
            type="radio"
            name="scope"
            [checked]="scope() === 'global'"
            (change)="scope.set('global')"
          />
          All repositories on this computer
        </label>
        <label class="radio">
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
        <button type="button" class="secondary" (click)="cancel()">Cancel</button>
        <button type="submit" class="primary" [disabled]="saving()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .identity {
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: var(--explorer-text);
    }
    .lead {
      margin: 0 0 6px;
    }
    label {
      font-size: 12px;
      opacity: 0.8;
      margin-top: 6px;
    }
    input[type='text'],
    input[type='email'] {
      padding: 6px 8px;
      border: 1px solid var(--explorer-item-hover-bg, #3e4452);
      border-radius: 4px;
      background: var(--explorer-bg);
      color: inherit;
      font: inherit;
      outline: none;
    }
    input.invalid {
      border-color: #d73445;
    }
    .field-error {
      color: #e05561;
      font-size: 12px;
    }
    .scope {
      margin: 10px 0 0;
      padding: 0;
      border: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .scope legend {
      padding: 0;
      font-size: 12px;
      opacity: 0.8;
    }
    .radio {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      font-size: inherit;
      opacity: 1;
    }
    .hint {
      margin: 10px 0 0;
      font-size: 12px;
      opacity: 0.7;
    }
    .error {
      margin: 6px 0 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: #9f2732;
      color: #fff;
      font-size: 12px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
    button {
      padding: 6px 14px;
      border: 0;
      border-radius: 4px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      background: #4aa5f0;
      color: #10151c;
    }
    button.secondary {
      background: transparent;
      color: inherit;
      border: 1px solid var(--explorer-item-hover-bg, #3e4452);
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
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
    console.log(typeof this.nameValue);
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
