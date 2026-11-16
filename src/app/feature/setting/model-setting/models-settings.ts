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

  constructor() {
    const rawRegistry = this.registry();
    if (rawRegistry && rawRegistry !== JSON.stringify(this.models())) {
      this.settings.set('models.registry', JSON.stringify(this.models()));
    }
    if (!this.hasModels()) this.formOpen.set(true);
  }

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
    const defaults = emptyModelDraft();
    this.editingId.set(model.id);
    this.draft.set({
      ...defaults,
      id: model.id,
      type: model.type,
      contextLimit: model.contextLimit,
      ggufPath: model.ggufPath ?? '',
      gpuLayers: model.gpuLayers ?? defaults.gpuLayers,
      contextSize: model.contextSize ?? model.contextLimit,
      threads: model.threads ?? defaults.threads,
      temperature: model.sampling?.temperature ?? defaults.temperature,
      topP: model.sampling?.topP ?? defaults.topP,
      topK: model.sampling?.topK ?? defaults.topK,
      provider: model.provider ?? '',
      baseUrl: model.baseUrl ?? '',
      modelName: model.modelName ?? '',
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
    const duplicate = { ...model, id, apiKeyRef: undefined };
    this.editingId.set(null);
    this.draft.set(this.draftFrom(duplicate));
    this.apiKey.set('');
    this.savedSecret.set(false);
    this.formError.set('');
  }

  setType(event: Event): void {
    const type = (event.target as HTMLSelectElement).value as ModelDraft['type'];
    this.draft.update((draft) => ({ ...draft, type }));
  }

  setText(key: 'id' | 'ggufPath' | 'provider' | 'baseUrl' | 'modelName', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }

  setNumber(
    key: 'contextLimit' | 'gpuLayers' | 'contextSize' | 'threads' | 'temperature' | 'topP' | 'topK',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(value)) this.draft.update((draft) => ({ ...draft, [key]: value }));
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
    if (draft.type === 'local' && !draft.ggufPath.trim())
      return this.formError.set('Choose a GGUF model file.');
    if (
      draft.type === 'api' &&
      (!draft.provider.trim() || !draft.baseUrl.trim() || !draft.modelName.trim())
    ) {
      return this.formError.set('Provider, base URL, and model name are required.');
    }
    if (
      draft.contextLimit < 1 ||
      draft.contextSize < 1 ||
      draft.threads < 1 ||
      draft.gpuLayers < 0
    ) {
      return this.formError.set(
        'Context sizes and thread count must be positive; GPU layers cannot be negative.',
      );
    }

    this.busy.set(true);
    this.formError.set('');
    try {
      const old = this.models().find((model) => model.id === this.editingId());
      const nextRef = draft.type === 'api' ? `model:${id}` : undefined;
      let apiKeyRef = nextRef;

      if (draft.type === 'api' && this.apiKey()) {
        await invoke('secret_set', { id: nextRef, value: this.apiKey() });
        if (old?.apiKeyRef && old.apiKeyRef !== nextRef)
          await invoke('secret_delete', { id: old.apiKeyRef });
      } else if (old?.apiKeyRef && draft.type === 'api') {
        apiKeyRef = old.apiKeyRef;
        if (old.apiKeyRef !== nextRef) {
          const previousSecret = await invoke<string>('secret_get', { id: old.apiKeyRef });
          await invoke('secret_set', { id: nextRef, value: previousSecret });
          await invoke('secret_delete', { id: old.apiKeyRef });
          apiKeyRef = nextRef;
        }
      } else if (old?.apiKeyRef) {
        await invoke('secret_delete', { id: old.apiKeyRef });
      }

      const entry: ModelEntry =
        draft.type === 'local'
          ? {
              id,
              type: 'local',
              contextLimit: draft.contextLimit,
              ggufPath: draft.ggufPath.trim(),
              gpuLayers: draft.gpuLayers,
              contextSize: draft.contextSize,
              threads: draft.threads,
              sampling: { temperature: draft.temperature, topP: draft.topP, topK: draft.topK },
            }
          : {
              id,
              type: 'api',
              contextLimit: draft.contextLimit,
              provider: draft.provider.trim(),
              baseUrl: draft.baseUrl.trim(),
              modelName: draft.modelName.trim(),
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
      if (!remaining.length) this.formOpen.set(true);
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
      let message: string;
      if (model.type === 'local') {
        message = await invoke<string>('model_test_local', {
          ggufPath: model.ggufPath ?? '',
          gpuLayers: model.gpuLayers ?? 0,
          contextSize: model.contextSize ?? model.contextLimit,
          threads: model.threads ?? 1,
        });
      } else {
        if (!model.apiKeyRef)
          throw new Error('Save an API key in the OS keychain before testing this model.');
        const key = await invoke<string>('secret_get', { id: model.apiKeyRef });
        const endpoint = completionEndpoint(model.baseUrl ?? '');
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: model.modelName,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            max_tokens: 1,
            temperature: 0,
          }),
        });
        if (!response.ok)
          throw new Error(`Request failed (${response.status} ${response.statusText}).`);
        message = 'API connection succeeded.';
      }
      this.setTestMessage(model.id, message, true);
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

  private draftFrom(model: ModelEntry): ModelDraft {
    const base = emptyModelDraft();
    return {
      ...base,
      id: model.id,
      type: model.type,
      contextLimit: model.contextLimit,
      ggufPath: model.ggufPath ?? '',
      gpuLayers: model.gpuLayers ?? 0,
      contextSize: model.contextSize ?? model.contextLimit,
      threads: model.threads ?? base.threads,
      temperature: model.sampling?.temperature ?? base.temperature,
      topP: model.sampling?.topP ?? base.topP,
      topK: model.sampling?.topK ?? base.topK,
      provider: model.provider ?? '',
      baseUrl: model.baseUrl ?? '',
      modelName: model.modelName ?? '',
    };
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
      const contextLimit = positive(model.contextLimit, 4096);
      if (model.type === 'local') {
        const sampling = model.sampling && typeof model.sampling === 'object' ? model.sampling : {};
        models.push({
          id: model.id,
          type: 'local',
          contextLimit,
          ggufPath: typeof model.ggufPath === 'string' ? model.ggufPath : '',
          gpuLayers: nonnegative(model.gpuLayers, 0),
          contextSize: positive(model.contextSize, contextLimit),
          threads: positive(model.threads, 4),
          sampling: {
            temperature: finite(sampling.temperature, 0.7),
            topP: finite(sampling.topP, 0.95),
            topK: positive(sampling.topK, 40),
          },
        });
      } else if (model.type === 'api') {
        models.push({
          id: model.id,
          type: 'api',
          contextLimit,
          provider: typeof model.provider === 'string' ? model.provider : '',
          baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : '',
          modelName: typeof model.modelName === 'string' ? model.modelName : '',
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
  ggufPath?: unknown;
  gpuLayers?: unknown;
  contextSize?: unknown;
  threads?: unknown;
  sampling?: { temperature?: unknown; topP?: unknown; topK?: unknown } | null;
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

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonnegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
