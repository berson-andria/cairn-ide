import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { PatchSummary, RunRecord } from '../../shared/models/agent.model';
import { TaskItem } from '../tasks/task.service';
import { PatchService } from '../../core/services/patches/patch.service';

type RunState = 'running' | 'needs_review' | 'failed' | 'completed';

const LABELS: Record<RunState, string> = {
  running: 'Running',
  needs_review: 'Needs review',
  failed: 'Failed',
  completed: 'Done',
};

@Component({
  selector: 'run-item',
  templateUrl: './run.html',
  styleUrl: './run.scss',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunItem {
  private readonly patchService = inject(PatchService);
  readonly run = input.required<RunRecord>();
  /** Used only to turn step subtask ids into titles. */
  readonly subtasks = input<TaskItem['subTasks']>([]);

  readonly patches = signal<PatchSummary[] | null>(null);

  readonly pendingPatches = computed(
    () => this.patches()?.filter((p) => p.status === 'pending').length,
  );
  readonly files = signal<string[]>([]);

  private loadSeq = 0;
  readonly state = computed<RunState>(() => {
    const r = this.run();
    if (!r.outcome && !r.endedAt) return 'running';
    return (r.outcome as RunState) ?? 'needs_review';
  });
  private readonly runEnd = computed(() => {
    return this.state() !== 'running';
  });
  readonly label = computed(() => LABELS[this.state()] ?? this.state());
  readonly shortId = computed(() => this.run().runId.slice(0, 8));

  readonly started = computed(() => {
    const t = this.run().startedAt;
    return t ? new Date(t) : null;
  });

  readonly duration = computed(() => {
    const { startedAt, endedAt } = this.run();
    if (!startedAt || !endedAt) return null;
    const secs = Math.max(0, Math.round((+new Date(endedAt) - +new Date(startedAt)) / 1000));
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    return m < 60 ? `${m}m ${secs % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  });

  readonly steps = computed(() => {
    const titles = new Map((this.subtasks() ?? []).map((s) => [s.id, s.title]));
    return (this.run().steps ?? []).map((s) => ({
      ...s,
      title: titles.get(s.subtaskId) ?? s.subtaskId.slice(0, 8),
    }));
  });

  constructor() {
    effect(async () => {
      if (this.runEnd()) {
        await this.patchService.refresh();
        const runId = this.run().runId;
        this.patches.set(this.patchService.forRun(this.run().runId)());
        console.log(this.patches());

        const live = untracked(() => this.patches()!).filter((p) => p.status !== 'discarded');
        void this.collectFiles(
          runId,
          live.map((p) => p.id),
        );
      }
    });
  }

  private async collectFiles(runId: string, patchIds: string[]): Promise<void> {
    const seq = ++this.loadSeq;
    const records = await Promise.all(patchIds.map((id) => this.patchService.load(runId, id)));
    if (seq !== this.loadSeq) return; // a newer load superseded this one
    const paths = new Set<string>();
    for (const record of records) {
      for (const file of record?.files ?? []) paths.add(file.path);
    }
    this.files.set([...paths]);
  }
}
