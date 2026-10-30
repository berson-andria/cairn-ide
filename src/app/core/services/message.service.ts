import { Injectable } from '@angular/core';
import { ask, MessageDialogResult, message } from '@tauri-apps/plugin-dialog';

@Injectable({
  providedIn: 'root',
})
export class MessageService {
  async confirmDelete(names: string[]): Promise<boolean> {
    const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
    return ask(
      `Permanently delete ${what}?\n\nThis cannot be undone, and unsaved changes in open files inside will be lost.`,
      { title: 'Delete', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' },
    );
  }
  async askReloadChangedFile(name: string): Promise<boolean> {
    return ask(
      `"${name}" was changed on disk, but you also have unsaved changes in the editor.\n\nReload from disk and discard your changes?`,
      {
        title: 'File changed on disk',
        kind: 'warning',
        okLabel: 'Reload from disk',
        cancelLabel: 'Keep my changes',
      },
    );
  }

  askSaveDirtyFiles(count: number): Promise<MessageDialogResult> {
    return message(`You have ${count} unsaved work.\n\nSave files and close?`, {
      title: 'Close Unsaved Files',
      kind: 'warning',
      buttons: {
        yes: 'Save All',
        no: 'Don`t save',
        cancel: 'Cancel',
      },
    });
  }

  askSaveDirtyFile(fileName: string) {
    return message('You have unsaved changes in ' + fileName + '.\n Would you like to save them?', {
      title: 'Unsaved changes',
      kind: 'warning',
      buttons: {
        yes: 'Save',
        no: 'Don`t save',
        cancel: 'Cancel',
      },
    });
  }
}
