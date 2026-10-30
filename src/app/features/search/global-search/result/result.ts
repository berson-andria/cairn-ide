import { Component, computed, inject, input, InputSignal, output } from '@angular/core';
import { getIconName } from '../../../../shared/utils/node.utils';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { WorkspaceNodeStore } from '../../../../core/store/workspace/workspace.store';
import { DialogRef } from '@angular/cdk/dialog';
import { lucideReplace, lucideReplaceAll } from '@ng-icons/lucide';
import { ReplacePreviewPipe } from '../../../../shared/pipe/replace-preview.pipe';
import { SearchSnippetPipe } from '../../../../shared/pipe/search-snippet.pipe';
import { EditorCommands } from '../../../editor/editor.commands';

/** One matching line of a result, as the search reported it. */
export type LineMatch = FileSearchResult['matches'][number];

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
  dialogRef = inject(DialogRef);

  result: InputSignal<FileSearchResult> = input.required();
  rootPath: InputSignal<string | null> = input.required();
  keyword: InputSignal<string> = input.required();

  // Replace mode (driven by the search panel)
  replaceMode = input(false);
  /** Compiled search pattern, or null when it can't be used for replacing. */
  pattern = input<RegExp | null>(null);
  replacement = input('');
  replaceLine = output<LineMatch>();
  replaceFile = output<void>();

  fileName = computed(() => {
    const path = this.result().path;
    return path.split('\\').pop() || '';
  });

  path = computed(() => {
    const path = this.result().path;
    return path.substring(0, path.lastIndexOf('\\')).split(<string>this.rootPath())[1];
  });

  open = true;

  onReplaceLine(event: Event, line: LineMatch) {
    event.stopPropagation(); // the row itself opens the file
    this.replaceLine.emit(line);
  }

  onReplaceFile(event: Event) {
    event.stopPropagation(); // the header itself collapses the file
    this.replaceFile.emit();
  }

  getIconName() {
    return getIconName(this.fileName(), 'file', false);
  }

  async openFile(line: number) {
    this.dialogRef.close();
    await this.command.openPathAtLine(this.result().path, line, this.keyword());
  }
}
