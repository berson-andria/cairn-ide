import { Injectable, signal } from '@angular/core';
import type { NoteItem } from '../../feature/notes/note.service';
import type { StorageError } from '../services/tauri/work-api.service';

@Injectable({ providedIn: 'root' })
export class NoteStore {
  private readonly _records = signal<Record<string, NoteItem>>({});
  private readonly _errors = signal<StorageError[]>([]);
  private readonly _loaded = signal(false);
  readonly records = this._records.asReadonly(); readonly errors = this._errors.asReadonly(); readonly loaded = this._loaded.asReadonly();
  upsert(item: NoteItem): void { this._records.update(r => !r[item.id] || item.rev > r[item.id].rev ? { ...r, [item.id]: item } : r); }
  reload(item: NoteItem): void { this._records.update(r => ({ ...r, [item.id]: item })); }
  remove(id: string): void { this._records.update(r => { const next = { ...r }; delete next[id]; return next; }); }
  replace(items: NoteItem[], errors: StorageError[]): void { this._records.set(Object.fromEntries(items.map(item => [item.id, item]))); this._errors.set(errors); this._loaded.set(true); }
  clear(): void { this._records.set({}); this._errors.set([]); this._loaded.set(false); }
}
