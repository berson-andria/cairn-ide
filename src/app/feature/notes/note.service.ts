import { Injectable, computed, inject } from '@angular/core';
import { NoteStore } from '../../core/store/note.store';
import { WorkApiService, type ApiError } from '../../core/services/tauri/work-api.service';
import { handleApiError as reportApiError } from '../../core/services/tauri/api-error';
import { NoticeManager } from '../../core/services/notification/notification.service';

export interface AstAnchor { kind:'ast'; id?:string; label:string; path:string; lost?:boolean; }
export type NoteAnchor = AstAnchor;
export type NoteStatus = 'open'|'completed';
export interface NoteItem { id:string; content:string; type?:string; status:NoteStatus; anchors:NoteAnchor[]; createdAt:number; updatedAt?:number; schemaVersion:number; rev:number; }
export interface NewNote { content:string; type?:string|null; anchors?:NoteAnchor[]; }
export interface NotePatch { content?:string; type?:string|null; }

@Injectable({providedIn:'root'})
export class NoteService {
  private readonly store=inject(NoteStore); private readonly api=inject(WorkApiService); private readonly notices=inject(NoticeManager);
  readonly records=this.store.records; readonly errors=this.store.errors; readonly loaded=this.store.loaded;
  readonly notes=computed(()=>Object.values(this.records()));
  readonly openNotes=computed(()=>this.notes().filter(n=>n.status==='open'));
  readonly completedNotes=computed(()=>this.notes().filter(n=>n.status==='completed'));
  readonly inboxNotes=computed(()=>this.notes().filter(n=>!n.anchors.length));
  private refreshPromise?:Promise<void>;
  refresh():Promise<void>{return this.refreshPromise??=this.api.noteList().then(r=>this.store.replace(r.records,r.errors)).catch(e=>this.handleApiError(e)).finally(()=>this.refreshPromise=undefined);}
  get(id:string):NoteItem|undefined{return this.records()[id];}
  private async mutate(id:string,run:(rev:number)=>Promise<NoteItem>):Promise<NoteItem|undefined>{const n=this.get(id);if(!n)return;try{return await run(n.rev);}catch(e){await this.handleApiError(e as ApiError,id);return;}}
  private async handleApiError(error:ApiError,id?:string):Promise<void>{await reportApiError(error,this.notices,id?async()=>this.store.upsert(await this.api.noteGet(id)):undefined);}
  async add(data:NewNote):Promise<NoteItem|undefined>{try{return await this.api.noteCreate(data);}catch(e){await this.handleApiError(e as ApiError);return;}}
  edit(id:string,patch:NotePatch):Promise<NoteItem|undefined>{return this.mutate(id,rev=>this.api.noteUpdate(id,patch,rev));}
  async delete(id:string):Promise<void>{try{await this.api.noteDelete(id);}catch(e){await this.handleApiError(e as ApiError,id);}}
  setAnchors(id:string,anchors:NoteAnchor[]):Promise<NoteItem|undefined>{return this.mutate(id,rev=>this.api.noteSetAnchors(id,anchors,rev));}
  setAnchor(id:string,anchor:NoteAnchor|NoteAnchor[]|null):Promise<NoteItem|undefined>{return this.setAnchors(id,anchor===null?[]:Array.isArray(anchor)?anchor:[anchor]);}
  async addAnchor(id:string,anchor:NoteAnchor):Promise<NoteItem|undefined>{const n=this.get(id);return n?this.setAnchors(id,[...n.anchors,anchor]):undefined;}
  async removeAnchor(id:string,index:number):Promise<NoteItem|undefined>{return this.mutate(id,rev=>this.api.noteRemoveAnchor(id,index,rev));}
  setStatus(id:string,status:NoteStatus):Promise<NoteItem|undefined>{return this.mutate(id,rev=>this.api.noteSetStatus(id,status,rev));}
  toggleStatus(id:string):Promise<NoteItem|undefined>{return this.mutate(id,rev=>this.api.noteToggleStatus(id,rev));}
}
