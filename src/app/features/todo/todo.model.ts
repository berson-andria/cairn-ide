export type TodoStatus = 'open' | 'in-progress' | 'done' | 'cancelled';

export interface TodoFile {
  /** Workspace-relative path used to reopen the file in the editor. */
  path: string;
  /** Optional display name; can be derived from path. */
  fileName?: string;
}

export interface TodoSubtask {
  id: string;
  title: string;
  status: TodoStatus;
}

export interface TodoTask {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: Date;
  linkedFiles: TodoFile[];
  noteId?: string;
  subtasks: TodoSubtask[];
}
