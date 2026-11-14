import { Injectable, computed, signal } from '@angular/core';

export interface TaskAnchor {
  kind: 'task';
  id: string; // task id
  label: string; // task label, e.g. 't-7f3b'
  title: string; // task title
}

export interface AstAnchor {
  kind: 'ast';
  id?: string;
  label: string; // AST symbol name, e.g. 'AuthClient.refresh'
  path: string; // file path for redirection
  lost?: boolean; // true if the AST anchor was lost
}

export type NoteAnchor = TaskAnchor | AstAnchor;

export type NoteStatus = 'open' | 'completed';

export interface NoteItem {
  id: string;
  content: string;
  type?: string; // e.g. 'FEEDBACK', 'QUESTION'
  status: NoteStatus;
  anchors: NoteAnchor[];
  createdAt: number;
  updatedAt?: number;
}

@Injectable({
  providedIn: 'root',
})
export class NoteService {
  private readonly _notes = signal<NoteItem[]>([
    {
      id: '1',
      content: "Depends on the session store, which doesn't exist yet.",
      status: 'open',
      anchors: [
        {
          kind: 'ast',
          label: 'AuthClient.refresh',
          path: 'src/auth/client.ts',
        },
      ],
      createdAt: Date.now() - 3600000,
    },
    {
      id: '2',
      type: 'FEEDBACK',
      content: 'Retry should not loop on 401.',
      status: 'open',
      anchors: [
        {
          kind: 'task',
          id: 't-7f3b',
          label: 't-7f3b',
          title: 'Retry logic loop on 401 response',
        },
      ],
      createdAt: Date.now() - 3000000,
    },
    {
      id: '3',
      type: 'QUESTION',
      content: 'Should expiry use server time?',
      status: 'open',
      anchors: [
        {
          kind: 'ast',
          label: 'Token',
          path: 'src/auth/token.ts',
        },
      ],
      createdAt: Date.now() - 2000000,
    },
    {
      id: '4',
      content: 'Cache the parsed token.',
      status: 'open',
      anchors: [
        {
          kind: 'ast',
          label: 'anchor lost',
          path: 'src/auth/token.ts',
          lost: true,
        },
      ],
      createdAt: Date.now() - 1000000,
    },
    {
      id: '5',
      content: 'Look at retry backoff later.',
      status: 'open',
      anchors: [],
      createdAt: Date.now() - 500000,
    },
    {
      id: '6',
      content: 'Verify token refresh with mock server.',
      status: 'completed',
      anchors: [
        {
          kind: 'task',
          id: 't-4a11',
          label: 't-4a11',
          title: 'Session storage setup',
        },
      ],
      createdAt: Date.now() - 86400000,
    },
  ]);

  /** Read-only signal access to all notes */
  readonly notes = this._notes.asReadonly();

  readonly openNotes = computed(() => this._notes().filter((n) => n.status === 'open'));
  readonly completedNotes = computed(() => this._notes().filter((n) => n.status === 'completed'));
  readonly inboxNotes = computed(() =>
    this._notes().filter((n) => !n.anchors || n.anchors.length === 0)
  );

  get(id: string): NoteItem | undefined {
    return this._notes().find((n) => n.id === id);
  }

  add(data: {
    content: string;
    type?: string;
    anchors?: NoteAnchor[];
    status?: NoteStatus;
  }): NoteItem {
    const newNote: NoteItem = {
      id: String(Date.now()),
      content: data.content,
      type: data.type,
      status: data.status ?? 'open',
      anchors: data.anchors ?? [],
      createdAt: Date.now(),
    };
    this._notes.update((list) => [newNote, ...list]);
    return newNote;
  }

  edit(id: string, updates: Partial<Omit<NoteItem, 'id' | 'createdAt'>>): void {
    this._notes.update((list) =>
      list.map((note) =>
        note.id === id
          ? { ...note, ...updates, updatedAt: Date.now() }
          : note
      )
    );
  }

  delete(id: string): void {
    this._notes.update((list) => list.filter((n) => n.id !== id));
  }

  setAnchors(id: string, anchors: NoteAnchor[]): void {
    this.edit(id, { anchors });
  }

  setAnchor(id: string, anchor: NoteAnchor | NoteAnchor[] | null): void {
    if (!anchor) {
      this.setAnchors(id, []);
    } else if (Array.isArray(anchor)) {
      this.setAnchors(id, anchor);
    } else {
      this.setAnchors(id, [anchor]);
    }
  }

  addAnchor(id: string, anchor: NoteAnchor): void {
    const note = this.get(id);
    if (!note) return;
    this.setAnchors(id, [...note.anchors, anchor]);
  }

  removeAnchor(id: string, index: number): void {
    const note = this.get(id);
    if (!note) return;
    this.setAnchors(
      id,
      note.anchors.filter((_, i) => i !== index)
    );
  }

  setStatus(id: string, status: NoteStatus): void {
    this.edit(id, { status });
  }

  toggleStatus(id: string): void {
    const current = this.get(id);
    if (!current) return;
    this.setStatus(id, current.status === 'open' ? 'completed' : 'open');
  }
}
