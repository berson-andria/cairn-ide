// core/tauri/tauri-boot.service.ts
import { Injectable, inject } from '@angular/core';

interface BootPayload {
  settings: any;
  activeFolder: string;
  recentFolders: string[];
}

@Injectable({ providedIn: 'root' })
export class TauriBootService {
  //   private settingsState = inject(SettingsService);

  async initApplication() {
    try {
      // Single invoke to get all data at once on startup
      // Distribute data to dedicated domain handlers
      // this.folderState.setActiveProject(payload.folder);
      // this.folderState.setRecentFolder(payload.recentHistory);
      //   this.settingsState.setSettings(payload.settings);
    } catch (error) {
      console.error('Failed to bootstrap IDE state from Tauri backend', error);
    }
  }
}
