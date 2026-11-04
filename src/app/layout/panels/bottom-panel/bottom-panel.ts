import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { ResizeHandle } from '../../../shared/components/resize-handle/resize-handle';
import { LayoutService } from '../../layout-service';
import { Git, GitView } from '../../../feature/git/git';
import { Terminal } from '../../../feature/terminal/terminal';
import { DiagnosticsService } from '../../../core/services/diagnostics.service';
import { TerminalService } from '../../../feature/terminal/terminal.service';
import { ToolingService, ToolId } from '../../../features/tooling/tooling.service';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMinus, lucidePlus } from '@ng-icons/lucide';

@Component({
  selector: 'bottom-panel',
  standalone: true,
  imports: [ResizeHandle, Terminal, Git, NgIcon],
  templateUrl: './bottom-panel.html',
  styleUrl: './bottom-panel.scss',
  host: {
    '[style.height.px]': 'height()',
    '[class.collapsed]': 'layoutService.isBottomPanelCollapsed()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [provideIcons({ lucidePlus, lucideMinus })],
})
export class BottomPanel {
  protected readonly layoutService = inject(LayoutService);
  protected readonly nodeStore = inject(WorkspaceNodeStore);

  protected readonly height = signal<number | null>(null);
  protected readonly minHeight = 100;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly maxHeight = () => this.host.nativeElement.parentElement!.clientHeight * 0.7;
  protected activeGitView: GitView = 'Changes';

  protected readonly tooling = inject(ToolingService);
  protected readonly terminals = inject(TerminalService);
  private readonly injector = inject(Injector);
  protected readonly counts = inject(DiagnosticsService).counts;

  constructor() {
    effect(() => {
      const terminalVisible = this.tooling.active() === 'terminal';
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
}
