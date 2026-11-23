import { Injectable, computed, inject, signal } from '@angular/core';
import type { PatchSummary } from '../../shared/models/agent.model';
import { WorkApiService } from '../services/tauri/work-api.service';

export function patchKey(runId: string, patchId: string): string {
  return `${runId}/${patchId}`;
}

@Injectable({ providedIn: 'root' })
export class PatchStore {
  private readonly api = inject(WorkApiService);
  private readonly _records = signal<Record<string, PatchSummary>>({});
  private refreshPromise?: Promise<void>;
  private generation = 0;

  readonly records = this._records.asReadonly();
  readonly all = computed(() => Object.values(this.records()));

  summary(runId: string, patchId: string): PatchSummary | undefined {
    return this.records()[patchKey(runId, patchId)];
  }

  upsert(patch: PatchSummary): void {
    const key = patchKey(patch.runId, patch.id);
    this._records.update((records) => {
      const current = records[key];
      if (current) {
        if (patch.createdAt < current.createdAt) return records;
        if (
          patch.createdAt === current.createdAt
          && current.status !== 'pending'
          && patch.status !== current.status
        ) return records;
        if (
          patch.createdAt === current.createdAt
          && current.status === 'pending'
          && patch.status === 'pending'
        ) {
          return { ...records, [key]: patch };
        }
      }
      return { ...records, [key]: patch };
    });
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    let request: Promise<void>;
    request = this.api
      .patchList()
      .then((patches) => {
        if (generation === this.generation) patches.forEach((patch) => this.upsert(patch));
      })
      .finally(() => {
        if (this.refreshPromise === request) this.refreshPromise = undefined;
      });
    this.refreshPromise = request;
    return request;
  }

  clear(): void {
    this.generation++;
    this._records.set({});
    this.refreshPromise = undefined;
  }
}
