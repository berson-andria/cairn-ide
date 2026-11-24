import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { WorkflowSourceStatus } from '../../../shared/models/agent.model';
import { EditorCommands } from '../../editor/editor.commands';
import { WorkflowService } from '../../../core/services/runs/workflow.service';
import { WorkApiService } from '../../../core/services/tauri/work-api.service';
import { NodeStore } from '../../../core/store/node.store';
import { DialogService } from '../../../core/services/dialog/dialog.service';
import { TrustSetting } from '../../../shared/components/trust-setting/trust';
import { MarkdownView } from '../../../shared/components/markdown-view/markdown-view';

@Component({
  selector: 'app-workflow-settings',
  standalone: true,
  templateUrl: './workflow-settings.html',
  styleUrl: './workflow-settings.scss',
  imports: [MarkdownView],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowSettings {
  readonly workflow = inject(WorkflowService);
  private readonly api = inject(WorkApiService);
  private readonly editor = inject(EditorCommands);
  private readonly nodes = inject(NodeStore);
  private readonly dialogs = inject(DialogService);

  readonly selectedTemplate = signal('');
  readonly creating = signal(false);
  readonly message = signal<string | null>(null);
  readonly expandedTemplates = signal<Record<string, boolean>>({});
  readonly templateContents = signal<Record<string, string>>({});
  readonly templateLoading = signal<Record<string, boolean>>({});
  readonly templateErrors = signal<Record<string, string>>({});
  readonly copiedTemplate = signal<string | null>(null);
  readonly copyErrors = signal<Record<string, string>>({});

  projectSource(): WorkflowSourceStatus | undefined {
    return this.workflow.status()?.sources.find((source) => source.source === 'project');
  }

  bundledSource(): WorkflowSourceStatus | undefined {
    return this.workflow.status()?.sources.find((source) => source.source === 'bundled');
  }

  canUseWorkflow(scope: 'global' | 'bundled'): boolean {
    const status = this.workflow.status();
    const source = status?.sources.find((item) => item.source === scope);
    return (
      status?.sources.find((source) => source.source === 'project')?.status === 'no-entry' &&
      status.choiceOptions[scope] &&
      source?.status === 'ok' &&
      status.active !== scope
    );
  }

  async useWorkflow(scope: 'global' | 'bundled'): Promise<void> {
    this.message.set(null);
    await this.workflow.choose(scope);
  }

  async clearChoice(): Promise<void> {
    this.message.set(null);
    await this.workflow.clearChoice();
  }

  async createWorkflow(): Promise<void> {
    const template = this.selectedTemplate();
    if (!template || this.creating()) return;

    this.creating.set(true);
    this.message.set(null);
    try {
      const result = await this.workflow.create('project', template);
      if (result?.kind === 'created') {
        await this.openPath(result.entryPath);
      } else if (result?.kind === 'exists') {
        this.message.set('A workflow already exists in .cairn/workflows.');
      } else {
        this.message.set(
          'Workflow creation failed. Check the notification for validation details, including main.py name conflicts and path collisions.',
        );
      }
    } finally {
      this.creating.set(false);
    }
  }

  async openProjectEntry(): Promise<void> {
    const entry = this.projectSource()?.entry;
    const root = this.nodes.rootPath();
    if (!entry || !root) {
      this.message.set('The project workflow entry is not available.');
      return;
    }
    await this.openPath(`${root.replace(/[\\/]+$/, '')}\\${entry.replace(/\//g, '\\')}`);
  }

  async openTrustReview(): Promise<void> {
    this.dialogs.open(TrustSetting);
  }

  selectTemplate(event: Event): void {
    this.selectedTemplate.set((event.target as HTMLSelectElement).value);
  }

  toggleTemplate(id: string): void {
    const expanded = !this.expandedTemplates()[id];
    this.expandedTemplates.update((current) => ({ ...current, [id]: expanded }));
    if (expanded) void this.loadTemplate(id);
  }

  async loadTemplate(id: string): Promise<void> {
    if (Object.prototype.hasOwnProperty.call(this.templateContents(), id)) return;
    if (this.templateLoading()[id]) return;

    this.templateLoading.update((current) => ({ ...current, [id]: true }));
    this.templateErrors.update((current) => ({ ...current, [id]: '' }));
    try {
      const content = await this.api.workflowTemplateGet(id);
      this.templateContents.update((current) => ({ ...current, [id]: content }));
    } catch (error) {
      this.templateErrors.update((current) => ({
        ...current,
        [id]: this.errorMessage(error, 'Unable to load this template.'),
      }));
    } finally {
      this.templateLoading.update((current) => ({ ...current, [id]: false }));
    }
  }

  async copyTemplate(id: string): Promise<void> {
    const content = this.templateContents()[id];
    if (content === undefined) return;
    this.copyErrors.update((current) => ({ ...current, [id]: '' }));
    try {
      await navigator.clipboard.writeText(content);
      this.copiedTemplate.set(id);
      setTimeout(() => {
        if (this.copiedTemplate() === id) this.copiedTemplate.set(null);
      }, 1500);
    } catch (error) {
      this.copiedTemplate.set(null);
      this.copyErrors.update((current) => ({
        ...current,
        [id]: this.errorMessage(error, 'Clipboard access failed.'),
      }));
    }
  }

  private async openPath(path: string): Promise<void> {
    try {
      const opened = await this.editor.openPath(path);
      if (!opened) this.message.set('The workflow was created, but its entry could not be opened.');
    } catch (error) {
      this.message.set(this.errorMessage(error, 'The workflow entry could not be opened.'));
    }
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    return fallback;
  }
}
