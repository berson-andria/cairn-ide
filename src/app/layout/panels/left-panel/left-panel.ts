import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';
import { FileTree } from '../../../feature/explorer/tree';
import { ReviewList } from '../../../feature/review/review-list';
import { NoteList } from '../../../feature/notes/note-list/note-list';
import { LayoutService } from '../../../core/services/layout.service';
import { GitChanges } from '../../../feature/git/features/changes/git-changes';
import { TaskList } from '../../../feature/tasks/task-list/task-list';

@Component({
  selector: 'left-panel',
  standalone: true,
  imports: [ResizeHandle, TaskList, FileTree, NoteList, ReviewList, GitChanges],
  templateUrl: './left-panel.html',
  styleUrl: './left-panel.scss',
  host: { '[style.width.px]': 'width()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeftPanel {
  protected readonly layout = inject(LayoutService);
  protected readonly width = signal<number | null>(null);
  protected readonly minWidth = 200;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** At most half of the shell body. Re-evaluated on every drag move. */
  protected readonly maxWidth = () => this.host.nativeElement.parentElement!.clientWidth * 0.5;
}
