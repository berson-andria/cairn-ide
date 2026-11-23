import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  TrustState,
  TrustSummary,
  WorkflowScope,
  WorkflowStatus,
  WorkflowTemplate,
  WorkflowTrustReview,
  WorkflowTrustStatus,
} from '../../../shared/models/agent.model';
import { Subject } from 'rxjs';
import { NodeStore } from '../../store/node.store';
import { NoticeManager } from '../notification/notification.service';
import { handleApiError } from '../tauri/api-error';
import { WorkApiService } from '../tauri/work-api.service';
import { SettingsService } from '../../../feature/setting/settings.service';

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
  private readonly settings = inject(SettingsService, { optional: true });
  private readonly _status = signal<WorkflowStatus | null>(null);
  private readonly _templates = signal<WorkflowTemplate[]>([]);
  private readonly _trust = signal<WorkflowTrustStatus | null>(null);
  private refreshPromise?: Promise<void>;
  private trustRefreshPromise?: Promise<WorkflowTrustStatus | undefined>;
  private generation = 0;
  private trustRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly announcedHashes = new Set<string>();
  private readonly _trustReview = new Subject<{ state: TrustState; summary: TrustSummary }>();

  readonly status = this._status.asReadonly();
  readonly templates = this._templates.asReadonly();
  readonly active = computed(() => {
    const status = this._status();
    if (!status?.active) return null;
    return status.sources.find((source) => source.source === status.active) ?? null;
  });
  readonly activeIssue = computed(() => {
    const active = this.active();
    return active && active.status !== 'ok' ? active.message ?? null : null;
  });
  readonly warnings = computed(() => this.active()?.warnings ?? []);
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
    request = Promise.all([
      this.api.workflowStatus(),
      this.api.workflowTemplates(),
    ])
      .then(([status, templates]) => {
        if (generation !== this.generation) return;
        this._status.set(status);
        this._templates.set(templates);
      })
      .catch((error) => void handleApiError(error, this.notices))
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
      void Promise.all([this.refreshStatus(), this.refreshTrust()]);
    }, TRUST_REFRESH_DELAY);
  }

  private refreshStatus(): Promise<void> {
    const generation = this.generation;
    if (typeof this.api.workflowStatus !== 'function') return Promise.resolve();
    return this.api.workflowStatus()
      .then((status) => {
        if (generation === this.generation) this._status.set(status);
      })
      .catch((error) => void handleApiError(error, this.notices));
  }

  async create(
    scope: Exclude<WorkflowScope, 'bundled'>,
    template: string,
  ): Promise<
    | { kind: 'created'; entryPath: string }
    | { kind: 'exists' }
    | undefined
  > {
    const trustedBefore = scope === 'project' && this.trustState() === 'trusted';
    try {
      const created = await this.api.workflowCreate(scope, template);
      await this.refresh();
      if (scope === 'project' && trustedBefore && this.trustIdeEditsEnabled()) {
        const status = await this.refreshTrust();
        if (status?.folderHash) await this.approve(status.folderHash);
      }
      return { kind: 'created', entryPath: created.entryPath };
    } catch (error) {
      if (
        (error as { code?: string })?.code === 'Validation'
        && /already exists/i.test((error as { message?: string })?.message ?? '')
      ) {
        return { kind: 'exists' };
      }
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  private trustIdeEditsEnabled(): boolean {
    if (!this.settings) return false;
    const exists = this.settings.definitions.some((definition) =>
      definition.key === 'agents.trustIdeEdits'
    );
    if (!exists) return false;
    try {
      return this.settings.get<boolean>('agents.trustIdeEdits')() === true;
    } catch {
      return false;
    }
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
    this._status.set(null);
    this._templates.set([]);
    this._trust.set(null);
    this.announcedHashes.clear();
    this.refreshPromise = undefined;
    this.trustRefreshPromise = undefined;
    if (this.trustRefreshTimer) clearTimeout(this.trustRefreshTimer);
    this.trustRefreshTimer = null;
  }
}
