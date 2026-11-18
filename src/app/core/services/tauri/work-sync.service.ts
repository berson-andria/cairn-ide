import { Injectable, effect, inject } from '@angular/core';
import { NodeStore } from '../../store/node.store';
import { TaskStore } from '../../store/task.store';
import { NoteStore } from '../../store/note.store';
import { TaskService } from '../../../feature/tasks/task.service';
import { NoteService } from '../../../feature/notes/note.service';
import { WorkApiService } from './work-api.service';
import { subscribeWorkEvents } from './work-events';
import { NoticeManager } from '../notification/notification.service';

@Injectable({providedIn:'root'})
export class WorkSyncService {
  private readonly nodes=inject(NodeStore); private readonly tasks=inject(TaskStore); private readonly notes=inject(NoteStore);
  private readonly taskService=inject(TaskService); private readonly noteService=inject(NoteService); private readonly api=inject(WorkApiService); private readonly notices=inject(NoticeManager);
  private currentPath:string|null=null;
  constructor(){
    void subscribeWorkEvents({taskCreated:r=>this.tasks.upsert(r),taskUpdated:r=>this.tasks.upsert(r),taskDeleted:id=>this.tasks.remove(id),noteCreated:r=>this.notes.upsert(r),noteUpdated:r=>this.notes.upsert(r),noteDeleted:id=>this.notes.remove(id),projectReloaded:()=>{void this.refresh();}}).catch(e=>console.error('Could not subscribe to task and note events',e));
    effect(()=>{const path=this.nodes.rootPath();if(path===this.currentPath)return;this.currentPath=path;this.tasks.clear();this.notes.clear();void this.open(path);});
  }
  private async open(path:string|null):Promise<void>{try{if(!path){await this.api.projectClose();return;}await this.api.projectOpen(path);await this.refresh();}catch(e){this.notices.error((e as {message?:string})?.message??String(e));}}
  private async refresh():Promise<void>{await Promise.all([this.taskService.refresh(),this.noteService.refresh()]);}
}
