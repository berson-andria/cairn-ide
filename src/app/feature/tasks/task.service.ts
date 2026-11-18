import { Injectable, computed, inject, signal } from '@angular/core';
import { TaskStore } from '../../core/store/task.store';
import { WorkApiService, type ApiError } from '../../core/services/tauri/work-api.service';
import { NoticeManager } from '../../core/services/notification/notification.service';

export type TaskStatus = 'ready' | 'running' | 'blocked' | 'needs_review' | 'completed' | 'failed';
export interface TaskAnchor { kind: 'file' | 'function' | 'ast'; path: string; label?: string; lineNumber?: number; }
export interface SubTask { id: string; title: string; description?: string; status: TaskStatus; createdAt: number; updatedAt?: number; }
export interface NewSubTask { title: string; description?: string; }
export interface SubTaskPatch { title?: string; description?: string | null; status?: TaskStatus; }
export interface NewTask { title: string; description?: string | null; anchor?: TaskAnchor | null; linkedNoteIds?: string[] | null; subTasks?: NewSubTask[] | null; dependsOn?: string | null; acceptanceCriteria?: string | null; branch?: string | null; }
export interface TaskPatch { title?: string; description?: string | null; }
export interface TaskItem { id: string; title: string; description?: string; anchor?: TaskAnchor; linkedNoteIds?: string[]; subTasks?: SubTask[]; dependsOn?: string; status: TaskStatus; createdAt: number; updatedAt?: number; acceptanceCriteria?: string; branch?: string; schemaVersion: number; rev: number; }

@Injectable({ providedIn: 'root' })
export class TaskService {
  private readonly store = inject(TaskStore);
  private readonly api = inject(WorkApiService);
  private readonly notices = inject(NoticeManager);
  readonly records = this.store.records;
  readonly errors = this.store.errors;
  readonly loaded = this.store.loaded;
  readonly tasks = computed(() => Object.values(this.records()));
  readonly selectedTaskId = signal<string | null>(null);
  readonly selectedTask = computed(() => this.get(this.selectedTaskId() ?? ''));
  readonly readyTasks = computed(() => this.tasks().filter(t => t.status === 'ready'));
  readonly runningTasks = computed(() => this.tasks().filter(t => t.status === 'running'));
  readonly blockedTasks = computed(() => this.tasks().filter(t => t.status === 'blocked'));
  readonly completedTasks = computed(() => this.tasks().filter(t => t.status === 'completed'));
  readonly needsReviewTasks = computed(() => this.tasks().filter(t => t.status === 'needs_review'));
  readonly failedTasks = computed(() => this.tasks().filter(t => t.status === 'failed'));
  readonly availableTasks = computed(() => this.tasks().filter(t => t.status !== 'completed' && (!t.dependsOn || this.get(t.dependsOn)?.status === 'completed')));
  private refreshPromise?: Promise<void>;
  refresh(): Promise<void> { return this.refreshPromise ??= this.api.taskList().then(r => this.store.replace(r.records, r.errors)).catch(e => this.handleApiError(e as ApiError)).finally(() => this.refreshPromise = undefined); }
  get(id: string): TaskItem | undefined { return this.records()[id]; }
  select(id: string | null): void { this.selectedTaskId.set(id && this.get(id) ? id : null); }
  canStart(id: string): boolean { const t=this.get(id); return !!t && t.status==='ready' && (!t.dependsOn || this.get(t.dependsOn)?.status==='completed'); }
  getDependentTasks(id: string): TaskItem[] { return this.tasks().filter(t=>t.dependsOn===id); }
  private async mutate(id: string, run: (rev: number) => Promise<TaskItem>): Promise<TaskItem | undefined> { const current=this.get(id); if(!current) return; try { return await run(current.rev); } catch(e) { await this.handleApiError(e as ApiError, id); return; } }
  private async handleApiError(error: ApiError, id?: string): Promise<void> { if(error?.code==='StaleRev' && id) { try { this.store.upsert(await this.api.taskGet(id)); } catch {} } if(error?.code==='NoProject') return; this.notices.error(error?.code==='StaleRev' ? 'This changed elsewhere; try again.' : error?.message ?? String(error)); }
  async add(data: NewTask): Promise<TaskItem | undefined> { try { return await this.api.taskCreate(data); } catch(e) { await this.handleApiError(e as ApiError); return; } }
  edit(id: string, patch: TaskPatch): Promise<TaskItem | undefined> { return this.mutate(id, rev=>this.api.taskUpdate(id,patch,rev)); }
  async delete(id: string): Promise<void> { try { await this.api.taskDelete(id); if(this.selectedTaskId()===id) this.select(this.tasks()[0]?.id ?? null); } catch(e) { await this.handleApiError(e as ApiError,id); } }
  setStatus(id: string,status:TaskStatus):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskSetStatus(id,status,rev));}
  start(id:string):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskStart(id,rev));}
  complete(id:string):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskComplete(id,rev));}
  setAnchor(id:string,anchor:TaskAnchor|null):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskSetAnchor(id,anchor,rev));}
  addLinkedNote(id:string,noteId:string):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskLinkNote(id,noteId,rev));}
  removeLinkedNote(taskId:string,noteId:string):Promise<TaskItem|undefined>{return this.mutate(taskId,rev=>this.api.taskUnlinkNote(taskId,noteId,rev));}
  setDependency(id:string,dependsOn:string|null):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskSetDependency(id,dependsOn,rev));}
  addSubTask(id:string,subtask:NewSubTask):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskAddSubtask(id,subtask,rev));}
  updateSubTask(id:string,subId:string,patch:SubTaskPatch):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskUpdateSubtask(id,subId,patch,rev));}
  deleteSubTask(id:string,subId:string):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskDeleteSubtask(id,subId,rev));}
  setAcceptanceCriteria(id:string,value:string|null):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskSetAcceptanceCriteria(id,value,rev));}
  setBranch(id:string,value:string|null):Promise<TaskItem|undefined>{return this.mutate(id,rev=>this.api.taskSetBranch(id,value,rev));}
}
