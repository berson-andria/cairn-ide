import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

@Injectable({
  providedIn: 'root',
})
export class TauriBridgeService {
  async invokeCommand<T>(cmd: string, args?: Record<string, any>): Promise<T> {
    return await invoke<T>(cmd, args);
  }

  async showFolderPicker(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Open Project Directory',
    });
    if (!selected || Array.isArray(selected)) return null;

    return Array.isArray(selected) ? selected[0] : selected;
  }

  async showFilePicker(): Promise<string[] | null> {
    const selected = await open({
      directory: false,
      multiple: true,
      title: 'Open files',
    });
    if (!selected) return null;

    return selected;
  }
}
