import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { NodeStore } from '../../../core/store/node.store';
import type { FileNode } from '../../../core/store/node.state';
import { NoteService } from '../../../feature/notes/note.service';
import { TaskService } from '../../../feature/tasks/task.service';
import { Picker } from './picker';
import type { PickerConfig, PickResult } from './picker.model';

@Injectable({ providedIn: 'root' })
export class PickerService {
  private readonly dialogs = inject(DialogService);
  private readonly nodeStore = inject(NodeStore);
  private readonly noteService = inject(NoteService);
  private readonly taskService = inject(TaskService);

  /** Opens the picker and resolves with the selection, or undefined if it was dismissed. */
  pick(config: PickerConfig, title?: string): Promise<PickResult | undefined> {
    const items = {
      files: Object.values(this.nodeStore.nodes())
        .filter((node): node is FileNode => 'extension' in node)
        .map(({ id, path, name }) => ({ id, path, name })),
      notes: this.noteService.notes(),
      tasks: this.taskService.tasks(),
    };
    const dialogConfig: PickerConfig = {
      ...config,
      rootPath: this.nodeStore.rootPath(),
      items,
    };
    const ref = this.dialogs.open<PickResult | undefined>(Picker, {
      title,
      data: { config: dialogConfig }, // DialogWrapper assigns this onto the Picker instance
    });
    return firstValueFrom(ref.closed, { defaultValue: undefined });
  }

  // ───────────── Openers: each one fixes what can be picked ─────────────

  /** Opened from a note: a file or a task. */
  forNote(noteId?: string) {
    return this.pick({ sources: ['file', 'task'], exclude: { noteIds: [noteId ?? ''] } });
  }

  /** Opened from a task: a file or a note. */
  forTask(taskId?: string) {
    return this.pick({ sources: ['file', 'note'], exclude: { taskIds: [taskId ?? ''] } });
  }

  /** Opened from a file: a task or a note. The file itself is never offered. */
  forFile(path?: string) {
    return this.pick({ sources: ['task', 'note'], exclude: { paths: path ? [path] : [] } });
  }
}
