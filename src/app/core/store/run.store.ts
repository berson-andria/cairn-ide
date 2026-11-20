import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import type { RunRecord, RunState, RunStartedEvent, RunLogEvent, RunFinishedEvent } from '../../shared/models/agent.model';
import { WorkApiService } from '../services/tauri/work-api.service';

const LOG_LIMIT = 500;

@Injectable({ providedIn: 'root' })
export class RunStore {
  private readonly api = inject(WorkApiService);
  private readonly _current = signal<RunState | null>(null);
  private readonly _history = signal<RunRecord[]>([]);
  private readonly _logs = signal<Record<string, string[]>>({});
  private readonly logSignals = new Map<string, Signal<string[]>>();
  private refreshPromise?: Promise<void>;
  private generation = 0;

  readonly current = this._current.asReadonly();
  readonly history = this._history.asReadonly();

  logLines(runId: string) {
    let lines = this.logSignals.get(runId);
    if (!lines) {
      lines = computed(() => this._logs()[runId] ?? []);
      this.logSignals.set(runId, lines);
    }
    return lines;
  }

  started(event: RunStartedEvent): void {
    this._current.set({ ...event });
    this._logs.update(logs => ({ ...logs, [event.runId]: [] }));
  }

  append(event: RunLogEvent): void {
    this._logs.update(logs => ({
      ...logs,
      [event.runId]: [...(logs[event.runId] ?? []), ...event.lines].slice(-LOG_LIMIT),
    }));
  }

  finished(event: RunFinishedEvent): void {
    const current = this._current();
    if (!current || current.runId !== event.runId) return;
    this._current.set({ ...current, outcome: event.outcome, reason: event.reason });
  }

  setCurrent(run: RunRecord | null): void {
    const previous = this._current();
    this._current.set(
      run ? { ...(previous?.runId === run.runId ? previous : {}), ...run } : null,
    );
  }

  setHistory(history: RunRecord[]): void {
    this._history.set(history);
  }

  setLog(runId: string, lines: string[]): void {
    this._logs.update(logs => ({ ...logs, [runId]: lines.slice(-LOG_LIMIT) }));
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    let request: Promise<void>;
    request = this.api
      .runGet()
      .then(async run => {
        if (generation !== this.generation) return;
        this.setCurrent(run);
        if (run && !run.endedAt) {
          const lines = await this.api.runLog(run.runId, LOG_LIMIT);
          if (generation === this.generation) this.setLog(run.runId, lines);
        }
      })
      .finally(() => {
        if (this.refreshPromise === request) this.refreshPromise = undefined;
      });
    this.refreshPromise = request;
    return request;
  }

  clear(): void {
    this.generation++;
    this._current.set(null);
    this._history.set([]);
    this._logs.set({});
    this.logSignals.clear();
    this.refreshPromise = undefined;
  }
}
