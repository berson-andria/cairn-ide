import type { NewSubTask, NewTask, TaskItem } from '../../feature/tasks/task.service';

export type WorkflowSource = 'project' | 'global' | 'bundled';
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
  source: WorkflowSource;
  scriptHash: string;
  startedAt: number;
  endedAt?: number;
  outcome?: RunOutcome;
  reason?: string;
  summary?: string;
  steps?: RunStep[];
}

export interface WorkflowInfo {
  name: string;
  source: WorkflowSource;
  overrides: WorkflowSource[];
  trusted: boolean;
  entry: string;
}

export interface WorkflowTrustStatus {
  hasWorkflows: boolean;
  trusted: boolean;
  folderHash: string;
  approvedHash?: string;
  files: { path: string; size: number; sha256: string }[];
  changes: { path: string; change: 'added' | 'modified' | 'removed' }[];
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
  | 'RuntimeUnavailable'
  | 'WorkflowNotFound'
  | 'BadArgs';
