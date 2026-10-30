import { CommonModule } from '@angular/common';
import { Component, inject, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogRef } from '@angular/cdk/dialog';
import { DialogService } from '../../core/services/dialog/dialog.service';
import { Note } from '../note/note.model';
import { TodoService } from './todo.service';
import { TodoStatus, TodoSubtask, TodoTask } from './todo.model';
import { AttachFile, SelectedFile } from '../../shared/components/attach-file/attach-file';

@Component({
  selector: 'app-todo-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './todo-dialog.html',
  styleUrl: './todo-dialog.scss',
})
export class TodoDialog {
  private readonly todoService = inject(TodoService);
  private readonly dialogService = inject(DialogService);
  private readonly dialogRef = inject(DialogRef, { optional: true });
  private _taskId = '';

  @Input() notes: Note[] = [];
  @Input() attachNoteAction: ((taskId: string) => void) | null = null;

  @Input() set taskId(value: string) {
    this._taskId = value;
    this.loadDraft();
  }

  title = '';
  status: TodoStatus = 'open';
  subtasks: TodoSubtask[] = [];
  newSubtaskTitle = '';
  readonly statuses: TodoStatus[] = ['open', 'in-progress', 'done', 'cancelled'];

  get currentTask(): TodoTask | undefined {
    return this.todoService.todos().find((task) => task.id === this._taskId);
  }

  addSubtask(): void {
    const title = this.newSubtaskTitle.trim();
    if (!title) return;
    this.subtasks = [...this.subtasks, { id: this.createId(), title, status: 'open' }];
    this.newSubtaskTitle = '';
  }

  removeSubtask(subtaskId: string): void {
    this.subtasks = this.subtasks.filter((subtask) => subtask.id !== subtaskId);
  }

  requestFileLink(): void {
    const picker = this.dialogService.open<SelectedFile[]>(AttachFile, { title: 'Select files' });
    picker.closed.subscribe((files) => {
      if (!files?.length) return;
      for (const file of files) this.todoService.linkFile(this._taskId, file);
    });
  }

  requestNoteAttachment(): void {
    this.attachNoteAction?.(this._taskId);
  }

  save(): void {
    if (!this.currentTask || !this.title.trim()) return;
    this.todoService.updateTitle(this._taskId, this.title);
    this.todoService.setStatus(this._taskId, this.status);
    this.todoService.replaceSubtasks(
      this._taskId,
      this.subtasks
        .map((subtask) => ({ ...subtask, title: subtask.title.trim() }))
        .filter((subtask) => subtask.title),
    );
    this.dialogRef?.close();
  }

  cancel(): void {
    this.dialogRef?.close();
  }

  statusLabel(status: TodoStatus): string {
    return status === 'in-progress' ? 'In progress' : status[0].toUpperCase() + status.slice(1);
  }

  noteTitle(noteId: string): string {
    const note = this.notes.find((item) => item.id === noteId);
    return note?.title?.trim() || noteId;
  }

  private loadDraft(): void {
    const task = this.currentTask;
    if (!task) return;
    this.title = task.title;
    this.status = task.status;
    this.subtasks = task.subtasks.map((subtask) => ({ ...subtask }));
  }

  private createId(): string {
    return globalThis.crypto?.randomUUID?.()
      ?? `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
