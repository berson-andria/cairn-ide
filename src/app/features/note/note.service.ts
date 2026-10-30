import { Injectable, Signal, signal } from '@angular/core';
import { Note } from './note.model';

@Injectable({
  providedIn: 'root',
})
export class NoteService {
  #noteSignal = signal<Record<string, Note>>({});
  readonly noteSignal: Signal<Readonly<Record<string, Note>>> = this.#noteSignal.asReadonly();

  addNote(note: Note) {
    this.#noteSignal.update((notes) => ({ ...notes, [note.id]: { ...note, files: [...note.files] } }));
  }

  deleteNote(noteId: string) {
    this.#noteSignal.update((notes) => {
      const next = { ...notes };
      delete next[noteId];
      return next;
    });
  }

  editNote(
    id: string,
    updates: Partial<Pick<Note, 'title' | 'content' | 'files' | 'scope'>>,
  ) {
    this.#noteSignal.update((notes) => {
      const current = notes[id];
      if (!current) return notes;
      const files = updates.files ?? current.files;
      return { ...notes, [id]: { ...current, ...updates, files: [...files] } };
    });
  }

  generateUUID() {
    return crypto.randomUUID();
  }
}
