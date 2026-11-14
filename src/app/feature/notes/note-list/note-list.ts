import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { lucideChevronDown } from '@ng-icons/lucide';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { LayoutService } from '../../../core/services/layout.service';
import { MenuDirective } from '../../../shared/directives/menu.directive';
import { TabStore } from '../../../core/store/tab.store';
import { EditorCommands } from '../../editor/editor.commands';
import { Note } from '../note/note';
import { NoteAnchor, NoteService } from '../note.service';

export type NoteFilter = 'all' | 'open' | 'inbox' | 'completed';

@Component({
  selector: 'note-list',
  templateUrl: './note-list.html',
  styleUrl: './note-list.scss',
  imports: [NgIcon, Note, MenuDirective],
  providers: [
    provideIcons({
      bootstrapChevronDown,
      bootstrapChevronRight,
      lucideChevronDown,
    }),
  ],
  host: {
    '[style.flex]': 'layoutService.isRailSectionActive("Notes") ? 1 : "none"',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoteList {
  readonly noteService = inject(NoteService);
  readonly layoutService = inject(LayoutService);
  private readonly tabStore = inject(TabStore, { optional: true });
  private readonly editorCommands = inject(EditorCommands, { optional: true });

  readonly activeFilter = signal<NoteFilter>('all');
  readonly selectedNoteId = signal<string>('1');

  readonly filterLabels: Record<NoteFilter, string> = {
    all: 'All notes',
    open: 'Open',
    inbox: 'Inbox / No anchors',
    completed: 'Completed',
  };

  readonly currentFilterLabel = computed(() => this.filterLabels[this.activeFilter()]);

  readonly filteredNotes = computed(() => {
    const filter = this.activeFilter();
    const list = this.noteService.notes();
    switch (filter) {
      case 'all':
        return list;
      case 'open':
        return list.filter((n) => n.status === 'open');
      case 'inbox':
        return list.filter((n) => !n.anchors || n.anchors.length === 0);
      case 'completed':
        return list.filter((n) => n.status === 'completed');
    }
  });

  readonly allCount = computed(() => this.noteService.notes().length);
  readonly openCount = computed(() => this.noteService.openNotes().length);
  readonly inboxCount = computed(() => this.noteService.inboxNotes().length);
  readonly completedCount = computed(() => this.noteService.completedNotes().length);

  selectNote(id: string): void {
    this.selectedNoteId.set(id);
    const note = this.noteService.get(id);
    if (note && this.tabStore) {
      const label = note.type
        ? `${note.type}: ${note.content.substring(0, 20)}...`
        : note.content.substring(0, 25);
      this.tabStore.openNote(id, label);
      console.log(this.tabStore.openedTabs());
    }
  }

  setFilter(filter: NoteFilter): void {
    this.activeFilter.set(filter);
  }

  addNote(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const newNote = this.noteService.add({
      content: trimmed,
      status: 'open',
      anchors: [],
    });
    this.selectedNoteId.set(newNote.id);
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
}
