import { Component, computed, inject } from '@angular/core';
import { LayoutService } from '../../../core/services/layout.service';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapFolder, bootstrapSearch } from '@ng-icons/bootstrap-icons';
import {
  lucideListTodo,
  lucideContainer,
  lucideTerminal,
  lucideSettings2,
  lucidePlay,
  lucideAlertOctagon,
  lucideLogs,
  lucideGitCommit,
  lucideGitGraph,
} from '@ng-icons/lucide';
import { NgClass } from '@angular/common';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { BadgeDirective } from '../../../shared/directives/badge.directive';
import { TerminalService } from '../../../features/tooling/terminal/terminal.service';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { Settings } from '../../../features/setting/settings';

@Component({
  selector: 'activity-bar',
  templateUrl: './activity-bar.html',
  styleUrl: './activity-bar.scss',
  imports: [NgIcon, NgClass, BadgeDirective],
  providers: [
    provideIcons({
      bootstrapFolder,
      bootstrapSearch,
      lucideGitCommit,
      lucideGitGraph,
      lucideListTodo,
      lucideContainer,
      lucideTerminal,
      lucideSettings2,
      lucideLogs,
      lucidePlay,
      lucideAlertOctagon,
    }),
  ],
})
export class ActivityBar {
  layoutService = inject(LayoutService);
  nodeStore = inject(WorkspaceNodeStore);
  terminalService = inject(TerminalService);
  dialogService = inject(DialogService);

  dirtyFileCount = computed(() => {
    const fileNodes = Object.values(this.nodeStore.nodes()).filter(
      (value) => 'content' in value && value.isDirty,
    );
    return fileNodes.length;
  });

  toggleLeftPanelContent(activePrimaryPanel: 'Explorer' | 'Commit' | 'Graph') {
    if (
      this.layoutService.isPrimaryPanelCollapsed() ||
      activePrimaryPanel === this.layoutService.activePrimaryPanel()
    ) {
      this.layoutService.togglePrimarySideBar();
    }
    this.layoutService.setActivePrimaryPanel(activePrimaryPanel);
  }
  async toggleTerminalPanel() {
    const session = this.terminalService.sessions();
    if (!session.length && this.layoutService.isTerminalPanelCollapesed()) {
      try {
        await this.terminalService.create(this.nodeStore.rootPath());
      } catch (err) {
        console.error('Could not start a terminal', err);
      }
    }
    this.layoutService.toggleTerminalPanel();
  }

  openSetting() {
    this.dialogService.open(Settings, { width: 'fit-content' });
  }
}
