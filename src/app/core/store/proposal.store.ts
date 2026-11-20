import { Injectable, computed, inject, signal } from '@angular/core';
import type { Proposal } from '../../shared/models/agent.model';
import { WorkApiService, type StorageError } from '../services/tauri/work-api.service';

@Injectable({ providedIn: 'root' })
export class ProposalStore {
  private readonly api = inject(WorkApiService);
  private readonly _records = signal<Record<string, Proposal>>({});
  private readonly _errors = signal<StorageError[]>([]);
  private readonly _loaded = signal(false);
  private refreshPromise?: Promise<void>;
  private generation = 0;

  readonly records = this._records.asReadonly();
  readonly errors = this._errors.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly all = computed(() => Object.values(this.records()));

  upsert(proposal: Proposal): void {
    this._records.update(records =>
      !records[proposal.id] || proposal.rev > records[proposal.id].rev
        ? { ...records, [proposal.id]: proposal }
        : records,
    );
  }

  remove(id: string): void {
    this._records.update(records => {
      const next = { ...records };
      delete next[id];
      return next;
    });
  }

  replace(proposals: Proposal[], errors: StorageError[]): void {
    this._records.set(Object.fromEntries(proposals.map(proposal => [proposal.id, proposal])));
    this._errors.set(errors);
    this._loaded.set(true);
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    let request: Promise<void>;
    request = this.api
      .proposalList()
      .then(result => {
        if (generation === this.generation) this.replace(result.records, result.errors);
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
    this._errors.set([]);
    this._loaded.set(false);
    this.refreshPromise = undefined;
  }
}
