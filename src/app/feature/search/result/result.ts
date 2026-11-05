import { Component, computed, effect, inject, input, InputSignal, output } from '@angular/core';
import { getIconPath } from '../../../shared/utils/node.utils';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NodeStore } from '../../../core/store/node.store';
import { DialogRef } from '@angular/cdk/dialog';
import { lucideReplace, lucideReplaceAll } from '@ng-icons/lucide';
import { ReplacePreviewPipe } from '../../../shared/pipe/replace-preview.pipe';
import { SearchSnippetPipe } from '../../../shared/pipe/search-snippet.pipe';
import { EditorCommands } from '../../editor/editor.commands';
import { FileSearchResult, FileNameSearchResult, LineMatch } from '../search.model';

@Component({
  selector: 'search-result',
  templateUrl: './result.html',
  styleUrl: './result.scss',
  imports: [NgIcon, SearchSnippetPipe, ReplacePreviewPipe],
  providers: [
    provideIcons({ bootstrapChevronDown, bootstrapChevronRight, lucideReplace, lucideReplaceAll }),
  ],
})
export class SearchResult {
  command = inject(EditorCommands);
  dialogRef = inject(DialogRef, { optional: true });
  nodeStore = inject(NodeStore);

  // Accepts both FileSearchResult (text mode with line matches) and FileNameSearchResult (file mode)
  result: InputSignal<FileSearchResult | FileNameSearchResult> = input.required();
  rootPath: InputSignal<string | null> = input.required();
  keyword: InputSignal<string> = input.required();

  // Text search specific inputs (replace mode)
  replaceMode = input(false);
  pattern = input<RegExp | null>(null);
  replacement = input('');
  replaceLine = output<LineMatch>();
  replaceFile = output<void>();

  // Computed properties
  isTextResult = computed(() => {
    const r = this.result();
    return 'matches' in r; // FileSearchResult has matches, FileNameSearchResult doesn't
  });

  open = false;

  fileName = computed(() => {
    const r = this.result();
    if ('matches' in r) {
      // FileSearchResult: extract from path
      return r.path.split('\\').pop() || '';
    } else {
      // FileNameSearchResult: use fileName directly
      return r.fileName;
    }
  });

  filePath = computed(() => {
    const r = this.result();
    const fullPath = 'matches' in r ? r.path : r.path;
    return fullPath.substring(0, fullPath.lastIndexOf('\\'));
  });

  displayPath = computed(() => {
    const root = this.rootPath();
    const path = this.filePath();

    if (!root) return path;
    const parts = path.split(root);
    return parts[1] || path;
  });

  matchCount = computed(() => {
    const r = this.result();
    return 'matches' in r ? r.matches.length : 0;
  });

  matches = computed(() => {
    const r = this.result();
    return 'matches' in r ? r.matches : [];
  });

  constructor() {
    effect(() => {
      this.open = this.isTextResult() ? true : false;
    });
  }

  // Methods
  getIconPath() {
    return getIconPath(this.fileName(), 'file');
  }

  onReplaceLine(event: Event, line: LineMatch) {
    event.stopPropagation();
    this.replaceLine.emit(line);
  }

  onReplaceFile(event: Event) {
    event.stopPropagation();
    this.replaceFile.emit();
  }

  async openFile(lineNumber?: number) {
    this.dialogRef?.close();
    const r = this.result();
    const path = 'matches' in r ? r.path : r.path;

    if (lineNumber !== undefined) {
      // Text result: open at specific line
      await this.command.openPathAtLine(path, lineNumber, this.keyword());
    } else {
      // File result: just open the file
      await this.command.openPath(path);
    }
  }

  toggleOpen(event: Event) {
    event.stopPropagation();
    if (this.isTextResult()) this.open = !this.open;
  }
}
