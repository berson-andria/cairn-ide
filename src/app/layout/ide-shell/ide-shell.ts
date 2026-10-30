import { CommonModule } from '@angular/common';
import { MonitoringService } from './../../core/services/monitoring.service';
import { AfterViewInit, Component, ElementRef, OnDestroy, inject, viewChild } from '@angular/core';
import { ActivityBar } from '../panels/activity-bar/ativity-bar';
import { LayoutService } from '../../core/services/layout.service';
import { Editor } from '../../features/editor/editor';
import { FileTree } from '../../features/explorer/tree';
import { ToolingPanel } from '../../features/tooling/tooling';
import { AIChatPanel } from '../../features/ai-chat/ai-chat';
import { Todo } from '../../features/todo/todo';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFileBracesCorner } from '@ng-icons/lucide';
import { GitCommit } from '../../features/git/commit/commit';
import { Notes } from '../../features/note/notes';
import { GitGraph } from '../../features/git/graph/graph';
import { EditorTabsStore } from '../../core/store/editor-tabs.store';
import { LspBridgeService } from '../../features/tooling/lsp-bridge.service';
import { DiagnosticsService } from '../../core/services/diagnostics.service';
import { ToolingService } from '../../features/tooling/tooling.service';

@Component({
  selector: 'ide-shell',
  imports: [
    CommonModule,
    ActivityBar,
    FileTree,
    GitCommit,
    Notes,
    Todo,
    AIChatPanel,
    Editor,
    ToolingPanel,
    GitGraph,
  ],
  templateUrl: './ide-shell.html',
  styleUrl: './ide-shell.scss',
  providers: [provideIcons({ lucideFileBracesCorner })],
})
export class IdeShell implements AfterViewInit, OnDestroy {
  layoutService = inject(LayoutService);
  tabStore = inject(EditorTabsStore);
  monitoringService = inject(MonitoringService);
  /** Injecting the bridge starts the LSP -> Problems / Output wiring. */
  lsp = inject(LspBridgeService);
  tooling = inject(ToolingService);
  problemCounts = inject(DiagnosticsService).counts;

  private readonly workspace = viewChild.required<ElementRef<HTMLElement>>('workspace');

  ngAfterViewInit(): void {
    // The service writes the panel sizes as CSS variables on this element.
    this.layoutService.registerWorkspace(this.workspace().nativeElement);
  }

  ngOnDestroy(): void {
    this.layoutService.registerWorkspace(null);
  }

  toggleExplorer(): void {
    this.layoutService.togglePrimarySideBar();
  }
}
