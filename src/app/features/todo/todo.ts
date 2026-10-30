import { CommonModule } from '@angular/common';
import { Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideStickyNote } from '@ng-icons/lucide';
import { DialogService } from '../../core/services/dialog/dialog.service';
import { Note } from '../note/note.model';
import { TodoStatus, TodoTask } from './todo.model';
import { TodoService } from './todo.service';
import { TodoDialog } from './todo-dialog';

@Component({
  selector: 'app-todo',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon],
  providers: [provideIcons({ lucideStickyNote })],
  templateUrl: './todo.html',
  styleUrl: './todo.scss',
})
export class Todo {
  private readonly todoService = inject(TodoService);
  private readonly dialogService = inject(DialogService);

  @Input() notes: Note[] = [];
  @Output() attachNoteRequested = new EventEmitter<string>();

  readonly todos = this.todoService.todos;
  newTitle = '';
  showCompleted = true;

  get visibleTasks(): readonly TodoTask[] {
    return this.showCompleted
      ? this.todos()
      : this.todos().filter((task) => task.status !== 'done');
  }

  get remainingCount(): number {
    return this.todos().filter((task) => task.status !== 'done' && task.status !== 'cancelled')
      .length;
  }

  addTask(): void {
    const title = this.newTitle.trim();
    if (!title) return;
    this.todoService.addTask(title);
    this.newTitle = '';
  }

  openTask(task: TodoTask): void {
    this.dialogService.open(TodoDialog, {
      title: 'Edit task',
      data: {
        taskId: task.id,
        notes: this.notes,
        attachNoteAction: (taskId: string) => this.attachNoteRequested.emit(taskId),
      },
    });
  }

  toggleDone(task: TodoTask): void {
    this.todoService.toggleDone(task.id);
  }

  statusLabel(status: TodoStatus): string {
    return status === 'in-progress' ? 'In progress' : status[0].toUpperCase() + status.slice(1);
  }

  statusClass(status: TodoStatus): string {
    return `status status--${status}`;
  }
}
