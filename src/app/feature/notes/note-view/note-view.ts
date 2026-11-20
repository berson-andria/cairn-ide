import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TabStore } from '../../../core/store/tab.store';
import { EditorCommands } from '../../editor/editor.commands';
import { AstAnchor, NoteAnchor, NoteItem, NoteService } from '../note.service';
import { LayoutService } from '../../../core/services/layout.service';
import { TaskService } from '../../tasks/task.service';

@Component({
  selector: 'note-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './note-view.html',
  styleUrl: './note-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoteView {
  readonly noteService = inject(NoteService);
  private readonly tabStore = inject(TabStore, { optional: true });
  private readonly editorCommands = inject(EditorCommands, { optional: true });
  private readonly layout = inject(LayoutService);
  private readonly taskService = inject(TaskService);

  /** Optional note ID passed from parent */
  noteId = input<string>();

  /** Optional full note object passed from parent */
  note = input<NoteItem>();

  /** Resolves the current note from input, tabStore, or fallback to first available note */
  readonly activeNote = computed<NoteItem | undefined>(() => {
    const directNote = this.note();
    if (directNote) return directNote;

    const id = this.noteId();
    if (id) {
      const found = this.noteService.get(id);
      if (found) return found;
    }

    const tab = this.tabStore?.activeTab();
    if (tab && tab.type === 'Note') {
      const found = this.noteService.get(tab.id);
      if (found) return found;
    }

    return this.noteService.notes()[0];
  });

  readonly displayId = computed(() => {
    const id = this.activeNote()?.id;
    return id ? `n-${id}` : 'n-a1c9';
  });

  readonly displayContent = computed(() => this.activeNote()?.content ?? '');

  readonly currentKind = computed(() => {
    const type = this.activeNote()?.type?.toLowerCase();
    if (type === 'feedback') return 'feedback';
    if (type === 'question') return 'question';
    return 'note';
  });

  readonly anchors = computed<NoteAnchor[]>(() => this.activeNote()?.anchors ?? []);
  readonly linkedTasks = computed(() => {
    const noteId = this.activeNote()?.id;
    if (!noteId) return [];
    return this.taskService.tasks().filter((task) => task.linkedNoteIds?.includes(noteId));
  });

  readonly isCompleted = computed(() => this.activeNote()?.status === 'completed');

  async onContentChange(newContent: string): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    await this.noteService.edit(note.id, { content: newContent });
  }

  async setKind(kind: 'note' | 'feedback' | 'question'): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    const type = kind === 'note' ? undefined : kind.toUpperCase();
    await this.noteService.edit(note.id, { type });
  }

  onAnchorClick(anchor: NoteAnchor): void {
    if (this.editorCommands) {
      void this.editorCommands.openPath(anchor.path);
    }
  }

  openLinkedTask(taskId: string, title: string): void {
    this.tabStore?.openTask(taskId, title);
  }

  openAnchoredCode(): void {
    const astAnchor = this.anchors().find((a): a is AstAnchor => a.kind === 'ast');
    if (astAnchor && this.editorCommands) {
      void this.editorCommands.openPath(astAnchor.path);
    }
  }

  async promoteToTask(): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    const task = await this.taskService.add({
      title: note.content.substring(0, 40) || 'New task from note',
      description: note.content,
    });
    if (!task) return;
    await this.taskService.addLinkedNote(task.id, note.id);
    this.tabStore?.openTask(task.id, task.title, task.id);
  }

  async attachToTask(): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    const selected = await this.layout.openAnchor({ kind: 'note', id: note.id });
    if (!selected) return;

    if (selected.kind === 'file') {
      const anchor: AstAnchor = {
        kind: 'ast',
        path: selected.path,
        label: selected.path.split(/[\\/]/).pop() ?? selected.path,
      };
      await this.noteService.addAnchor(note.id, anchor);
    } else if (selected.kind === 'task') {
      const task = this.taskService.get(selected.id);
      if (!task) return;
      await this.taskService.addLinkedNote(task.id, note.id);
    }
  }

  async toggleResolve(): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    await this.noteService.toggleStatus(note.id);
  }

  async deleteNote(): Promise<void> {
    const note = this.activeNote();
    if (!note) return;
    const id = note.id;
    await this.noteService.delete(id);
    if (this.tabStore) {
      this.tabStore.closeTab(id);
    }
  }
}
