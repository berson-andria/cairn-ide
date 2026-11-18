import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  ElementRef,
  Injector,
  effect,
  afterNextRender,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucidePlus,
  lucideMinus,
  lucideGitBranch,
  lucideRotateCcw,
  lucideRefreshCcw,
  lucideEllipsis,
  lucideChevronRight,
  lucideUnlink,
  lucideCloudUpload,
  lucideSearch,
} from '@ng-icons/lucide';

import { DiagnosticsService } from '../../../core/services/diagnostics.service';
import { LayoutService } from '../../../core/services/layout.service';
import { NodeStore } from '../../../core/store/node.store';
import { OutputPanel } from '../../../feature/output/output';
import { Problems } from '../../../feature/problems/problems';
import { TerminalService } from '../../../feature/terminal/terminal.service';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';
import { convertToDaysAndHours } from '../../../shared/utils/utils';
import { Terminal } from '../../../feature/terminal/terminal';
import { GitGraph } from '../../../feature/git/features/graph/graph';
import { GitService } from '../../../feature/git/services/git.service';
import { GitClient } from '../../../feature/git/services/git-client.service';

@Component({
  selector: 'bottom-panel',
  standalone: true,
  imports: [ResizeHandle, Terminal, GitGraph, Problems, OutputPanel, NgIcon],
  templateUrl: './bottom-panel.html',
  styleUrl: './bottom-panel.scss',
  host: {
    '[style.height.px]': 'height()',
    '[class.collapsed]': 'layoutService.isBottomPanelCollapsed()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    provideIcons({
      lucidePlus,
      lucideMinus,
      lucideGitBranch,
      lucideRotateCcw,
      lucideRefreshCcw,
      lucideEllipsis,
      lucideChevronRight,
      lucideUnlink,
      lucideCloudUpload,
      lucideSearch,
    }),
  ],
})
export class BottomPanel {
  protected readonly layoutService = inject(LayoutService);
  protected readonly nodeStore = inject(NodeStore);
  private readonly client = inject(GitClient);
  protected readonly git = inject(GitService);
  protected readonly height = signal<number | null>(null);
  protected readonly minHeight = 100;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly maxHeight = () => this.host.nativeElement.parentElement!.clientHeight * 0.7;

  protected readonly terminals = inject(TerminalService);
  private readonly injector = inject(Injector);
  protected readonly counts = inject(DiagnosticsService).counts;

  filterProblems = signal('');
  branchFilter = signal('');
  newBranch = signal('');
  readonly query = signal('');
  readonly scope = signal<'all' | 'head'>('all');

  convertToDaysAndHours = convertToDaysAndHours;
  constructor() {
    effect(() => {
      const terminalVisible =
        this.layoutService.isToolkitActive('Terminal') &&
        !this.layoutService.isBottomPanelCollapsed();
      if (terminalVisible) {
        afterNextRender(() => this.terminals.activeSession()?.term.focus(), {
          injector: this.injector,
        });
      }
    });
  }

  protected createNewSession(): void {
    void this.terminals.create(this.nodeStore.rootPath());
  }

  protected toggleScope() {
    this.scope.update((s) => (s === 'all' ? 'head' : 'all'));
  }
  protected fetch() {
    return this.client.fetch();
  }

  protected onFilterProblems(event: Event): void {
    this.filterProblems.set((event.target as HTMLInputElement).value);
  }
}
