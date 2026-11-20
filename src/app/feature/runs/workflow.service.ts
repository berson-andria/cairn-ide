import { Injectable, inject, signal } from '@angular/core';
import { NoticeManager } from '../../core/services/notification/notification.service';
import { handleApiError } from '../../core/services/tauri/api-error';
import { WorkApiService } from '../../core/services/tauri/work-api.service';
import type { WorkflowInfo, WorkflowInspect } from '../../shared/models/agent.model';

@Injectable({ providedIn: 'root' })
export class WorkflowService {
  private readonly api = inject(WorkApiService);
  private readonly notices = inject(NoticeManager);
  private readonly _workflows = signal<WorkflowInfo[]>([]);
  private refreshPromise?: Promise<void>;
  private generation = 0;

  readonly workflows = this._workflows.asReadonly();

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    let request: Promise<void>;
    request = this.api
      .workflowList()
      .then(workflows => {
        if (generation === this.generation) this._workflows.set(workflows);
      })
      .catch(error => handleApiError(error, this.notices))
      .finally(() => {
        if (this.refreshPromise === request) this.refreshPromise = undefined;
      });
    this.refreshPromise = request;
    return request;
  }

  async inspect(name: string): Promise<WorkflowInspect | undefined> {
    try {
      return await this.api.workflowInspect(name);
    } catch (error) {
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  clear(): void {
    this.generation++;
    this._workflows.set([]);
    this.refreshPromise = undefined;
  }
}
