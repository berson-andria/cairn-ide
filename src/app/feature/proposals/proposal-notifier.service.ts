import { Injectable } from '@angular/core';
import { Observable, Subject, bufferWhen, debounceTime, filter, groupBy, map, mergeMap, race, timer } from 'rxjs';
import type { Proposal } from '../../shared/models/agent.model';

export const PROPOSAL_NOTIFIER_QUIET_WINDOW_MS = 1000;
export const PROPOSAL_NOTIFIER_MAX_WAIT_MS = 5000;

export interface ProposalNotification {
  runId: string;
  workflow: string;
  taskId?: string;
  proposalIds: string[];
  kinds: Proposal['kind'][];
}

@Injectable({ providedIn: 'root' })
export class ProposalNotifier {
  private readonly created = new Subject<Proposal>();

  protected get quietWindowMs(): number {
    return PROPOSAL_NOTIFIER_QUIET_WINDOW_MS;
  }

  protected get maxWaitMs(): number {
    return PROPOSAL_NOTIFIER_MAX_WAIT_MS;
  }

  readonly notifications$: Observable<ProposalNotification> = this.created.pipe(
    groupBy(proposal => proposal.runId),
    mergeMap(group =>
      group.pipe(
        bufferWhen(() =>
          race(group.pipe(debounceTime(this.quietWindowMs)), timer(this.maxWaitMs)),
        ),
        filter(proposals => proposals.length > 0),
        map(proposals => {
          const first = proposals[0];
          return {
            runId: first.runId,
            workflow: first.workflow,
            taskId: first.taskId,
            proposalIds: [...new Set(proposals.map(proposal => proposal.id))],
            kinds: [...new Set(proposals.map(proposal => proposal.kind))],
          };
        }),
      ),
    ),
  );

  proposalCreated(proposal: Proposal): void {
    if (proposal.presentation === 'notify' && !proposal.seenAt) this.created.next(proposal);
  }
}
