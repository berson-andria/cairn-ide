import { Injectable, signal } from '@angular/core';
import type { TaskItem } from '../../feature/tasks/task.service';
import type { StorageError } from '../services/tauri/work-api.service';

@Injectable({ providedIn: 'root' })
export class TaskStore {
  private readonly _records = signal<Record<string, TaskItem>>({});
  private readonly _errors = signal<StorageError[]>([]);
  private readonly _loaded = signal(false);
  readonly records = this._records.asReadonly(); readonly errors = this._errors.asReadonly(); readonly loaded = this._loaded.asReadonly();
  upsert(item: TaskItem): void { this._records.update(r => !r[item.id] || item.rev > r[item.id].rev ? { ...r, [item.id]: item } : r); }
  remove(id: string): void { this._records.update(r => { const next = { ...r }; delete next[id]; return next; }); }
  replace(items: TaskItem[], errors: StorageError[]): void { this._records.set(Object.fromEntries(items.map(item => [item.id, item]))); this._errors.set(errors); this._loaded.set(true); }
  clear(): void { this._records.set({}); this._errors.set([]); this._loaded.set(false); }
}
