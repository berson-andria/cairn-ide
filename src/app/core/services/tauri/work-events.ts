import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TaskItem } from '../../../feature/tasks/task.service';
import type { NoteItem } from '../../../feature/notes/note.service';
import type {
  Proposal,
  ProposalDeletedEvent,
  RunFinishedEvent,
  RunLogEvent,
  RunStartedEvent,
  RunStepEvent,
} from '../../../shared/models/agent.model';

export interface WorkEventHandlers {
  taskCreated(record: TaskItem): void; taskUpdated(record: TaskItem): void; taskDeleted(id: string): void;
  taskReloaded(record: TaskItem): void;
  noteCreated(record: NoteItem): void; noteUpdated(record: NoteItem): void; noteDeleted(id: string): void; projectReloaded(): void;
  noteReloaded(record: NoteItem): void;
  runStarted(event: RunStartedEvent): void; runLog(event: RunLogEvent): void; runFinished(event: RunFinishedEvent): void;
  runStep(event: RunStepEvent): void;
  proposalCreated(record: Proposal): void; proposalUpdated(record: Proposal): void; proposalDeleted(id: string): void;
}
export async function subscribeWorkEvents(handlers: WorkEventHandlers): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<TaskItem>('task:created', e => handlers.taskCreated(e.payload)), listen<TaskItem>('task:updated', e => handlers.taskUpdated(e.payload)),
    listen<TaskItem>('task:reloaded', e => handlers.taskReloaded(e.payload)),
    listen<{id:string}>('task:deleted', e => handlers.taskDeleted(e.payload.id)), listen<NoteItem>('note:created', e => handlers.noteCreated(e.payload)),
    listen<NoteItem>('note:updated', e => handlers.noteUpdated(e.payload)), listen<{id:string}>('note:deleted', e => handlers.noteDeleted(e.payload.id)),
    listen<NoteItem>('note:reloaded', e => handlers.noteReloaded(e.payload)),
    listen('project:reloaded', () => handlers.projectReloaded()),
    listen<RunStartedEvent>('run:started', e => handlers.runStarted(e.payload)),
    listen<RunLogEvent>('run:log', e => handlers.runLog(e.payload)),
    listen<RunFinishedEvent>('run:finished', e => handlers.runFinished(e.payload)),
    listen<RunStepEvent>('run:step', e => handlers.runStep(e.payload)),
    listen<Proposal>('proposal:created', e => handlers.proposalCreated(e.payload)),
    listen<Proposal>('proposal:updated', e => handlers.proposalUpdated(e.payload)),
    listen<ProposalDeletedEvent>('proposal:deleted', e => handlers.proposalDeleted(e.payload.id)),
  ]);
  return () => unlisteners.forEach(fn => fn());
}
