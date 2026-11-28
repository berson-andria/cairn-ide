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
import { TabStore } from '../../../core/store/tab.store';

type DiffHandle = NonNullable<Awaited<ReturnType<EditorService['mountDiffEditor']>>>;

@Component({
  selector: 'diff-editor',
  standalone: true,
  template: `
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
export class DiffEditor {
  private readonly tabs = inject(TabStore);
  private readonly commands = inject(EditorCommands);
  private readonly sources = inject(ModelSourceService);
  private readonly editorService = inject(EditorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly diffHost = viewChild.required<ElementRef<HTMLElement>>('host');

  private readonly handle = signal<DiffHandle | null>(null);

  private readonly held = new Map<string, DiffSide[]>();

  private editableFileId: string | null = null;

  inline = signal(false);
  hideUnchanged = signal(true);
  ignoreWhitespace = signal(false);
  private run = 0;

  private resizeObserver?: ResizeObserver;
  private layoutFrame = 0;
  message = signal<string | null>(null);

  private activeDiffTab = computed(() => {
    const id = this.tabs.activeTabId();
    return id && this.tabs.activeTabType() === 'DiffEditor' ? this.tabs.diffTabs()[id] : undefined;
  });
  title = computed(() => this.activeDiffTab()?.title ?? '');
  path = computed(() => this.activeDiffTab()?.request.modified.path ?? '');

  constructor() {
    afterNextRender(() => this.init());
    effect(() => {
      const handle = this.handle();
      if (!handle) return;
      this.editorService.modelsVersion(); // a renamed file gets a new model: show it again
      const tabId = this.activeDiffTab()?.id ?? null;
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

    this.resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = requestAnimationFrame(() => handle.layout({ width, height }));
    });
    this.resizeObserver.observe(host.parentElement!);

    this.handle.set(handle);
  }

  private async show(handle: DiffHandle, tabId: string | null): Promise<void> {
    const run = ++this.run;
    const tab = tabId ? this.tabs.diffTabs()[tabId] : undefined;
    if (!tab) {
      this.editableFileId = null;
      this.message.set(null);
      return handle.detach(); // a file tab (or none) is focused
    }

    this.message.set(null);

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
