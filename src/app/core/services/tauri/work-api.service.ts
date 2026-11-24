import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import type {
  NewTask,
  TaskPatch,
  NewSubTask,
  SubTaskPatch,
  TaskItem,
} from '../../../feature/tasks/task.service';
import type {
  NewNote,
  NotePatch,
  NoteItem,
  NoteAnchor,
  NoteStatus,
} from '../../../feature/notes/note.service';
import type {
  AcceptResult,
  ApiErrorCode,
  Proposal,
  ProposalPayload,
  Patch,
  PatchSummary,
  RunRecord,
  SourceAction,
  WorkflowScope,
  WorkflowStatus,
  WorkflowTemplate,
  WorkflowTrustStatus,
} from '../../../shared/models/agent.model';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}
export interface StorageError extends ApiError {}
export interface ListResult<T> {
  records: T[];
  errors: StorageError[];
}

export interface ProjectHistoryEntry {
  path: string;
  name: string;
  lastOpenedAt: number;
  missing: boolean;
}

export interface ProjectHistorySnapshot {
  lastProject: string | null;
  projects: ProjectHistoryEntry[];
}

export interface LaunchArgs {
  folder?: string;
  newWindow: boolean;
}

@Injectable({ providedIn: 'root' })
export class WorkApiService {
  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await invoke<T>(command, args);
    } catch (reason) {
      if (reason && typeof reason === 'object' && 'code' in reason && 'message' in reason)
        throw {
          code: String((reason as ApiError).code) as ApiErrorCode,
          message: String((reason as ApiError).message),
        } satisfies ApiError;
      throw {
        code: 'BadArgs',
        message: typeof reason === 'string' ? reason : String(reason),
      } satisfies ApiError;
    }
  }
  projectOpen(path: string) {
    return this.call<string>('project_open', { path });
  }
  projectClose() {
    return this.call<void>('project_close');
  }
  launchArgs() {
    return this.call<LaunchArgs>('launch_args');
  }
  windowNew(folder?: string) {
    return this.call<void>('window_new', { folder });
  }
  projectHistory() {
    return this.call<ProjectHistorySnapshot>('project_history');
  }
  projectHistoryRemove(path: string) {
    return this.call<void>('project_history_remove', { path });
  }
  projectHistoryClear() {
    return this.call<void>('project_history_clear');
  }
  taskList() {
    return this.call<ListResult<TaskItem>>('task_list');
  }
  taskGet(id: string) {
    return this.call<TaskItem>('task_get', { id });
  }
  taskCreate(task: NewTask) {
    return this.call<TaskItem>('task_create', { task });
  }
  taskUpdate(id: string, patch: TaskPatch, expectedRev: number) {
    return this.call<TaskItem>('task_update', { id, patch, expectedRev });
  }
  taskDelete(id: string) {
    return this.call<void>('task_delete', { id });
  }
  taskSetStatus(id: string, status: TaskItem['status'], expectedRev: number) {
    return this.call<TaskItem>('task_set_status', { id, status, expectedRev });
  }
  taskStart(id: string, expectedRev: number) {
    return this.call<TaskItem>('task_start', { id, expectedRev });
  }
  taskComplete(id: string, expectedRev: number) {
    return this.call<TaskItem>('task_complete', { id, expectedRev });
  }
  taskSetDependency(id: string, dependsOn: string | null, expectedRev: number) {
    return this.call<TaskItem>('task_set_dependency', { id, dependsOn, expectedRev });
  }
  taskSetAnchor(id: string, anchor: TaskItem['anchor'] | null, expectedRev: number) {
    return this.call<TaskItem>('task_set_anchor', { id, anchor, expectedRev });
  }
  taskLinkNote(id: string, noteId: string, expectedRev: number) {
    return this.call<TaskItem>('task_link_note', { id, noteId, expectedRev });
  }
  taskUnlinkNote(id: string, noteId: string, expectedRev: number) {
    return this.call<TaskItem>('task_unlink_note', { id, noteId, expectedRev });
  }
  taskSetAcceptanceCriteria(id: string, criteria: string | null, expectedRev: number) {
    return this.call<TaskItem>('task_set_acceptance_criteria', { id, criteria, expectedRev });
  }
  taskSetBranch(id: string, branch: string | null, expectedRev: number) {
    return this.call<TaskItem>('task_set_branch', { id, branch, expectedRev });
  }
  taskAddSubtask(id: string, subtask: NewSubTask, expectedRev: number) {
    return this.call<TaskItem>('task_add_subtask', { id, subtask, expectedRev });
  }
  taskUpdateSubtask(id: string, subId: string, patch: SubTaskPatch, expectedRev: number) {
    return this.call<TaskItem>('task_update_subtask', { id, subId, patch, expectedRev });
  }
  taskDeleteSubtask(id: string, subId: string, expectedRev: number) {
    return this.call<TaskItem>('task_delete_subtask', { id, subId, expectedRev });
  }
  noteList() {
    return this.call<ListResult<NoteItem>>('note_list');
  }
  noteGet(id: string) {
    return this.call<NoteItem>('note_get', { id });
  }
  noteCreate(note: NewNote) {
    return this.call<NoteItem>('note_create', { note });
  }
  noteUpdate(id: string, patch: NotePatch, expectedRev: number) {
    return this.call<NoteItem>('note_update', { id, patch, expectedRev });
  }
  noteDelete(id: string) {
    return this.call<void>('note_delete', { id });
  }
  noteSetAnchors(id: string, anchors: NoteAnchor[], expectedRev: number) {
    return this.call<NoteItem>('note_set_anchors', { id, anchors, expectedRev });
  }
  noteSetAnchor(id: string, anchor: NoteAnchor | null, expectedRev: number) {
    return this.call<NoteItem>('note_set_anchor', { id, anchor, expectedRev });
  }
  noteAddAnchor(id: string, anchor: NoteAnchor, expectedRev: number) {
    return this.call<NoteItem>('note_add_anchor', { id, anchor, expectedRev });
  }
  noteRemoveAnchor(id: string, index: number, expectedRev: number) {
    return this.call<NoteItem>('note_remove_anchor', { id, index, expectedRev });
  }
  noteSetStatus(id: string, status: NoteStatus, expectedRev: number) {
    return this.call<NoteItem>('note_set_status', { id, status, expectedRev });
  }
  noteToggleStatus(id: string, expectedRev: number) {
    return this.call<NoteItem>('note_toggle_status', { id, expectedRev });
  }
  workflowStatus() {
    return this.call<WorkflowStatus>('workflow_status');
  }
  workflowChoose(scope: Exclude<WorkflowScope, 'project'>) {
    return this.call<void>('workflow_choose', { scope });
  }
  workflowChoiceClear() {
    return this.call<void>('workflow_choice_clear');
  }
  workflowTemplates() {
    return this.call<WorkflowTemplate[]>('workflow_templates');
  }
  workflowTemplateGet(id: string) {
    return this.call<string>('workflow_template_get', { id });
  }
  workflowCreate(scope: Exclude<WorkflowScope, 'bundled'> | 'bundled', template: string) {
    return this.call<{ source: WorkflowScope; entry: string; entryPath: string }>(
      'workflow_create',
      { scope, template },
    );
  }
  workspaceTrustStatus() {
    return this.call<WorkflowTrustStatus>('workspace_trust_status');
  }
  workspaceTrust(hash: string) {
    return this.call<void>('workspace_trust', { hash });
  }
  workspaceTrustRevoke() {
    return this.call<void>('workspace_trust_revoke');
  }
  runStart(taskId: string, expectedRev: number) {
    return this.call<RunRecord>('run_start', { taskId, expectedRev });
  }
  runCancel() {
    return this.call<void>('run_cancel');
  }
  runGet(runId?: string) {
    return this.call<RunRecord | null>('run_get', runId === undefined ? undefined : { runId });
  }
  runList(limit: number) {
    return this.call<RunRecord[]>('run_list', { limit });
  }
  runLog(runId: string, maxLines: number) {
    return this.call<string[]>('run_log', { runId, maxLines });
  }
  patchList(runId?: string) {
    return this.call<PatchSummary[]>('patch_list', runId === undefined ? undefined : { runId });
  }
  patchGet(runId: string, patchId: string) {
    return this.call<Patch>('patch_get', { runId, patchId });
  }
  patchApply(runId: string, patchId: string) {
    return this.call<PatchSummary>('patch_apply', { runId, patchId });
  }
  patchDiscard(runId: string, patchId: string) {
    return this.call<PatchSummary>('patch_discard', { runId, patchId });
  }
  proposalList() {
    return this.call<ListResult<Proposal>>('proposal_list');
  }
  proposalAccept(
    id: string,
    expectedRev: number,
    payload?: ProposalPayload,
    sourceAction?: SourceAction,
  ) {
    return this.call<AcceptResult>('proposal_accept', { id, expectedRev, payload, sourceAction });
  }
  proposalReject(id: string, expectedRev: number) {
    return this.call<Proposal>('proposal_reject', { id, expectedRev });
  }
  proposalDelete(id: string) {
    return this.call<void>('proposal_delete', { id });
  }
  proposalMarkSeen(ids: string[]) {
    return this.call<Proposal[]>('proposal_mark_seen', { ids });
  }
}
