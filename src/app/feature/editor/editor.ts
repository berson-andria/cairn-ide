import { provideIcons } from '@ng-icons/core';
import { Component, computed, inject, Signal } from '@angular/core';
import { bootstrapX } from '@ng-icons/bootstrap-icons';
import { CommonModule } from '@angular/common';
import { NodeStore } from '../../core/store/node.store';
import { EditorService } from './services/editor.service';
import { CodeEditor } from './features/code-editor.component';
import { DiffEditor } from './features/diff-editor.component';
import { TabStore } from '../../core/store/tab.store';
import { baseName } from './features/diff-tab';
import { FileIcon } from '../../shared/components/file-icon';

@Component({
  selector: 'text-editor',
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  imports: [CommonModule, CodeEditor, DiffEditor, FileIcon],
  providers: [provideIcons({ bootstrapX })],
})
export class Editor {
  nodeStore = inject(NodeStore);
  tabStore = inject(TabStore);
  editorService = inject(EditorService);

  activeTab = this.tabStore.activeTab;
  activeTabType = this.tabStore.activeTabType;

  /** The kind of editor currently active ('CodeEditor' | 'DiffEditor' | null). */
  activeKind = computed<'CodeEditor' | 'DiffEditor' | null>(() => {
    const type = this.tabStore.activeTabType();
    if (type === 'CodeEditor' || type === 'DiffEditor') {
      return type;
    }
    return null;
  });

  name = computed(() => {
    const active = this.tabStore.activeTab();
    if (!active) return '';

    if (active.type === 'DiffEditor') {
      const diff = this.tabStore.diffTabs()[active.id];
      if (diff) {
        return baseName(diff.request.modified.path);
      }
      return 'diff';
    }

    if (active.type === 'CodeEditor') {
      const node = this.nodeStore.nodes()[active.id];
      const name = node?.name ?? active.title ?? 'file';
      return name;
    }

    return 'file';
  });

  isCodeEditor = computed(() => this.activeKind() === 'CodeEditor');
  isDiffEditor = computed(() => this.activeKind() === 'DiffEditor');

  hasDiffTabs = computed(
    () =>
      this.tabStore.openedTabs().some((t) => t.type === 'DiffEditor') ||
      Object.keys(this.tabStore.diffTabs()).length > 0,
  );

  filePath: Signal<string[]> = computed(() => {
    const active = this.tabStore.activeTab();
    if (!active) return [];

    if (active.type === 'DiffEditor') {
      const diff = this.tabStore.diffTabs()[active.id];
      const path = diff ? diff.request.modified.path : null;
      return path ? this.getFilePathArray(path, this.nodeStore.rootPath()) : [];
    }

    if (active.type === 'CodeEditor') {
      const node = this.nodeStore.nodes()[active.id];
      const path = node?.path;
      return path ? this.getFilePathArray(path, this.nodeStore.rootPath()) : [];
    }

    return [];
  });

  getFilePathArray(path: string, rootPath: string | null) {
    if (!path) {
      return [];
    }
    path = this.normalizePath(path, rootPath);
    return path.split('\\');
  }

  normalizePath(path: string, rootPath: string | null) {
    path = this.sanitizePath(path);
    let normalizedPath =
      rootPath && path.includes(rootPath)
        ? path.split(this.sanitizePath(rootPath) + '\\')[1]
        : path;
    return normalizedPath;
  }

  private sanitizePath(path: string): string {
    return path.replace(/[\/]/g, '\\');
  }
}
