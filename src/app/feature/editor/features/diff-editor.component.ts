// Imports: as in the code editor component, plus DiffSide from diff-tab.ts.

import {
  Component,
  inject,
  DestroyRef,
  viewChild,
  ElementRef,
  signal,
  afterNextRender,
  effect,
  untracked,
  computed,
} from '@angular/core';
import { EditorCommands } from '../editor.commands';
import { EditorService } from '../services/editor.service';
import { ModelSourceService } from '../services/model-source.service';
import { DiffSide } from './diff-tab';
import { NodeStore } from '../../../core/store/node.store';
import { TabStore } from '../../../core/store/tab.store';

type DiffHandle = NonNullable<Awaited<ReturnType<EditorService['mountDiffEditor']>>>;

@Component({
  selector: 'diff-editor',
  standalone: true,
  template: `
    <div class="toolbar">
      <span class="title" [title]="path()">{{ title() }}</span>
      <div class="actions">
        <button type="button" title="Previous change (Shift+F7)" (click)="go('previous')">↑</button>
        <button type="button" title="Next change (F7)" (click)="go('next')">↓</button>
        <button
          type="button"
          [class.on]="inline()"
          title="Inline view"
          (click)="inline.set(!inline())"
        >
          Inline
        </button>
        <button
          type="button"
          [class.on]="hideUnchanged()"
          title="Collapse unchanged regions"
          (click)="hideUnchanged.set(!hideUnchanged())"
        >
          Collapse
        </button>
        <button
          type="button"
          [class.on]="ignoreWhitespace()"
          title="Ignore whitespace"
          (click)="ignoreWhitespace.set(!ignoreWhitespace())"
        >
          Ignore ␣
        </button>
        <!-- <button type="button" title="Open the file in the editor" (click)="openFile()">
          Open file
        </button> -->
        <button type="button" title="Open the file in the editor">Open file</button>
      </div>
    </div>
    <div class="body">
      <div class="host" #host></div>
      @if (message(); as text) {
        <div class="overlay">{{ text }}</div>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      background: var(--base-bg, #1e1e1e);
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex: none;
      height: 28px;
      padding: 0 8px;
      border-bottom: 1px solid #3e4452;
      color: var(--explorer-text);
      font-size: 12px;
    }
    .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions {
      display: flex;
      gap: 4px;
      flex: none;
    }
    .actions button {
      padding: 2px 8px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .actions button:hover {
      background: var(--explorer-item-hover-bg, #2c313c);
    }
    .actions button.on {
      border-color: #4aa5f0;
    }
    .body {
      position: relative;
      flex: 1;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .host {
      position: absolute;
      inset: 0;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--base-bg, #1e1e1e);
      color: var(--explorer-text);
      opacity: 0.9;
    }
  `,
})
export class DiffEditorComponent {
  private readonly tabs = inject(TabStore);
  private readonly commands = inject(EditorCommands);
  private readonly sources = inject(ModelSourceService);
  private readonly editorService = inject(EditorService);
  private readonly store = inject(NodeStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly diffHost = viewChild.required<ElementRef<HTMLElement>>('host');

  /** Set once the editor is mounted; the effects below wait for it. */
  private readonly handle = signal<DiffHandle | null>(null);

  /** Diff tab id -> the sides it holds a model for. */
  private readonly held = new Map<string, DiffSide[]>();

  /** The file behind the editable (modified) side of the shown diff, for Ctrl+S. */
  private editableFileId: string | null = null;

  inline = signal(false);
  hideUnchanged = signal(true);
  ignoreWhitespace = signal(false);
  private run = 0;

  private resizeObserver?: ResizeObserver;
  private layoutFrame = 0;
  message = signal<string | null>(null);

  title = computed(() => {
    return this.tabs.diffTabs()[this.tabs.activeTabId()].title;
  });
  path = computed(() => {
    return this.tabs.diffTabs()[this.tabs.activeTabId()].request.modified.path;
  });

  constructor() {
    afterNextRender(() => this.init());

    // Show the focused diff, loading its sides the first time.
    effect(() => {
      const handle = this.handle();
      if (!handle) return;
      this.editorService.modelsVersion(); // a renamed file gets a new model: show it again
      const tabId = this.tabs.activeTabId();
      untracked(() => void this.show(handle, tabId));
    });

    // Release the models of diffs that are no longer open.
    effect(() => {
      const open = new Set(Object.keys(this.tabs.diffTabs()));
      untracked(() => {
        for (const tabId of [...this.held.keys()]) {
          if (!open.has(tabId)) this.releaseHeld(tabId);
        }
      });
    });

    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      cancelAnimationFrame(this.layoutFrame);
    });
  }

  private async init(): Promise<void> {
    const host = this.diffHost().nativeElement;
    const handle = await this.editorService.mountDiffEditor(host, this.destroyRef, {
      onSave: () => {
        const id = this.editableFileId;
        if (id) void this.commands.saveFile(id);
      },
    });
    if (!handle) return; // destroyed while Monaco was loading

    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = requestAnimationFrame(() => handle.layout());
    });
    this.resizeObserver.observe(host);

    this.handle.set(handle);
  }

  private async show(handle: DiffHandle, tabId: string | null): Promise<void> {
    const run = ++this.run;
    const tab = tabId ? this.tabs.diffTabs()[tabId] : undefined;
    if (!tab) {
      this.editableFileId = null;
      this.message.set('This file is no longer part of the repository.');
      return handle.detach(); // a file tab (or none) is focused
    }

    const { original, modified } = tab.request;
    // Recorded first, so a half-loaded diff is still released when its tab closes.
    this.held.set(tab.id, [original, modified]);

    const [originalModel, modifiedModel] = await Promise.all([
      this.sources.acquire(tab.id, original),
      this.sources.acquire(tab.id, modified),
    ]);

    if (!this.tabs.diffTabs()[tab.id]) return this.releaseHeld(tab.id); // closed while loading
    if (run !== this.run) return; // another tab was focused meanwhile

    if (!originalModel || !modifiedModel) {
      this.editableFileId = null;
      this.message.set('This file is no longer part of the repository.');
      return handle.detach(); // e.g. the working file was deleted
    }

    // Only the working copy can be edited from a diff.
    const editable = modified.kind === 'worktree';
    this.editableFileId = editable ? modified.fileId : null;
    handle.show(tab.id, originalModel, modifiedModel, editable);
  }

  private releaseHeld(tabId: string): void {
    this.held.get(tabId)?.forEach((side) => this.sources.release(tabId, side));
    this.held.delete(tabId);
  }

  go(direction: 'next' | 'previous') {
    this.handle()?.goToDiff(direction);
  }

  //   async openFile() {
  //   const tab = this.activeTab();
  //   const absolute = tab && this.git.absolutePathOf(tab.path);
  //   if (absolute) await this..openPath(absolute);
  // }
}
