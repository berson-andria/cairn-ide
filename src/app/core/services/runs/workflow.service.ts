import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  TrustState,
  TrustSummary,
  WorkflowInfo,
  WorkflowTrustReview,
  WorkflowTrustStatus,
} from '../../../shared/models/agent.model';
import { Subject } from 'rxjs';
import { NodeStore } from '../../store/node.store';
import { NoticeManager } from '../notification/notification.service';
import { handleApiError } from '../tauri/api-error';
import { WorkApiService } from '../tauri/work-api.service';

const TRUST_REFRESH_DELAY = 500;

export function deriveTrustState(status: WorkflowTrustStatus | null): TrustState {
  if (!status) return 'unknown';
  if (!status.hasWorkflows) return 'none';
  if (status.trusted) return 'trusted';
  if (!status.approvedHash) return 'unreviewed';
  return 'changed';
}

export function summarizeChanges(status: WorkflowTrustStatus | null): TrustSummary {
  const changes = status?.changes ?? [];
  return {
    added: changes.filter((change) => change.change === 'added').length,
    modified: changes.filter((change) => change.change === 'modified').length,
    removed: changes.filter((change) => change.change === 'removed').length,
    detailsAvailable: changes.length > 0,
  };
}

export type ApproveTrustResult =
  | { kind: 'approved' }
  | { kind: 'changed-while-reviewing' };

export function containsWorkflowPath(rootPath: string | null, paths: readonly string[]): boolean {
  if (!rootPath) return false;
  const normalize = (path: string) =>
    path
      .replace(/[\\/]+/g, '/')
      .toLowerCase()
      .replace(/\/+$/, '');
  const workflowDirectory = `${normalize(rootPath)}/.cairn/workflows`;
  return paths.some((path) => {
    const changedPath = normalize(path);
    return changedPath === workflowDirectory || changedPath.startsWith(`${workflowDirectory}/`);
  });
}

@Injectable({ providedIn: 'root' })
export class WorkflowService {
  private readonly api = inject(WorkApiService);
  private readonly nodes = inject(NodeStore);
  private readonly notices = inject(NoticeManager);
  private readonly _workflows = signal<WorkflowInfo[]>([]);
  private readonly _trust = signal<WorkflowTrustStatus | null>(null);
  private refreshPromise?: Promise<void>;
  private trustRefreshPromise?: Promise<WorkflowTrustStatus | undefined>;
  private generation = 0;
  private trustRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly announcedHashes = new Set<string>();
  private readonly _trustReview = new Subject<{ state: TrustState; summary: TrustSummary }>();

  readonly workflows = this._workflows.asReadonly();
  readonly trust = this._trust.asReadonly();
  readonly trustState = computed(() => deriveTrustState(this._trust()));
  readonly trustSummary = computed(() => summarizeChanges(this._trust()));
  readonly needsTrustReview = computed(() => {
    const state = this.trustState();
    return state === 'unreviewed' || state === 'changed';
  });
  readonly review = computed<WorkflowTrustReview>(() => {
    const status = this._trust();
    const files = status?.files ?? [];
    const changes = [...(status?.changes ?? [])];
    return { state: this.trustState(), files, changes };
  });
  readonly trustReview$ = this._trustReview.asObservable();

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    let request: Promise<void>;
    request = this.api
      .workflowList()
      .then((workflows) => {
        if (generation === this.generation) this._workflows.set(workflows);
      })
      .catch((error) => handleApiError(error, this.notices))
      .finally(() => {
        if (this.refreshPromise === request) this.refreshPromise = undefined;
      });
    this.refreshPromise = request;
    return request;
  }

  refreshTrust(): Promise<WorkflowTrustStatus | undefined> {
    if (this.trustRefreshPromise) return this.trustRefreshPromise;
    const generation = this.generation;
    let request: Promise<WorkflowTrustStatus | undefined>;
    request = this.api
      .workspaceTrustStatus()
      .then((status) => {
        if (generation !== this.generation) return undefined;
        this._trust.set(status);
        this.announceReview(status);
        return status;
      })
      .catch(async (error) => {
        await handleApiError(error, this.notices);
        return undefined;
      })
      .finally(() => {
        if (this.trustRefreshPromise === request) this.trustRefreshPromise = undefined;
      });
    this.trustRefreshPromise = request;
    return request;
  }

  async projectOpened(): Promise<void> {
    await this.refreshTrust();
  }

  private announceReview(status: WorkflowTrustStatus): void {
    const state = deriveTrustState(status);
    if (state !== 'unreviewed' && state !== 'changed') return;
    if (this.announcedHashes.has(status.folderHash)) return;
    this.announcedHashes.add(status.folderHash);
    this._trustReview.next({ state, summary: summarizeChanges(status) });
  }

  filesChanged(paths: readonly string[]): void {
    if (!containsWorkflowPath(this.nodes.rootPath(), paths)) return;
    if (this.trustRefreshTimer) clearTimeout(this.trustRefreshTimer);
    this.trustRefreshTimer = setTimeout(() => {
      this.trustRefreshTimer = null;
      void this.refreshTrust();
    }, TRUST_REFRESH_DELAY);
  }

  async approve(hash: string): Promise<ApproveTrustResult | undefined> {
    try {
      await this.api.workspaceTrust(hash);
      await this.refreshTrust();
      return { kind: 'approved' };
    } catch (error) {
      if ((error as { code?: string })?.code === 'Validation') {
        await this.refreshTrust();
        return { kind: 'changed-while-reviewing' };
      }
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async revoke(): Promise<void> {
    try {
      await this.api.workspaceTrustRevoke();
      await this.refreshTrust();
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  clear(): void {
    this.generation++;
    this._workflows.set([]);
    this._trust.set(null);
    this.announcedHashes.clear();
    this.refreshPromise = undefined;
    this.trustRefreshPromise = undefined;
    if (this.trustRefreshTimer) clearTimeout(this.trustRefreshTimer);
    this.trustRefreshTimer = null;
  }
}
