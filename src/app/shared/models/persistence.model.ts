import { WorkspaceState } from '../../core/store/workspace/workspace.state';

// persistence.models.ts
export interface IdeData {
  version: 1;
  lastOpenedFolder: string | null;
  recentFolders: string[]; // max 10, most recent first
  settings: Record<string, unknown>; // placeholder, not saved on close for now
}

export const DEFAULT_IDE_DATA: IdeData = {
  version: 1,
  lastOpenedFolder: null,
  recentFolders: [],
  settings: {},
};

// Only the serializable part of WorkspaceState
export type PersistedWorkspace = Pick<
  WorkspaceState,
  'rootPath' | 'explorerUiState' | 'activeNodeId' | 'selectionAnchorId' | 'selectedNodeIds'
> & { version: 1 };

export function toPersisted(s: WorkspaceState): PersistedWorkspace {
  return {
    version: 1,
    rootPath: s.rootPath,
    explorerUiState: s.explorerUiState,
    activeNodeId: s.activeNodeId,
    selectionAnchorId: s.selectionAnchorId,
    selectedNodeIds: s.selectedNodeIds,
  };
}
