import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { Note } from './note.model';
import { NoteService } from './note.service';
import { DialogService } from '../../core/services/dialog/dialog.service';
import { NoteDialog } from './note-dialog';

@Component({
  selector: 'app-note',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notes.html',
  styleUrl: './notes.scss',
})
export class Notes {
  private readonly noteService = inject(NoteService);
  private readonly dialogService = inject(DialogService);

  readonly notes = computed(() =>
    Object.values(this.noteService.noteSignal()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    ),
  );

  addNote(): void {
    const note: Note = {
      id: this.noteService.generateUUID(),
      title: '',
      content: '',
      files: [],
      scope: 'project',
      createdAt: new Date(),
    };
    this.openNote(note, true);
  }

  openNote(note: Note, isNew = false): void {
    this.dialogService.open(NoteDialog, {
      title: isNew ? 'New note' : note.title?.trim() || 'Edit note',
      data: { note, isNew },
    });
  }

  deleteNote(note: Note, event: MouseEvent): void {
    event.stopPropagation();
    this.noteService.deleteNote(note.id);
  }
}
