import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DIALOG_STYLES } from './dialog-shared';

export type CredentialsMode = 'https' | 'ssh';

export interface GitCredentialsResult {
  /** Only set in https mode. */
  username?: string;
  /** Token / password (https) or key passphrase (ssh). */
  secret: string;
  remember: boolean;
}

@Component({
  selector: 'app-git-credentials-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    DIALOG_STYLES,
    `
      .mono {
        font-family: var(--font-mono);
        font-size: var(--font-size-code-sm);
        color: var(--color-text-primary);
      }
      .help {
        margin-top: var(--space-6);
        font-size: var(--font-size-small);
        line-height: var(--line-height-ui);
        color: var(--color-text-muted);
      }
    `,
  ],
  template: `
    @if (mode() === 'https') {
      <h2>Sign in to {{ host() }}</h2>
      @if (rejected()) {
        <p>Authentication failed. Check your username and token.</p>
      } @else {
        <p>Git needs your credentials to push to <span class="mono">{{ repo() }}</span>.</p>
      }

      <div class="field">
        <label for="gc-user">Username</label>
        <div class="input-form">
          <input
            id="gc-user"
            type="text"
            autocomplete="username"
            [value]="username()"
            (input)="usernameOverride.set($any($event.target).value)"
          />
        </div>
      </div>
    } @else {
      <h2>Unlock SSH key</h2>
      <p>Enter the passphrase for <span class="mono">{{ keyPath() }}</span>.</p>
    }

    <div class="field">
      <label for="gc-secret">{{ mode() === 'https' ? 'Token or password' : 'Passphrase' }}</label>
      <div class="input-form" [class.invalid]="rejected()">
        <input
          id="gc-secret"
          [type]="visible() ? 'text' : 'password'"
          autocomplete="current-password"
          [value]="secret()"
          [attr.aria-invalid]="rejected()"
          [attr.aria-describedby]="describedBy()"
          (input)="secret.set($any($event.target).value)"
          (keydown.enter)="submit()"
        />
        <button
          type="button"
          class="icon-btn"
          [attr.aria-label]="visible() ? 'Hide password' : 'Show password'"
          [attr.aria-pressed]="visible()"
          (click)="visible.set(!visible())"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            aria-hidden="true"
          >
            <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
            <circle cx="8" cy="8" r="2" />
            @if (visible()) {
              <path d="M2.5 13.5l11-11" />
            }
          </svg>
        </button>
      </div>

      @if (rejected()) {
        <div class="error" id="gc-secret-error" role="alert">Those credentials were rejected.</div>
      } @else if (passwordHint()) {
        <div class="help" id="gc-secret-hint">{{ passwordHint() }}</div>
      }
    </div>

    <label class="check">
      <input
        type="checkbox"
        [checked]="rememberValue()"
        (change)="rememberOverride.set($any($event.target).checked)"
      />
      {{ mode() === 'https' ? 'Remember on this computer' : 'Remember until I close Cairn' }}
    </label>

    <div class="actions">
      <button type="button" class="btn-primary" (click)="cancelled.emit()">Cancel</button>
      <button type="button" class="btn-action" [disabled]="!canSubmit()" (click)="submit()">
        {{ submitLabel() }}
      </button>
    </div>
  `,
})
export class GitCredentialsDialogComponent {
  /** 'https' asks for username + token; 'ssh' asks for a key passphrase. */
  readonly mode = input<CredentialsMode>('https');
  /** https: host shown in the title, e.g. "github.com". */
  readonly host = input('');
  /** https: repository shown in the intro, e.g. "owner/repo". */
  readonly repo = input('');
  /** ssh: path of the key being unlocked, e.g. "~/.ssh/id_ed25519". */
  readonly keyPath = input('');
  /** Pre-filled username (https). */
  readonly initialUsername = input('');
  /** Set after a failed attempt: shows the error state and "Try Again". */
  readonly rejected = input(false);
  /** Optional hint under the password field, hidden while `rejected` is true. */
  readonly passwordHint = input('');
  /** Action label, e.g. "Push" gives "Sign in and Push" / "Unlock and Push". */
  readonly action = input('Push');

  readonly submitted = output<GitCredentialsResult>();
  readonly cancelled = output<void>();

  protected readonly usernameOverride = signal<string | null>(null);
  protected readonly username = computed(() => this.usernameOverride() ?? this.initialUsername());
  protected readonly secret = signal('');
  protected readonly visible = signal(false);

  /** https remembers by default; ssh does not. */
  protected readonly rememberOverride = signal<boolean | null>(null);
  protected readonly rememberValue = computed(
    () => this.rememberOverride() ?? this.mode() === 'https',
  );

  protected readonly canSubmit = computed(
    () => !!this.secret() && (this.mode() === 'ssh' || !!this.username().trim()),
  );

  protected readonly submitLabel = computed(() => {
    if (this.mode() === 'ssh') return `Unlock and ${this.action()}`;
    return this.rejected() ? 'Try Again' : `Sign in and ${this.action()}`;
  });

  protected readonly describedBy = computed(() => {
    if (this.rejected()) return 'gc-secret-error';
    return this.passwordHint() ? 'gc-secret-hint' : null;
  });

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.submitted.emit({
      username: this.mode() === 'https' ? this.username().trim() : undefined,
      secret: this.secret(),
      remember: this.rememberValue(),
    });
  }
}
