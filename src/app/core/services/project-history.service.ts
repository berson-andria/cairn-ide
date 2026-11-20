import { Injectable, inject, signal } from '@angular/core';
import { WorkApiService, type ProjectHistorySnapshot } from './tauri/work-api.service';
import { NoticeManager } from './notification/notification.service';
import { handleApiError } from './tauri/api-error';

const EMPTY_HISTORY: ProjectHistorySnapshot = { lastProject: null, projects: [] };

@Injectable({ providedIn: 'root' })
export class ProjectHistoryService {
  private readonly api = inject(WorkApiService);
  private readonly notices = inject(NoticeManager);
  readonly history = signal<ProjectHistorySnapshot>(EMPTY_HISTORY);

  async refresh(): Promise<void> {
    try {
      this.history.set(await this.api.projectHistory());
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.api.projectHistoryRemove(path);
      await this.refresh();
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.api.projectHistoryClear();
      await this.refresh();
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async openInNewWindow(path?: string): Promise<void> {
    try {
      await this.api.windowNew(path);
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }
}
