import { Injectable, computed, inject } from '@angular/core';
import type { Patch, PatchSummary } from '../../../shared/models/agent.model';
import { NoticeManager } from '../notification/notification.service';
import { handleApiError } from '../tauri/api-error';
import { WorkApiService } from '../tauri/work-api.service';
import { PatchStore, patchKey } from '../../store/patch.store';

const PATCH_CACHE_LIMIT = 20;

@Injectable({ providedIn: 'root' })
export class PatchService {
  private readonly api = inject(WorkApiService);
  private readonly store = inject(PatchStore);
  private readonly notices = inject(NoticeManager);
  private readonly records = new Map<string, Patch>();

  readonly all = this.store.all;
  readonly pending = computed(() => this.all().filter((patch) => patch.status === 'pending'));

  forTask(taskId: string) {
    return computed(() => this.all().filter((patch) => patch.taskId === taskId));
  }

  forRun(runId: string) {
    return computed(() => this.all().filter((patch) => patch.runId === runId));
  }

  async refresh(): Promise<void> {
    try {
      await this.store.refresh();
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async load(runId: string, patchId: string): Promise<Patch | undefined> {
    const key = patchKey(runId, patchId);
    const cached = this.records.get(key);
    const summary = this.store.summary(runId, patchId);
    if (cached && (!summary || cached.status === summary.status)) {
      this.records.delete(key);
      this.records.set(key, cached);
      return cached;
    }
    try {
      const patch = await this.api.patchGet(runId, patchId);
      this.remember(key, patch);
      this.store.upsert(patch);
      return patch;
    } catch (error) {
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async apply(
    runId: string,
    patchId: string,
  ): Promise<{ kind: 'applied' } | { kind: 'conflict'; message: string } | undefined> {
    try {
      const summary = await this.api.patchApply(runId, patchId);
      this.store.upsert(summary);
      await this.refresh();
      return { kind: 'applied' };
    } catch (error) {
      if ((error as { code?: string })?.code === 'PatchConflict') {
        return { kind: 'conflict', message: (error as { message: string }).message };
      }
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async discard(runId: string, patchId: string): Promise<PatchSummary | undefined> {
    try {
      const summary = await this.api.patchDiscard(runId, patchId);
      this.store.upsert(summary);
      return summary;
    } catch (error) {
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  clear(): void {
    this.store.clear();
    this.records.clear();
  }

  private remember(key: string, patch: Patch): void {
    this.records.delete(key);
    this.records.set(key, patch);
    while (this.records.size > PATCH_CACHE_LIMIT) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}
