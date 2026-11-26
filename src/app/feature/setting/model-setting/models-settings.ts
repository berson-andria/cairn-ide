import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from '../settings.service';
import { emptyModelDraft, ModelDraft, ModelEntry } from './model-entry.model';

@Component({
  selector: 'app-models-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './models-settings.html',
  styleUrl: './models-settings.scss',
})
export class ModelsSettings {
  private readonly settings = inject(SettingsService);
  private readonly registry = this.settings.get<string>('models.registry');
  readonly models = computed(() => parseModels(this.registry()));
  readonly defaultModel = this.settings.get<string>('models.defaultModel');
  readonly draft = signal<ModelDraft>(emptyModelDraft());
  readonly apiKey = signal('');
  readonly savedSecret = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly formError = signal('');
  readonly busy = signal(false);
  readonly testingId = signal<string | null>(null);
  readonly testMessages = signal<Record<string, { text: string; ok: boolean }>>({});
  readonly hasModels = computed(() => this.models().length > 0);
  readonly formOpen = signal(false);

  startAdd(): void {
    this.formOpen.set(true);
    this.editingId.set(null);
    this.draft.set(emptyModelDraft());
    this.apiKey.set('');
    this.savedSecret.set(false);
    this.formError.set('');
  }

  edit(model: ModelEntry): void {
    this.formOpen.set(true);
    this.editingId.set(model.id);
    this.draft.set({
      id: model.id,
      baseUrl: model.baseUrl ?? '',
      modelName: model.modelName ?? '',
      contextLimit: model.contextLimit ?? null,
    });
    this.apiKey.set('');
    this.savedSecret.set(!!model.apiKeyRef);
    this.formError.set('');
  }

  duplicate(model: ModelEntry): void {
    this.formOpen.set(true);
    const ids = new Set(this.models().map((item) => item.id));
    let id = `${model.id}-copy`;
    let suffix = 2;
    while (ids.has(id)) id = `${model.id}-copy-${suffix++}`;
    this.editingId.set(null);
    this.draft.set({
      id,
      baseUrl: model.baseUrl ?? '',
      modelName: model.modelName ?? '',
      contextLimit: model.contextLimit ?? null,
    });
    this.apiKey.set('');
    this.savedSecret.set(false);
    this.formError.set('');
  }

  setText(key: 'id' | 'baseUrl' | 'modelName', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  setNumber(key: 'contextLimit', event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (key === 'contextLimit') {
      if (value === 0 || !Number.isFinite(value)) {
        this.draft.update((draft) => ({ ...draft, contextLimit: null }));
      } else {
        this.draft.update((draft) => ({ ...draft, contextLimit: Math.max(1, Math.floor(value)) }));
      }
    }
  }

  setApiKey(event: Event): void {
    this.apiKey.set((event.target as HTMLInputElement).value);
  }

  setDefault(event: Event): void {
    this.settings.set('models.defaultModel', (event.target as HTMLSelectElement).value);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.draft.set(emptyModelDraft());
    this.formError.set('');
    this.formOpen.set(false);
  }

  async saveModel(): Promise<void> {
    const draft = this.draft();
    const id = draft.id.trim();
    if (!id) return this.formError.set('Enter a unique model name.');
    if (this.models().some((model) => model.id === id && model.id !== this.editingId())) {
      return this.formError.set('A model with this name already exists.');
    }
    if (!draft.baseUrl.trim() || !draft.modelName.trim()) {
      return this.formError.set('Base URL and model name are required.');
    }
    if (draft.contextLimit !== null && draft.contextLimit < 1) {
      return this.formError.set('Context limit must be a positive number.');
    }

    this.busy.set(true);
    this.formError.set('');
    try {
      const old = this.models().find((model) => model.id === this.editingId());
      const nextRef = `model:${id}`;
      let apiKeyRef: string | undefined;

      if (this.apiKey()) {
        await invoke('secret_set', { id: nextRef, value: this.apiKey() });
        apiKeyRef = nextRef;
        if (old?.apiKeyRef && old.apiKeyRef !== nextRef) {
          await invoke('secret_delete', { id: old.apiKeyRef });
        }
      } else if (old?.apiKeyRef) {
        if (old.apiKeyRef !== nextRef) {
          const previousSecret = await invoke<string>('secret_get', { id: old.apiKeyRef });
          await invoke('secret_set', { id: nextRef, value: previousSecret });
          await invoke('secret_delete', { id: old.apiKeyRef });
        }
        apiKeyRef = nextRef;
      }

      const entry: ModelEntry = {
        id,
        type: 'api',
        baseUrl: draft.baseUrl.trim(),
        modelName: draft.modelName.trim(),
        ...(draft.contextLimit !== null ? { contextLimit: draft.contextLimit } : {}),
        ...(apiKeyRef ? { apiKeyRef } : {}),
      };
      const all = this.models().filter((model) => model.id !== this.editingId());
      all.push(entry);
      this.writeModels(all);
      if (!this.defaultModel() || this.defaultModel() === this.editingId()) {
        this.settings.set('models.defaultModel', id);
      }
      this.editingId.set(null);
      this.apiKey.set('');
      this.savedSecret.set(!!entry.apiKeyRef);
      this.draft.set(emptyModelDraft());
      this.formOpen.set(false);
    } catch (error) {
      this.formError.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(model: ModelEntry): Promise<void> {
    this.busy.set(true);
    try {
      if (model.apiKeyRef) await invoke('secret_delete', { id: model.apiKeyRef });
      const remaining = this.models().filter((item) => item.id !== model.id);
      this.writeModels(remaining);
      if (this.defaultModel() === model.id) {
        this.settings.set('models.defaultModel', remaining[0]?.id ?? '');
      }
    } catch (error) {
      this.formError.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  async testConnection(model: ModelEntry): Promise<void> {
    this.testingId.set(model.id);
    this.setTestMessage(model.id, 'Testing connection…', true);
    try {
      const key = model.apiKeyRef
        ? await invoke<string>('secret_get', { id: model.apiKeyRef })
        : null;
      const endpoint = completionEndpoint(model.baseUrl ?? '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = `Bearer ${key}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.modelName,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 1,
          temperature: 0,
        }),
      });
      if (!response.ok)
        throw new Error(`Request failed (${response.status} ${response.statusText}).`);
      this.setTestMessage(model.id, 'API connection succeeded.', true);
    } catch (error) {
      this.setTestMessage(model.id, errorMessage(error), false);
    } finally {
      this.testingId.set(null);
    }
  }

  private writeModels(models: ModelEntry[]): void {
    this.settings.set('models.registry', JSON.stringify(models));
  }

  private setTestMessage(id: string, text: string, ok: boolean): void {
    this.testMessages.update((messages) => ({ ...messages, [id]: { text, ok } }));
  }
}

function parseModels(raw: string): ModelEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const models: ModelEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const model = item as RawModel;
      if (typeof model.id !== 'string' || !model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      if (model.type === 'api') {
        models.push({
          id: model.id,
          type: 'api',
          ...(typeof model.contextLimit === 'number' && model.contextLimit > 0
            ? { contextLimit: model.contextLimit }
            : {}),
          ...(typeof model.provider === 'string' ? { provider: model.provider } : {}),
          ...(typeof model.baseUrl === 'string' ? { baseUrl: model.baseUrl } : {}),
          ...(typeof model.modelName === 'string' ? { modelName: model.modelName } : {}),
          ...(typeof model.apiKeyRef === 'string' ? { apiKeyRef: model.apiKeyRef } : {}),
        });
      }
    }
    return models;
  } catch {
    return [];
  }
}

interface RawModel {
  id?: unknown;
  type?: unknown;
  contextLimit?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  modelName?: unknown;
  apiKeyRef?: unknown;
}

function completionEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL must start with http:// or https://.');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
