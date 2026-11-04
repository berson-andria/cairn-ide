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
import { WorkspaceNodeStore } from '../../core/store/workspace/workspace.store';
import { WorkspaceWatcherService } from '../../core/services/workspace-watcher.service';
import { getCurrentWindow, Window, currentMonitor } from '@tauri-apps/api/window';
import { EditorTabsStore } from '../../core/store/editor-tabs.store';
import { EditorCommands } from '../../features/editor/editor.commands';
import { EditorService } from '../../features/editor/services/editor.service';
import { TerminalService } from '../../features/tooling/terminal/terminal.service';
import { LayoutService, Toolkit } from '../layout-service';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [LeftPanel, MainPanel],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShell {
  readonly layoutService = inject(LayoutService);
  readonly nodeStore = inject(WorkspaceNodeStore);
  readonly watcher = inject(WorkspaceWatcherService);
  readonly commands = inject(EditorCommands);
  readonly editorService = inject(EditorService);
  readonly tabStore = inject(EditorTabsStore);
  readonly terminalService = inject(TerminalService);
  readonly ngZone = inject(NgZone);

  protected readonly project = computed(() => {
    return this.nodeStore.rootName() ? this.nodeStore.rootName() : 'cairn-ide';
  });
  protected readonly nextReview = 'Retry once on network failure';
  protected readonly gitChanged = 4;
  protected readonly problems = 3;
  protected readonly model = 'qwen-local';

  currentWindow: Window;
  hasActiveProject = false;

  isMonacoLoading = signal(true);
  isMaximized = signal(false);

  constructor() {
    this.currentWindow = getCurrentWindow();
    effect(() => {
      const root = this.nodeStore.rootPath();
      console.log(this.nodeStore.rootName());

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
