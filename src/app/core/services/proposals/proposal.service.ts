import { Injectable, computed, inject } from '@angular/core';
import {
  TasksProposal,
  Proposal,
  ProposalPayload,
  SourceAction,
  AcceptResult,
} from '../../../shared/models/agent.model';
import { ProposalStore } from '../../store/proposal.store';
import { NoticeManager } from '../notification/notification.service';
import { handleApiError } from '../tauri/api-error';
import { WorkApiService } from '../tauri/work-api.service';

export type BatchEditPayload = TasksProposal['payload'];
export type SubtaskEditPayload = Extract<Proposal, { kind: 'subtasks' }>['payload'];
export type BatchRemoval =
  | { payload: BatchEditPayload }
  | { error: 'has-dependents'; keys: string[] };

export function editablePayload<T extends Proposal>(proposal: T): T['payload'] {
  return structuredClone(proposal.payload);
}

export function removeBatchItem(payload: BatchEditPayload, key: string): BatchRemoval {
  const dependents = payload.items
    .filter((item) => item.dependsOnKey === key)
    .map((item) => item.key);
  if (dependents.length) return { error: 'has-dependents', keys: dependents };
  return {
    payload: {
      ...structuredClone(payload),
      items: payload.items.filter((item) => item.key !== key),
    },
  };
}

export function removeSubtaskItem(payload: SubtaskEditPayload, index: number): SubtaskEditPayload {
  return {
    ...structuredClone(payload),
    items: payload.items.filter((_, itemIndex) => itemIndex !== index),
  };
}

@Injectable({ providedIn: 'root' })
export class ProposalService {
  private readonly api = inject(WorkApiService);
  private readonly store = inject(ProposalStore);
  private readonly notices = inject(NoticeManager);

  readonly all = this.store.all;
  readonly pending = computed(() => this.all().filter((proposal) => proposal.status === 'pending'));
  readonly display = computed(() =>
    this.pending().filter((proposal) => proposal.presentation === 'display'),
  );
  readonly notifications = computed(() =>
    this.pending().filter((proposal) => proposal.presentation === 'notify'),
  );
  readonly unseenCount = computed(
    () => this.notifications().filter((proposal) => !proposal.seenAt).length,
  );
  readonly byRun = computed(() =>
    this.all().reduce<Record<string, Proposal[]>>((groups, proposal) => {
      (groups[proposal.runId] ??= []).push(proposal);
      return groups;
    }, {}),
  );

  refresh(): Promise<void> {
    return this.store.refresh().catch((error) => handleApiError(error, this.notices));
  }

  async accept(
    proposal: Proposal,
    options?: { payload?: ProposalPayload; sourceAction?: SourceAction },
  ): Promise<AcceptResult | undefined> {
    const current = this.store.records()[proposal.id];
    if (!current) {
      await this.refresh();
    }
    const latest = this.store.records()[proposal.id];
    if (!latest) {
      await handleApiError(
        { code: 'NotFound', message: `Proposal ${proposal.id} was not found.` },
        this.notices,
      );
      return undefined;
    }
    try {
      return await this.api.proposalAccept(
        proposal.id,
        latest.rev,
        options?.payload,
        options?.sourceAction,
      );
    } catch (error) {
      if ((error as { code?: string })?.code === 'StaleRev') {
        await this.refresh();
        await handleApiError(error, this.notices, undefined, 'This changed elsewhere; try again.');
      } else {
        await handleApiError(error, this.notices);
      }
      return undefined;
    }
  }

  async reject(proposal: Proposal): Promise<Proposal | undefined> {
    const latest = await this.getLatest(proposal);
    if (!latest) return undefined;
    try {
      return await this.api.proposalReject(proposal.id, latest.rev);
    } catch (error) {
      if ((error as { code?: string })?.code === 'StaleRev') await this.refresh();
      await handleApiError(error, this.notices);
      return undefined;
    }
  }

  async remove(proposal: Proposal): Promise<void> {
    try {
      await this.api.proposalDelete(proposal.id);
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  async markSeen(ids: string[]): Promise<void> {
    try {
      await this.api.proposalMarkSeen(ids);
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }

  clear(): void {
    this.store.clear();
  }

  private async getLatest(proposal: Proposal): Promise<Proposal | undefined> {
    if (!this.store.records()[proposal.id]) await this.refresh();
    const latest = this.store.records()[proposal.id];
    if (!latest) {
      await handleApiError(
        { code: 'NotFound', message: `Proposal ${proposal.id} was not found.` },
        this.notices,
      );
    }
    return latest;
  }
}
