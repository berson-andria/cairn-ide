import { Injectable, effect, inject } from '@angular/core';
import { NodeStore } from '../../store/node.store';
import { TaskStore } from '../../store/task.store';
import { NoteStore } from '../../store/note.store';
import { TaskService } from '../../../feature/tasks/task.service';
import { NoteService } from '../../../feature/notes/note.service';
import { WorkApiService } from './work-api.service';
import { subscribeWorkEvents } from './work-events';
import { NoticeManager } from '../notification/notification.service';
import { ProposalStore } from '../../store/proposal.store';
import { RunStore } from '../../store/run.store';
import { ProposalNotifier } from '../proposals/proposal-notifier.service';
import type { RunFinishedEvent } from '../../../shared/models/agent.model';
import { RunService } from '../runs/run.service';
import { WorkflowService } from '../runs/workflow.service';
import { ProjectHistoryService } from '../project-history.service';
import { PatchStore } from '../../store/patch.store';
import { PatchService } from '../patches/patch.service';

export function refreshFinishedRun(
  event: RunFinishedEvent,
  runs: RunStore,
  runService: RunService,
): Promise<void> {
  runs.finished(event);
  return runService.refresh();
}

@Injectable({ providedIn: 'root' })
export class WorkSyncService {
  private readonly nodes = inject(NodeStore);
  private readonly tasks = inject(TaskStore);
  private readonly notes = inject(NoteStore);
  private readonly taskService = inject(TaskService);
  private readonly noteService = inject(NoteService);
  private readonly api = inject(WorkApiService);
  private readonly notices = inject(NoticeManager);
  private readonly proposals = inject(ProposalStore);
  private readonly patches = inject(PatchStore);
  private readonly patchService = inject(PatchService);
  private readonly runs = inject(RunStore);
  private readonly proposalNotifier = inject(ProposalNotifier);
  private readonly runService = inject(RunService);
  private readonly workflowService = inject(WorkflowService);
  private readonly projectHistory = inject(ProjectHistoryService);
  private currentPath: string | null = null;
  private currentLoad: Promise<boolean> = Promise.resolve(false);
  constructor() {
    const eventsReady = subscribeWorkEvents({
      taskCreated: (r) => this.tasks.upsert(r),
      taskUpdated: (r) => this.tasks.upsert(r),
      taskReloaded: (r) => this.tasks.reload(r),
      taskDeleted: (id) => this.tasks.remove(id),
      noteCreated: (r) => this.notes.upsert(r),
      noteUpdated: (r) => this.notes.upsert(r),
      noteReloaded: (r) => this.notes.reload(r),
      noteDeleted: (id) => this.notes.remove(id),
      proposalCreated: (r) => {
        this.proposals.upsert(r);
        this.proposalNotifier.proposalCreated(r);
      },
      proposalUpdated: (r) => this.proposals.upsert(r),
      proposalDeleted: (id) => this.proposals.remove(id),
      patchCreated: (record) => this.patches.upsert(record),
      patchUpdated: (record) => this.patches.upsert(record),
      runStarted: (event) => this.runs.started(event),
      runLog: (event) => this.runs.append(event),
      runStep: (event) => this.runs.step(event),
      runFinished: (event) => {
        void refreshFinishedRun(event, this.runs, this.runService);
      },
      projectReloaded: () => {
        void this.refresh();
      },
    });
    effect(() => {
      const path = this.nodes.rootPath();
      if (path === this.currentPath) return;
      this.beginOpen(path, eventsReady);
    });
  }
  async waitForProjectLoaded(path: string): Promise<boolean> {
    while (this.nodes.rootPath() === path && this.currentPath !== path) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (this.nodes.rootPath() !== path) return false;
    const loaded = await this.currentLoad;
    return loaded && this.nodes.rootPath() === path;
  }
  private beginOpen(path: string | null, eventsReady: Promise<unknown>): void {
    this.currentPath = path;
    this.tasks.clear();
    this.notes.clear();
    this.proposals.clear();
    this.patchService.clear();
    this.runs.clear();
    this.workflowService.clear();
    this.currentLoad = this.open(path, eventsReady);
  }
  private async open(path: string | null, eventsReady: Promise<unknown>): Promise<boolean> {
    try {
      await eventsReady;
      if (!path) {
        await this.api.projectClose();
        await this.projectHistory.refresh();
        return true;
      }
      await this.api.projectOpen(path);
      await this.projectHistory.refresh();
      await Promise.all([this.taskService.refresh(), this.noteService.refresh()]);
      void Promise.all([
        this.proposals.refresh(),
        this.patches.refresh(),
        this.runService.refresh(),
        this.workflowService.refresh(),
        this.workflowService.projectOpened(),
      ]).catch((error) => {
        this.notices.error((error as { message?: string })?.message ?? String(error));
      });
      return this.tasks.loaded() && this.notes.loaded();
    } catch (e) {
      this.notices.error((e as { message?: string })?.message ?? String(e));
      return false;
    }
  }
  private async refresh(): Promise<void> {
    await Promise.all([
      this.taskService.refresh(),
      this.noteService.refresh(),
      this.proposals.refresh(),
      this.patches.refresh(),
    ]);
  }
}
