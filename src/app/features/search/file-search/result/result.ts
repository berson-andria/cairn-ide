import { Component, computed, inject, input, InputSignal } from '@angular/core';
import { getIconName } from '../../../../shared/utils/node.utils';
import { DialogRef } from '@angular/cdk/dialog';
import { EditorCommands } from '../../../editor/editor.commands';

@Component({
  selector: 'search-result',
  templateUrl: './result.html',
  styleUrl: './result.scss',
})
export class SearchResult {
  commands = inject(EditorCommands);
  dialogRef = inject(DialogRef);

  result: InputSignal<FileNameSearchResult> = input.required();
  rootPath: InputSignal<string | null> = input.required();
  keyword: InputSignal<string> = input.required();

  path = computed(() => {
    const path = this.result().path;
    return path.substring(0, path.lastIndexOf('\\')).split(<string>this.rootPath())[1];
  });

  open = true;

  getIconName() {
    return getIconName(this.result().fileName, 'file', false);
  }

  async openFile() {
    this.dialogRef.close();
    await this.commands.openPath(this.result().path);
  }
}
