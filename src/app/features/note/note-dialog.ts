import { CommonModule } from '@angular/common';
import { Component, Input, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogRef } from '@angular/cdk/dialog';
import { DialogService } from '../../core/services/dialog/dialog.service';
import { AttachFile, SelectedFile } from '../../shared/components/attach-file/attach-file';
import { MarkdownEditor } from '../../shared/components/markdown-editor/markdown-editor';
import { Note, NoteFile } from './note.model';
import { NoteService } from './note.service';

@Component({
  selector: 'app-note-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownEditor],
  templateUrl: './note-dialog.html',
  styleUrl: './note-dialog.scss',
})
export class NoteDialog {
  private readonly noteService = inject(NoteService);
  private readonly dialogService = inject(DialogService);
  private readonly dialogRef = inject(DialogRef<void>, { optional: true });

  @Input() isNew = false;
  draft: Note = this.emptyNote();

  @Input() set note(note: Note) {
    this.draft = { ...note, files: note.files.map((file) => ({ ...file })) };
  }

  save(): void {
    const updates = {
      title: this.draft.title?.trim() || undefined,
      content: this.draft.content,
      files: this.draft.files.map((file) => ({ ...file })),
      scope: this.draft.scope,
    };

    if (this.isNew) {
      this.noteService.addNote({ ...this.draft, ...updates });
    } else {
      this.noteService.editNote(this.draft.id, updates);
    }
    this.dialogRef?.close();
  }

  cancel(): void {
    this.dialogRef?.close();
  }

  attachFiles(): void {
    const picker = this.dialogService.open<SelectedFile[]>(AttachFile, { title: 'Select files' });
    picker.closed.subscribe((selected) => {
      if (!selected?.length) return;
      const existing = new Set(this.draft.files.map((file) => file.path.toLowerCase()));
      const additions: NoteFile[] = selected
        .filter((file) => !existing.has(file.path.toLowerCase()))
        .map(({ fileName, path }) => ({ fileName, path }));
      this.draft.files = [...this.draft.files, ...additions];
    });
  }

  removeFile(path: string): void {
    this.draft.files = this.draft.files.filter((file) => file.path !== path);
  }

  private emptyNote(): Note {
    return {
      id: '',
      title: '',
      content: '',
      files: [],
      scope: 'project',
      createdAt: new Date(),
    };
  }
}
