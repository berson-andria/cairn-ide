import { Injectable } from '@angular/core';
import { Observable, Subject, buffer, debounceTime, filter, groupBy, map, mergeMap } from 'rxjs';
import type { Proposal } from '../../shared/models/agent.model';

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

  readonly notifications$: Observable<ProposalNotification> = this.created.pipe(
    groupBy(proposal => proposal.runId),
    mergeMap(group =>
      group.pipe(
        buffer(group.pipe(debounceTime(1000))),
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
