import type { FileNode } from '../../../core/store/node.state';
import type { NoteItem } from '../../../feature/notes/note.service';
import type { TaskItem } from '../../../feature/tasks/task.service';

export type PickSource = 'file' | 'text' | 'note' | 'task';

export interface PickerConfig {
  sources?: PickSource[];
  rootPath?: string | null;
  exclude?: {
    paths?: string[];
    noteIds?: string[];
    taskIds?: string[];
  };
  items?: {
    files: Pick<FileNode, 'id' | 'path' | 'name'>[];
    notes: NoteItem[];
    tasks: TaskItem[];
  };
}

export type PickResult =
  | { kind: 'file'; id: string; path: string; lineNumber?: number }
  | { kind: 'note'; id: string }
  | { kind: 'task'; id: string };

export const SOURCE_LABEL: Record<PickSource, string> = {
  file: 'Files',
  text: 'Text',
  note: 'Notes',
  task: 'Tasks',
};

export const SOURCE_PLACEHOLDER: Record<PickSource, string> = {
  file: 'Search files by name…',
  text: 'Search file contents…',
  note: 'Search notes…',
  task: 'Search tasks…',
};
