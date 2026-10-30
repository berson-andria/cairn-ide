export type NoteScope = 'project' | 'global';

export interface NoteFile {
  fileName: string;
  path: string;
}

export interface Note {
  id: string;
  title?: string;
  content: string;
  files: NoteFile[];
  scope: NoteScope;
  createdAt: Date;
}
