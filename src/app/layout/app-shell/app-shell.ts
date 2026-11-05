import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  NgZone,
  signal,
  untracked,
} from '@angular/core';
import { MainPanel } from '../panels/main/main';
import { LeftPanel } from '../panels/left-panel/left-panel';
import { NodeStore } from '../../core/store/node.store';
import { WorkspaceWatcherService } from '../../core/services/file-system/workspace-watcher.service';
import { getCurrentWindow, Window, currentMonitor } from '@tauri-apps/api/window';

import { EditorCommands } from '../../feature/editor/editor.commands';
import { EditorService } from '../../feature/editor/services/editor.service';
import { LayoutService, Toolkit } from '../../core/services/layout.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAlertTriangle,
  lucideBraces,
  lucideChevronDown,
  lucideFolderRoot,
  lucideGitBranch,
  lucideOctagonX,
  lucideTerminalSquare,
} from '@ng-icons/lucide';
import { DiagnosticsService } from '../../core/services/diagnostics.service';
import { LspBridgeService } from '../../core/services/lsp/lsp-bridge.service';
import { GitService } from '../../feature/git/services/git.service';
import { MonitoringService } from '../../core/services/monitoring.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [LeftPanel, MainPanel, NgIcon, CommonModule],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideFolderRoot,
      lucideGitBranch,
      lucideOctagonX,
      lucideAlertTriangle,
      lucideBraces,
    }),
  ],
})
export class AppShell {
  readonly layoutService = inject(LayoutService);
  readonly nodeStore = inject(NodeStore);
  readonly watcher = inject(WorkspaceWatcherService);
  readonly commands = inject(EditorCommands);
  readonly editorService = inject(EditorService);
  readonly git = inject(GitService);
  readonly ngZone = inject(NgZone);
  readonly lsp = inject(LspBridgeService);
  readonly monitoring = inject(MonitoringService);

  protected readonly project = computed(() => {
    return this.nodeStore.rootName() ? this.nodeStore.rootName() : 'cairn-ide';
  });
  protected readonly nextReview = 'Retry once on network failure';
  protected readonly model = 'qwen-local';
  protected readonly counts = inject(DiagnosticsService).counts;

  currentWindow: Window;
  hasActiveProject = false;

  isMonacoLoading = signal(true);
  isMaximized = signal(false);
  gitChangesCount = computed(() => {
    const staged = this.git.staged();
    const unstaged = this.git.unstaged();
    return staged.length + unstaged.length;
  });
  cursorPosition = computed(() => {
    return {
      line: this.monitoring.editorData()?.cursorPosition?.line,
      col: this.monitoring.editorData()?.cursorPosition?.col,
    };
  });

  constructor() {
    this.currentWindow = getCurrentWindow();
    effect(() => {
      const root = this.nodeStore.rootPath();
      console.log(this.nodeStore.rootName(), this.counts());

      if (root) untracked(() => void this.watcher.start(root));
    });
  }
  async ngOnInit() {
    this.ngZone.run(async () => {
      try {
        const monitor = await currentMonitor();

        if (monitor) {
          await this.currentWindow.maximize();
        }
        await this.currentWindow.show();
        // await this.currentWindow.setFocus();
      } catch (err) {
        console.error('Failed to dynamically set window scale:', err);
        await this.currentWindow.show();
      } finally {
        await this.editorService.load();
      }
    });
    this.isMaximized.set(await this.currentWindow.isMaximized());
  }
  protected minimize(): void {
    void this.withWindow((w) => w.minimize());
  }
  protected toggleMaximize(): void {
    void this.withWindow((w) => w.toggleMaximize());
  }
  protected close(): void {
    void this.withWindow((w) => w.close());
  }

  protected toggleToolkit(toolkit: Toolkit) {
    if (this.layoutService.activeToolkit() === toolkit) {
      this.layoutService.toggleBottomPanel();
    } else if (!this.layoutService.isBottomPanelCollapsed()) {
      this.layoutService.toggleToolkit(toolkit);
    } else {
      this.layoutService.toggleToolkit(toolkit);
      this.layoutService.toggleBottomPanel();
    }
  }

  private async withWindow(
    action: (w: import('@tauri-apps/api/window').Window) => Promise<unknown>,
  ): Promise<void> {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await action(getCurrentWindow());
    } catch {
      /* not running inside Tauri */
    }
  }
}
