// close-handler.service.ts
import { Injectable, inject } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PersistenceService } from './persistance.service';
import { WorkspaceNodeStore } from '../store/workspace/workspace.store';

@Injectable({ providedIn: 'root' })
export class CloseHandlerService {
  private persistence = inject(PersistenceService);
  private workspace = inject(WorkspaceNodeStore); // your store, expose a snapshot() that returns WorkspaceState

  async register() {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        // await this.persistence.saveOnClose(this.workspace.snapshot());
      } finally {
        await win.destroy(); // not close(), which would re-trigger this handler
      }
    });
  }
}
