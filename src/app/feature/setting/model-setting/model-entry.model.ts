export interface ModelEntry {
  id: string;
  type: 'local' | 'api';
  contextLimit: number;
  ggufPath?: string;
  gpuLayers?: number;
  contextSize?: number;
  threads?: number;
  sampling?: {
    temperature: number;
    topP: number;
    topK: number;
  };
  provider?: string;
  baseUrl?: string;
  modelName?: string;
  apiKeyRef?: string;
}

export interface ModelDraft {
  id: string;
  type: 'local' | 'api';
  contextLimit: number;
  ggufPath: string;
  gpuLayers: number;
  contextSize: number;
  threads: number;
  temperature: number;
  topP: number;
  topK: number;
  provider: string;
  baseUrl: string;
  modelName: string;
}

export function emptyModelDraft(): ModelDraft {
  return {
    id: '',
    type: 'local',
    contextLimit: 4096,
    ggufPath: '',
    gpuLayers: 0,
    contextSize: 4096,
    threads: 4,
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    provider: '',
    baseUrl: '',
    modelName: '',
  };
}
