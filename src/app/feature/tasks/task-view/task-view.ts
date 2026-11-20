import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TaskService, type TaskItem } from '../task.service';
import { NoteService } from '../../notes/note.service';
import { LayoutService } from '../../../core/services/layout.service';
import { AutoExpandDirective } from '../../../shared/directives/auto-expand';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideNotebook, lucidePlus } from '@ng-icons/lucide';

@Component({
  selector: 'app-task-view',
  templateUrl: './task-view.html',
  styleUrl: './task-view.scss',
  imports: [AutoExpandDirective, NgIcon],
  providers: [provideIcons({ lucideNotebook, lucidePlus })],
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskView {
  readonly taskInput = input<TaskItem | null>(null, { alias: 'task' });
  readonly taskId = input<string | undefined>();
  readonly taskService = inject(TaskService);
  private readonly noteService = inject(NoteService);
  private readonly layoutService = inject(LayoutService);
  readonly task = computed(() => {
    const id = this.taskId();
    return id
      ? (this.taskService.get(id) ?? null)
      : (this.taskInput() ?? this.taskService.selectedTask());
  });
  private readonly descriptionDraft = signal<{ taskId: string; value: string } | null>(null);
  readonly showSubtaskInput = signal(false);
  readonly subtaskDraft = signal('');
  readonly showDependencyPicker = signal(false);
  readonly dependencySearch = signal('');
  readonly hasDescriptionChanges = computed(() => {
    const task = this.task();
    const draft = this.descriptionDraft();
    return !!task && draft?.taskId === task.id && draft.value !== (task.description ?? '');
  });
  readonly canStart = computed(() => {
    const task = this.task();
    return !!task && this.taskService.canStart(task.id) && task.status !== 'running';
  });
  readonly linkedNotes = computed(() => {
    const ids = this.task()?.linkedNoteIds ?? [];
    return this.noteService.notes().filter((note) => ids.includes(note.id));
  });
  readonly dependencyCandidates = computed(() => {
    const task = this.task();
    return this.taskService
      .tasks()
      .filter((candidate) => candidate.id !== task?.id && candidate.id !== task?.dependsOn);
  });
  readonly filteredDependencyCandidates = computed(() => {
    const query = this.dependencySearch().trim().toLowerCase();
    const candidates = this.dependencyCandidates();
    return query
      ? candidates.filter(
          (candidate) =>
            candidate.title.toLowerCase().includes(query) ||
            candidate.id.toLowerCase().includes(query),
        )
      : candidates;
  });

  async updateTitle(title: string): Promise<void> {
    const task = this.task();
    if (task && title.trim()) await this.taskService.edit(task.id, { title: title.trim() });
  }

  async startTask(): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.start(task.id);
  }

  async setStatus(status: TaskItem['status']): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.setStatus(task.id, status);
  }

  async completeTask(): Promise<void> {
    const task = this.task();
    if (task) await this.taskService.complete(task.id);
  }

  toggleSubtaskInput(): void {
    const opening = !this.showSubtaskInput();
    this.showSubtaskInput.set(opening);
    if (!opening) this.subtaskDraft.set('');
  }

  async addSubtask(taskId: string): Promise<void> {
    const title = this.subtaskDraft().trim();
    if (!title) return;
    const updated = await this.taskService.addSubTask(taskId, { title });
    if (!updated) return;
    this.subtaskDraft.set('');
    this.showSubtaskInput.set(false);
  }

  setDescriptionDraft(taskId: string, value: string): void {
    this.descriptionDraft.set({ taskId, value });
  }

  async updateDescription(taskId: string, description: string): Promise<void> {
    await this.taskService.edit(taskId, { description });
    if (this.descriptionDraft()?.taskId === taskId) this.descriptionDraft.set(null);
  }

  cancelDescription(textarea: HTMLTextAreaElement): void {
    textarea.value = this.task()?.description ?? '';
    this.descriptionDraft.set(null);
  }

  toggleDependencyPicker(): void {
    const opening = !this.showDependencyPicker();
    this.showDependencyPicker.set(opening);
    if (opening) this.dependencySearch.set('');
  }

  closeDependencyPickerOnBlur(event: FocusEvent): void {
    const section = event.currentTarget;
    const nextTarget = event.relatedTarget;
    if (section instanceof HTMLElement && nextTarget instanceof Node && section.contains(nextTarget)) {
      return;
    }
    this.showDependencyPicker.set(false);
  }

  async setDependency(taskId: string, dependsOn: string | null): Promise<void> {
    const updated = await this.taskService.setDependency(taskId, dependsOn);
    if (!updated) return;
    this.showDependencyPicker.set(false);
    this.dependencySearch.set('');
  }

  async attachLinkedItem(): Promise<void> {
    const task = this.task();
    if (!task) return;
    const selected = await this.layoutService.openAnchor({ kind: 'task', id: task.id });
    if (!selected) return;
    if (selected.kind === 'file') {
      await this.taskService.setAnchor(task.id, { kind: 'file', path: selected.path });
    } else if (selected.kind === 'note') {
      await this.taskService.addLinkedNote(task.id, selected.id);
    }
  }

  statusLabel(status: TaskItem['status']): string {
    return status === 'completed'
      ? 'Done'
      : status === 'ready'
        ? 'Ready'
        : status[0].toUpperCase() + status.slice(1);
  }

  availabilityLabel(task: TaskItem): string {
    if (task.status === 'completed') return 'Completed';
    if (task.status === 'running') return 'Currently in progress';
    if (task.status === 'blocked') return 'Waiting on dependency';
    if (task.status === 'failed') {
    }
    return 'Ready to work';
  }
}
