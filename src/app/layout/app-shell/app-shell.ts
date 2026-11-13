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
  lucideChevronRight,
  lucideCloudUpload,
  lucideFolderRoot,
  lucideGitBranch,
  lucideGitCommitHorizontal,
  lucideGitGraph,
  lucideOctagonX,
  lucideRefreshCcw,
  lucideTerminalSquare,
} from '@ng-icons/lucide';
import { DiagnosticsService } from '../../core/services/diagnostics.service';
import { LspBridgeService } from '../../core/services/lsp/lsp-bridge.service';
import { GitService } from '../../feature/git/services/git.service';
import { MonitoringService } from '../../core/services/monitoring.service';
import { CommonModule } from '@angular/common';
import { loadIconSprite } from '../../shared/utils/icon-sprite';
import { MenuDirective } from '../../shared/directives/menu.directive';
import { Tab, TabStore } from '../../core/store/tab.store';
import { GitClient } from '../../feature/git/services/git-client.service';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [LeftPanel, MainPanel, NgIcon, CommonModule, MenuDirective],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideChevronRight,
      lucideFolderRoot,
      lucideGitBranch,
      lucideGitCommitHorizontal,
      lucideCloudUpload,
      lucideRefreshCcw,
      lucideGitGraph,
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
  readonly gitClient = inject(GitClient);
  readonly ngZone = inject(NgZone);
  readonly lsp = inject(LspBridgeService);
  protected tabStore = inject(TabStore);
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
  currentBranch = computed(() => {
    const status = this.git.status();
    return status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch');
  });
  gitChangesCount = computed(() => {
    const staged = this.git.staged();
    const unstaged = this.git.unstaged();
    return staged.length + unstaged.length;
  });
  readonly needsPublish = computed(() => {
    const s = this.git.status();
    return !!s?.branch && !s.upstream;
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

      if (root) untracked(() => void this.watcher.start(root));
    });
  }
  async ngOnInit() {
    this.ngZone.run(async () => {
      await loadIconSprite();
      await this.editorService.load();
    });
    this.isMaximized.set(await this.currentWindow.isMaximized());
  }

  async saveFile() {
    const id = this.tabStore.activeTabId();
    if (!id || !this.tabStore.isDirty(id)) return;
    const tab: Tab = this.tabStore.openedTabs()[id];
    if (tab.type !== 'CodeEditor' && tab.type !== 'DiffEditor') return;
    if (this.tabStore.isDiffTab(id)) {
      const modified = this.tabStore.diffTabs()[id].request.modified;
      if (modified.kind === 'worktree') {
        return await this.commands.saveFile(modified.fileId);
      }
      return;
    } else {
      return await this.commands.saveFile(id);
    }
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
  protected async openFile() {
    const files = await this.nodeStore.addStandaloneFiles();
    for (const id of files) {
      this.commands.openFile(id);
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
  async publishBranch() {
    this.gitClient.publishBranch();
  }
}
