import { Component, computed, inject, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchiveRestore,
  lucideArchiveX,
  lucideChevronDown,
  lucideCircleChevronRight,
  lucideHardDriveUpload,
} from '@ng-icons/lucide';
import { CommitFile, GitStash } from '../../parser/log.parser';
import { FileIcon } from '../../../../shared/components/file-icon';
import { getFileNameFromPath } from '../../../../shared/utils/node.utils';
import { GitService, LETTERS } from '../../services/git.service';
import { statusLabel, statusStyle } from '../../ui/git-ui';
import { GitDiffService } from '../../services/git-diff.service';
import { NoticeManager } from '../../../../core/services/notification/notification.service';
type StashFilesState = { status: 'loading' } | { status: 'ready'; files: CommitFile[] };

@Component({
  selector: 'git-stash',
  template: `
    <div class="stash" [class.expanded]="expanded" (click)="toggle()">
      <div class="accordion">
        @if (expanded) {
          <ng-icon name="lucideChevronDown" />
        } @else {
          <ng-icon name="lucideChevronRight" />
        }
      </div>
      <div class="content">
        <div class="message">
          <span class="msg">{{ stash().message }} </span>
          <div class="action">
            <button
              class="icon-btn"
              type="button"
              title="Stage file"
              (click)="$event.stopPropagation()"
            >
              <ng-icon name="lucideArchiveRestore " />
            </button>
            <button
              class="icon-btn"
              type="button"
              title="Stage file"
              (click)="$event.stopPropagation()"
            >
              <ng-icon name=" lucideHardDriveUpload" />
            </button>
            <button
              class="icon-btn"
              type="button"
              title="Stage file"
              (click)="$event.stopPropagation()"
            >
              <ng-icon name="lucideArchiveX " />
            </button>
          </div>
        </div>
        <div class="details">
          <span class="age"> {{ stash().age }} ● </span>
          <span class="ref">{{ stash().branch }}</span>
        </div>
      </div>
    </div>
    <div class="files">
      @if (expanded) {
        @let state = expandedFiles();
        <div class="xp">
          @if (state?.status === 'ready') {
            @for (file of state.files; track file.path) {
              <div class="file" (click)="openDiff(file)">
                <file-icon
                  [name]="getFileNameFromPath(file.path)"
                  [type]="'file'"
                  class="file-icon"
                />

                <div class="label">
                  <span class="file-name">
                    {{ getFileNameFromPath(file.path) }}
                  </span>
                  <span class="file-path">{{ file.path }}</span>
                </div>
                <div class="actions">
                  <span class="status" [style.color]="statusClass(LETTERS[file.status]).background">
                    {{ LETTERS[file.status] }}
                  </span>
                </div>
              </div>
            }
          } @else {
            <div class="xr">Loading files…</div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .stash {
      position: sticky;
      top: 0;
      background: var(--color-surface-panel);
      z-index: 10;
      display: flex;
      flex-direction: row;
      padding: var(--space-4);
      padding-left: var(--space-12);
      align-items: start;
      gap: var(--space-6);
      border-radius: var(--radius-chip);
      cursor: pointer;
      &:hover,
      &.expanded {
        background-color: var(--color-surface-hover);
      }

      .content {
        flex: 1;
      }

      .message {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;

        .action {
          height: fit-content;
          display: flex;
          flex-direction: row;
          gap: var(--space-6);
        }
      }

      .details {
        font-size: var(--font-size-micro);
        color: var(--color-text-faint);
      }

      button {
        padding: 0 !important;
      }
    }
    .files {
      .file {
        padding-left: var(--space-16);
      }
    }
    .file {
      display: flex;
      align-items: center;
      gap: var(--space-10);
      padding: var(--space-2) var(--space-2);
      padding-left: var(--space-16);
      border-radius: 0.25em;
      cursor: pointer;
      min-height: 27px;

      &:hover {
        background-color: var(--color-surface-hover);

        button {
          display: inline;
        }
      }

      button {
        display: none;
        margin-right: var(--space-4);
        padding: 0 !important;
        background: var(--color-surface-raised);

        &:hover {
          background-color: var(--color-surface-raised-hover);
        }
      }

      .file-icon {
        flex: 0 0 auto;
      }

      .file-name,
      .file-path {
        min-width: 0;
        text-wrap: nowrap;
      }

      .label {
        align-items: baseline;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .file-path {
        color: var(--color-text-faint);
        font-size: var(--font-size-ui);
      }

      .actions {
        flex: 1;
        display: flex;
        gap: var(--space-6);
        padding: var(--space-2) var(--space-8);
        border-radius: var(--space-6);
        justify-content: end;
        // background: var(--color-surface-raised);
      }

      .status {
        font-size: var(--font-size-micro);
        font-weight: var(--font-weight-medium);
        padding: var(--space-2) var(--space-6);
        border-radius: var(--radius-chip);
      }
    }
  `,
  imports: [NgIcon, FileIcon],
  providers: [
    provideIcons({
      lucideArchiveRestore,
      lucideArchiveX,
      lucideHardDriveUpload,
    }),
  ],
})
export class Stash {
  protected readonly git = inject(GitService);
  protected readonly gitDiff = inject(GitDiffService);
  protected readonly notices = inject(NoticeManager);
  stash = input.required<GitStash>();

  protected expanded = false;

  private readonly filesByHash = signal<Record<string, StashFilesState>>({});

  readonly expandedFiles = computed(() => {
    return this.filesByHash()[this.stash().hash] ?? null;
  });

  statusLabel = statusLabel;
  statusClass = statusStyle;
  getFileNameFromPath = getFileNameFromPath;
  LETTERS = LETTERS;

  async toggle(): Promise<void> {
    if (this.expanded) {
      this.expanded = false;
      return;
    }
    this.expanded = true;
    if (this.filesByHash()[this.stash().hash]) return; // cached or already loading

    this.filesByHash.update((m) => ({ ...m, [this.stash().hash]: { status: 'loading' } }));
    const files = await this.git.stashFiles(this.stash().hash);
    this.filesByHash.update((m) => ({ ...m, [this.stash().hash]: { status: 'ready', files } }));
  }

  async openDiff(file: CommitFile) {
    const request = this.gitDiff.requestForCommits(
      `${this.stash().hash}^`,
      this.stash().hash,
      file,
    );
    if (request) {
      const error = await this.gitDiff.open(request);
      if (error) this.notices.report({ ok: false, error: error });
    }
  }
}
