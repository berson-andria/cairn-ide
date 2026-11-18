import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { TaskItem } from '../../../feature/tasks/task.service';
import type { NoteItem } from '../../../feature/notes/note.service';

export interface WorkEventHandlers {
  taskCreated(record: TaskItem): void; taskUpdated(record: TaskItem): void; taskDeleted(id: string): void;
  noteCreated(record: NoteItem): void; noteUpdated(record: NoteItem): void; noteDeleted(id: string): void; projectReloaded(): void;
}
export async function subscribeWorkEvents(handlers: WorkEventHandlers): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<TaskItem>('task:created', e => handlers.taskCreated(e.payload)), listen<TaskItem>('task:updated', e => handlers.taskUpdated(e.payload)),
    listen<{id:string}>('task:deleted', e => handlers.taskDeleted(e.payload.id)), listen<NoteItem>('note:created', e => handlers.noteCreated(e.payload)),
    listen<NoteItem>('note:updated', e => handlers.noteUpdated(e.payload)), listen<{id:string}>('note:deleted', e => handlers.noteDeleted(e.payload.id)),
    listen('project:reloaded', () => handlers.projectReloaded()),
  ]);
  return () => unlisteners.forEach(fn => fn());
}
