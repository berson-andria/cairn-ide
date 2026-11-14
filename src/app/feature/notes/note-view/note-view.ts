import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TabStore } from '../../../core/store/tab.store';
import { EditorCommands } from '../../editor/editor.commands';
import { AstAnchor, NoteAnchor, NoteItem, NoteService, TaskAnchor } from '../note.service';

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

  readonly isCompleted = computed(() => this.activeNote()?.status === 'completed');

  onContentChange(newContent: string): void {
    const note = this.activeNote();
    if (!note) return;
    this.noteService.edit(note.id, { content: newContent });
  }

  setKind(kind: 'note' | 'feedback' | 'question'): void {
    const note = this.activeNote();
    if (!note) return;
    const type = kind === 'note' ? undefined : kind.toUpperCase();
    this.noteService.edit(note.id, { type });
  }

  onAnchorClick(anchor: NoteAnchor): void {
    if (anchor.kind === 'task') {
      this.tabStore?.openTask(anchor.id, anchor.title);
    } else if (anchor.kind === 'ast') {
      if (this.editorCommands) {
        void this.editorCommands.openPath(anchor.path);
      }
    }
  }

  openAnchoredCode(): void {
    const astAnchor = this.anchors().find((a): a is AstAnchor => a.kind === 'ast');
    if (astAnchor && this.editorCommands) {
      void this.editorCommands.openPath(astAnchor.path);
    }
  }

  promoteToTask(): void {
    const note = this.activeNote();
    if (!note) return;
    const taskId = `t-${note.id}`;
    this.tabStore?.openTask(taskId, note.content.substring(0, 40));
  }

  attachToTask(): void {
    const note = this.activeNote();
    if (!note) return;
    const taskId = `t-new`;
    const taskAnchor: TaskAnchor = {
      kind: 'task',
      id: taskId,
      label: taskId,
      title: note.content.substring(0, 30),
    };
    this.noteService.addAnchor(note.id, taskAnchor);
  }

  toggleResolve(): void {
    const note = this.activeNote();
    if (!note) return;
    this.noteService.toggleStatus(note.id);
  }

  deleteNote(): void {
    const note = this.activeNote();
    if (!note) return;
    const id = note.id;
    this.noteService.delete(id);
    if (this.tabStore) {
      this.tabStore.closeTab(id);
    }
  }
}

