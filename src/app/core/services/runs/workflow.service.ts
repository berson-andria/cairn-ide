import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { Observable } from 'rxjs';
import type { WorkflowInfo, WorkflowTrustStatus } from '../../../shared/models/agent.model';
import { NodeStore } from '../../store/node.store';
import { NoticeManager } from '../notification/notification.service';
import { handleApiError } from '../tauri/api-error';
import { WorkApiService } from '../tauri/work-api.service';

const TRUST_REFRESH_DELAY = 500;

export function containsWorkflowPath(rootPath: string | null, paths: readonly string[]): boolean {
  if (!rootPath) return false;
  const normalize = (path: string) => path.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '');
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
  private readonly trustReviewSubject = new Subject<WorkflowTrustStatus>();
  private refreshPromise?: Promise<void>;
  private trustRefreshPromise?: Promise<WorkflowTrustStatus | undefined>;
  private generation = 0;
  private reviewEmitted = false;
  private trustRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  readonly workflows = this._workflows.asReadonly();
  readonly trust = this._trust.asReadonly();
  readonly needsTrustReview = computed(() => {
    const status = this._trust();
    return !!status?.hasWorkflows && !status.trusted;
  });
  readonly trustReview$: Observable<WorkflowTrustStatus> = this.trustReviewSubject.asObservable();

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
    this.reviewEmitted = false;
    const status = await this.refreshTrust();
    if (status && this.needsTrustReview() && !this.reviewEmitted) {
      this.reviewEmitted = true;
      this.trustReviewSubject.next(status);
    }
  }

  filesChanged(paths: readonly string[]): void {
    if (!containsWorkflowPath(this.nodes.rootPath(), paths)) return;
    if (this.trustRefreshTimer) clearTimeout(this.trustRefreshTimer);
    this.trustRefreshTimer = setTimeout(() => {
      this.trustRefreshTimer = null;
      void this.refreshTrust();
    }, TRUST_REFRESH_DELAY);
  }

  async approve(): Promise<void> {
    const status = this._trust();
    if (!status) return;
    try {
      await this.api.workspaceTrust(status.folderHash);
      await this.refreshTrust();
    } catch (error) {
      await handleApiError(error, this.notices);
      await this.refreshTrust();
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
    this.reviewEmitted = false;
    this.refreshPromise = undefined;
    this.trustRefreshPromise = undefined;
    if (this.trustRefreshTimer) clearTimeout(this.trustRefreshTimer);
    this.trustRefreshTimer = null;
  }
}
