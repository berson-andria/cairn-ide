import {
  Component,
  computed,
  effect,
  inject,
  NgZone,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IdeShell } from './layout/ide-shell/ide-shell';
import { getCurrentWindow, Window, currentMonitor } from '@tauri-apps/api/window';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  bootstrapDashLg,
  bootstrapSquare,
  bootstrapFiles,
  bootstrapXLg,
  bootstrapLayoutWtf,
  bootstrapChevronRight,
  bootstrapSearch,
  bootstrapChevronDown,
} from '@ng-icons/bootstrap-icons';
import { CdkMenuModule } from '@angular/cdk/menu';
import { LayoutService } from './core/services/layout.service';
import { ThemeConfigService } from './core/services/theme.service';
import { HttpClient } from '@angular/common/http';
import {
  lucideAudioWaveform,
  lucideChevronDown,
  lucideListTodo,
  lucideNotepadText,
} from '@ng-icons/lucide';
import { getIconName } from './shared/utils/node.utils';
import { EditorService } from './features/editor/services/editor.service';
import { WorkspaceWatcherService } from './core/services/workspace-watcher.service';
import { WorkspaceNodeStore } from './core/store/workspace/workspace.store';
import { EditorCommands } from './features/editor/editor.commands';
import { EditorTabsStore } from './core/store/editor-tabs.store';
import { TerminalService } from './features/tooling/terminal/terminal.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, IdeShell, NgIcon, CdkMenuModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  providers: [
    provideIcons({
      bootstrapDashLg,
      bootstrapSquare,
      bootstrapFiles,
      bootstrapXLg,
      lucideAudioWaveform,
      lucideNotepadText,
      bootstrapLayoutWtf,
      bootstrapChevronRight,
      lucideChevronDown,
      bootstrapSearch,
      bootstrapChevronDown,
      lucideListTodo,
    }),
  ],
})
export class AppComponent implements OnInit {
  ngZone = inject(NgZone);
  http = inject(HttpClient);

  readonly nodeStore = inject(WorkspaceNodeStore);
  readonly watcher = inject(WorkspaceWatcherService);
  readonly commands = inject(EditorCommands);
  readonly editorService = inject(EditorService);
  readonly tabStore = inject(EditorTabsStore);
  readonly terminalService = inject(TerminalService);

  themConfigService = inject(ThemeConfigService);
  layoutService = inject(LayoutService);

  currentWindow: Window;
  hasActiveProject = false;

  isMonacoLoading = signal(true);
  isMaximized = signal(false);
  nodeName = signal('');
  // nodeName = computed(() => {
  //   return this.nodeStore.activeTabId() && !isDiffTabId(this.nodeStore.activeTabId())
  //     ? this.nodeStore.nodes()[<string>this.nodeStore.activeTabId()].name
  //     : '';
  // });
  // starts the effects that keep tabs, models and the tree in step

  constructor() {
    this.currentWindow = getCurrentWindow();
    effect(() => {
      const root = this.nodeStore.rootPath();
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
        this.themConfigService.flushThemeColorsToCssVariables();
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

  triggerAction(actionName: string) {
    console.log(`Triggered: ${actionName}`);
  }

  async closeWindow() {
    await this.currentWindow.close();
  }

  getIconName(nodeName: string, nodeType: string, isExpanded: boolean) {
    return getIconName(nodeName, nodeType, isExpanded);
  }
  toggleSecondaryPanelContent(activeSecondaryPanel: 'Agent' | 'Todo' | 'Note') {
    if (
      this.layoutService.isSecondaryPanelCollapesed() ||
      activeSecondaryPanel === this.layoutService.activeSecondaryPanel()
    ) {
      this.layoutService.toggleSecondarySideBar();
    }
    this.layoutService.setActiveSecondaryPanel(activeSecondaryPanel);
  }

  async minimizeWindow() {
    await this.currentWindow.minimize();
  }

  async toggleMaximize() {
    this.ngZone.run(async () => {
      try {
        if (this.isMaximized()) {
          await this.currentWindow.unmaximize();
        } else {
          await this.currentWindow.maximize();
        }
        this.isMaximized.set(await this.currentWindow.isMaximized());
      } catch (err) {
        console.error('Window toggle failed:', err);
      }
    });
  }

  async saveFile() {
    await this.commands.saveFile(this.tabStore.activeTabId());
    // await this.nodeStore.saveFile(<string>this.nodeStore.activeTabId());
  }

  async saveFiles() {
    await this.commands.saveAll();
  }
  async openFile() {
    const files = await this.nodeStore.addStandaloneFiles();
    if (!files) return;
    for (const id of files) {
      await this.commands.openFile(id);
    }
  }

  // private pollAndInitializeTheme() {
  //   this.themConfigService.flushThemeColorsToCssVariables();
  //   console.log('One Dark Pro Theme loaded successfully into Monaco!');
  // }
}
