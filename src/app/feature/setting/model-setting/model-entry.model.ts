export interface ModelEntry {
  id: string;
  type: 'api';
  contextLimit?: number;
  provider?: string;
  baseUrl?: string;
  modelName?: string;
  apiKeyRef?: string;
}

export interface ModelDraft {
  id: string;
  baseUrl: string;
  modelName: string;
  contextLimit: number | null;
}

export function emptyModelDraft(): ModelDraft {
  return {
    id: '',
    baseUrl: '',
    modelName: '',
    contextLimit: null,
  };
}
