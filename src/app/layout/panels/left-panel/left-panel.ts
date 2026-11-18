import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';
import { FileTree } from '../../../feature/explorer/tree';
import { ReviewList } from '../../../feature/review/review-list';
import { NoteList } from '../../../feature/notes/note-list/note-list';
import { LayoutService } from '../../../core/services/layout.service';
import { GitChanges } from '../../../feature/git/features/changes/git-changes';
import { TaskList } from '../../../feature/tasks/task-list/task-list';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFiles, lucideListChecks, lucideNotebookPen, lucideGitMerge } from '@ng-icons/lucide';
import { TabStore } from '../../../core/store/tab.store';
import { GitService } from '../../../feature/git/services/git.service';
import { EmptyExplorer } from '../../../feature/explorer/empty-explorer';
import { NodeStore } from '../../../core/store/node.store';

@Component({
  selector: 'left-panel',
  standalone: true,
  imports: [
    ResizeHandle,
    TaskList,
    FileTree,
    NoteList,
    ReviewList,
    GitChanges,
    EmptyExplorer,
    NgIcon,
  ],
  templateUrl: './left-panel.html',
  styleUrl: './left-panel.scss',
  providers: [provideIcons({ lucideFiles, lucideGitMerge, lucideListChecks, lucideNotebookPen })],
  host: {
    '[style.width.px]': 'width()',
    '[class.collapsed]': 'layout.isLefPanelCollapsed()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeftPanel {
  protected readonly nodeStore = inject(NodeStore);
  protected readonly layout = inject(LayoutService);
  protected readonly width = signal<number | null>(null);
  protected readonly minWidth = 200;

  protected readonly tabStore = inject(TabStore);
  protected readonly git = inject(GitService);

  gitChangesCount = computed(() => {
    const staged = this.git.staged();
    const unstaged = this.git.unstaged();
    return staged.length + unstaged.length;
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** At most half of the shell body. Re-evaluated on every drag move. */
  protected readonly maxWidth = () => this.host.nativeElement.parentElement!.clientWidth * 0.5;
}
