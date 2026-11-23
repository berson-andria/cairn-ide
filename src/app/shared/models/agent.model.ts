import type { NewSubTask, NewTask, TaskItem } from '../../feature/tasks/task.service';

export type WorkflowScope = 'project' | 'global' | 'bundled';
export type RunOutcome = 'needs_review' | 'failed';

export interface RunStep {
  subtaskId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: 'needs_review' | 'failed';
  summary?: string;
  reason?: string;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  workflow: string;
  source: WorkflowScope;
  scriptHash: string;
  startedAt: number;
  endedAt?: number;
  outcome?: RunOutcome;
  reason?: string;
  summary?: string;
  steps?: RunStep[];
}

export interface WorkflowSourceStatus {
  source: WorkflowScope;
  folder: string;
  status: 'empty' | 'ok' | 'no-entry' | 'reserved-name';
  entry?: string;
  message?: string;
  warnings: string[];
  trusted: boolean | null;
}

export interface WorkflowStatus {
  active: WorkflowScope | null;
  sources: WorkflowSourceStatus[];
  needsChoice: boolean;
  choice: Exclude<WorkflowScope, 'project'> | null;
  choiceOptions: { bundled: boolean; global: boolean };
  activeVia: 'project' | 'chosen' | 'fallback' | null;
}

export type PatchStatus = 'pending' | 'applied' | 'discarded';

export interface PatchSummary {
  id: string;
  runId: string;
  taskId: string;
  subtaskId?: string;
  title: string;
  summary?: string;
  status: PatchStatus;
  createdAt: number;
  appliedAt?: number;
}

export interface PatchFile {
  path: string;
  op: 'create' | 'modify';
  baseSha256?: string;
  before?: string;
  after: string;
}

export interface Patch extends PatchSummary {
  files: PatchFile[];
}

export interface WorkflowTemplate {
  id: string;
  title: string;
  description: string;
}

export interface WorkflowTrustStatus {
  hasWorkflows: boolean;
  trusted: boolean;
  folderHash: string;
  approvedHash?: string;
  files: { path: string; size: number; sha256: string }[];
  changes: { path: string; change: 'added' | 'modified' | 'removed' }[];
}

export type TrustState = 'unknown' | 'none' | 'unreviewed' | 'changed' | 'trusted';

export interface TrustSummary {
  added: number;
  modified: number;
  removed: number;
  detailsAvailable: boolean;
}

export interface WorkflowTrustReview {
  state: TrustState;
  files: WorkflowTrustStatus['files'];
  changes: WorkflowTrustStatus['changes'];
}

export interface BatchTaskItem extends NewTask {
  key: string;
  dependsOnKey?: string;
}

export interface TaskProposal {
  id: string;
  kind: 'task';
  status: 'pending' | 'accepted' | 'rejected';
  presentation: 'display' | 'notify';
  runId: string;
  taskId?: string;
  workflow: string;
  payload: NewTask;
  createdTaskId?: string;
  createdTaskIds?: string[];
  seenAt?: number;
  createdAt: number;
  decidedAt?: number;
  schemaVersion: number;
  rev: number;
}

export interface TasksProposal extends Omit<TaskProposal, 'kind' | 'payload'> {
  kind: 'tasks';
  payload: { sourceTaskId?: string; items: BatchTaskItem[] };
}

export interface SubtasksProposal extends Omit<TaskProposal, 'kind' | 'payload'> {
  kind: 'subtasks';
  payload: { taskId: string; items: NewSubTask[] };
}

export type Proposal = TaskProposal | TasksProposal | SubtasksProposal;
export type ProposalPayload = Proposal['payload'];
export type SourceAction = 'keep' | 'delete';

export interface AcceptResult {
  proposal: Proposal;
  tasks: TaskItem[];
}

export interface RunStartedEvent {
  runId: string;
  taskId: string;
  workflow: string;
}

export interface RunLogEvent {
  runId: string;
  lines: string[];
}

export interface RunFinishedEvent {
  runId: string;
  taskId: string;
  outcome: RunOutcome;
  reason?: string;
}

export interface RunStepEvent {
  runId: string;
  taskId: string;
  subtaskId: string;
  status: 'running' | 'needs_review' | 'failed';
  summary?: string;
  reason?: string;
}

export interface ProposalDeletedEvent {
  id: string;
}

export type RunState = Pick<RunRecord, 'runId' | 'taskId'> &
  Partial<Omit<RunRecord, 'runId' | 'taskId'>>;

export type ApiErrorCode =
  | 'NotFound'
  | 'StaleRev'
  | 'InvalidTransition'
  | 'Forbidden'
  | 'Validation'
  | 'Io'
  | 'Corrupt'
  | 'NoProject'
  | 'RunActive'
  | 'TrustRequired'
  | 'WorkflowChoiceRequired'
  | 'RuntimeUnavailable'
  | 'ContextTooLarge'
  | 'ModelUnavailable'
  | 'ModelError'
  | 'PatchConflict'
  | 'BadArgs';
