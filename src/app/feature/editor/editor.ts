import { provideIcons } from '@ng-icons/core';
import { Component, computed, inject, Signal } from '@angular/core';
import { bootstrapX } from '@ng-icons/bootstrap-icons';
import { CommonModule } from '@angular/common';
import { WorkspaceNodeStore } from '../../core/store/workspace/workspace.store';
import { EditorService } from './services/editor.service';
import { EditorTabsStore } from '../../core/store/editor-tabs.store';
import { CodeEditorComponent } from './features/code-editor.component';
import { DiffEditorComponent } from './features/diff-editor.component';

@Component({
  selector: 'editor-panel',
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  imports: [CommonModule, CodeEditorComponent, DiffEditorComponent],
  providers: [provideIcons({ bootstrapX })],
})
export class Editor {
  nodeStore = inject(WorkspaceNodeStore);
  tabStore = inject(EditorTabsStore);
  editorService = inject(EditorService);

  activeKind = computed(() => {
    const id = this.tabStore.activeTabId();
    return id && this.tabStore.diffTabs()[id] ? 'diff' : 'file';
  });
  hasDiffTabs = computed(() => Object.keys(this.tabStore.diffTabs()).length > 0);

  filePath: Signal<string[]> = computed(() => {
    const id = this.tabStore.activeTabId();
    if (!id) return [];
    const diff = this.tabStore.diffTabs()[id];
    const path = diff ? diff.request.modified.path : this.nodeStore.nodes()[id]?.path;
    return path ? this.getFilePathArray(path, this.nodeStore.rootPath()) : [];
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
