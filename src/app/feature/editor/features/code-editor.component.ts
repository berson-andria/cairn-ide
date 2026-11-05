// Imports: keep your existing ones, minus NgZone, the monaco-editor types and NodeStore;
// add TabStore, EditorCommands, ModelSourceService, fileTabOwner.

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  DestroyRef,
  viewChild,
  ElementRef,
  signal,
  afterNextRender,
  effect,
  untracked,
} from '@angular/core';
import { LspManager } from '../../../core/services/lsp/lsp-manager.service';
import { MonitoringService } from '../../../core/services/monitoring.service';
import { EditorCommands } from '../editor.commands';
import { EditorService, fileTabOwner } from '../services/editor.service';
import { ModelSourceService } from '../services/model-source.service';
import { TabStore } from '../../../core/store/tab.store';

type Handle = NonNullable<Awaited<ReturnType<EditorService['mountEditor']>>>;
@Component({
  selector: 'code-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <div #host class="editor-host"></div> `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      .editor-host {
        position: absolute;
        inset: 0;
      }
      .hidden {
        visibility: hidden;
        opacity: 0;
      }
    `,
  ],
})
export class CodeEditorComponent {
  private readonly tabs = inject(TabStore);
  private readonly commands = inject(EditorCommands);
  private readonly sources = inject(ModelSourceService);
  private readonly editorService = inject(EditorService);
  private readonly monitoringService = inject(MonitoringService);
  private readonly lsp = inject(LspManager);
  private readonly destroyRef = inject(DestroyRef);
  private readonly codeEditorHost = viewChild.required<ElementRef<HTMLElement>>('host');

  /** Set once the editor is mounted; the effects below wait for it. */
  private readonly handle = signal<Handle | null>(null);
  private shownTabId: string | null = null;

  /** File ids this component holds a model for. */
  private readonly modelsHeld = new Set<string>();

  private resizeObserver?: ResizeObserver;
  private layoutFrame = 0;

  constructor() {
    afterNextRender(() => this.init());

    // Show the focused tab, creating its model the first time it is shown.
    effect(() => {
      const handle = this.handle();
      if (!handle) return;
      this.editorService.modelsVersion(); // a renamed file gets a new model: show it again
      const tabId = this.tabs.activeTabId();
      untracked(() => this.show(handle, tabId));
    });

    // Release the models of tabs that are no longer open.
    effect(() => {
      const open = new Set(this.tabs.openTabs());
      untracked(() => {
        for (const id of [...this.modelsHeld]) {
          if (open.has(id)) continue;
          this.editorService.releaseModel(id, fileTabOwner(id));
          this.modelsHeld.delete(id);
        }
      });
    });

    // The editor itself is disposed by the service (it was given our DestroyRef).
    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      cancelAnimationFrame(this.layoutFrame);
    });
  }

  private async init(): Promise<void> {
    await this.lsp.init();

    const host = this.codeEditorHost().nativeElement;
    const handle = await this.editorService.mountEditor(host, this.destroyRef, {
      onCursorChange: (p) => this.monitoringService.updatePostion(p.lineNumber, p.column),
      onSave: () => {
        const id = this.shownTabId;
        if (id) void this.commands.saveFile(id);
      },
    });
    if (!handle) return; // the component was destroyed while Monaco was loading

    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = requestAnimationFrame(() => handle.layout());
    });
    this.resizeObserver.observe(host);

    this.handle.set(handle);
  }

  private show(handle: Handle, tabId: string | null): void {
    // A diff tab (or no tab) has no file model here, so the editor shows nothing.
    const model = tabId ? this.sources.acquireFile(fileTabOwner(tabId), tabId) : null;
    if (tabId && model) this.modelsHeld.add(tabId);

    this.shownTabId = model ? tabId : null;
    handle.show(this.shownTabId);
    if (this.shownTabId) handle.focus();

    // The status bar follows the editor.
    if (!tabId) this.monitoringService.resetEditorData();
    else if (model) {
      this.monitoringService.setEditorInfo({
        language: this.editorService.getModel(tabId)?.getLanguageId() ?? 'Plaintext',
        cursorPostion: null,
      });
    }
  }
}
