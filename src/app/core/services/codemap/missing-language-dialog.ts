import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { CodeMapService, MissingLanguage } from './codemap.service';
import { DIALOG_STYLES } from '../../../feature/git/features/dialogs/dialog-shared';

export interface MissingLanguageDialogData {
  languages: MissingLanguage[];
}

@Component({
  selector: 'app-missing-language-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    DIALOG_STYLES,
    `
      .intro { margin-bottom: var(--space-10); }
      .language-list { display: flex; flex-direction: column; gap: var(--space-2); }
      .language { display: flex; align-items: center; gap: var(--space-8); padding: var(--space-6) var(--space-8); border-radius: var(--space-4); }
      .language:hover { background: var(--color-surface-raised); }
      .language input { accent-color: var(--color-action); }
      .language-name { flex: 1; font-weight: var(--font-weight-medium); }
      .file-count { color: var(--color-text-faint); font-size: var(--font-size-small); }
      .error { margin-top: var(--space-8); color: var(--color-error-fg); }
    `,
  ],
  template: `
    <p class="intro">
      Code map support is missing for these languages. Install their parsers to index symbols and
      navigate code.
    </p>

    <div class="language-list">
      @for (language of data.languages; track language.name) {
        <label class="language">
          <span class="language-name">{{ language.name }}</span>
          <span class="file-count">{{ language.files }} {{ language.files === 1 ? 'file' : 'files' }}</span>
          <input
            type="checkbox"
            [checked]="dontAskAgain()[language.name] ?? service.isLanguageDismissed(language.name)"
            (change)="setDontAskAgain(language.name, $any($event.target).checked)"
            [attr.aria-label]="'Don’t ask again for ' + language.name"
          />
          <span class="hint">Don’t ask again</span>
        </label>
      }
    </div>

    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    <div class="actions">
      <button type="button" class="btn-primary" (click)="close()">Not now</button>
      <button type="button" class="btn-action" [disabled]="installing()" (click)="install()">
        {{ installing() ? 'Installing…' : 'Install' }}
      </button>
    </div>
  `,
})
export class MissingLanguageDialog {
  private readonly ref = inject<DialogRef<'installed' | undefined>>(DialogRef);
  private readonly rawData = inject(DIALOG_DATA, { optional: true }) as
    | { childData?: MissingLanguageDialogData }
    | MissingLanguageDialogData
    | null;
  protected readonly data: MissingLanguageDialogData =
    this.rawData && 'childData' in this.rawData
      ? (this.rawData.childData ?? { languages: [] })
      : ((this.rawData as MissingLanguageDialogData | null) ?? { languages: [] });
  protected readonly service = inject(CodeMapService);
  protected readonly dontAskAgain = signal<Record<string, boolean>>({});
  protected readonly installing = signal(false);
  protected readonly error = signal<string | null>(null);

  protected setDontAskAgain(name: string, value: boolean): void {
    this.dontAskAgain.update((current) => ({ ...current, [name]: value }));
  }

  protected async install(): Promise<void> {
    if (this.installing()) return;
    this.installing.set(true);
    this.error.set(null);
    try {
      await this.service.installLanguages(this.data.languages.map(({ name }) => name));
      this.savePreferences();
      this.ref.close('installed');
    } catch (error) {
      this.error.set(typeof error === 'string' ? error : 'Could not install language support.');
    } finally {
      this.installing.set(false);
    }
  }

  protected close(): void {
    this.savePreferences();
    this.ref.close(undefined);
  }

  private savePreferences(): void {
    for (const { name } of this.data.languages) {
      this.service.setLanguageDismissed(name, this.dontAskAgain()[name] ?? false);
    }
  }
}
