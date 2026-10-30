interface BaseNode {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
}

export interface FileNode extends BaseNode {
  content: string;
  extension: string;
  isDirty: boolean;
}

export interface FolderNode extends BaseNode {
  children: string[] | null;
}

export type WorkspaceNode = FileNode | FolderNode;

export type InlineCreationMode = 'none' | 'file' | 'folder';

export interface FolderUiState {
  isExpanded: boolean;
  inlineCreation: InlineCreationMode;
}

export interface WorkspaceState {
  rootPath: string | null;
  rootName: string | null;
  rootInlineCreation: InlineCreationMode;
  rootNodes: Record<string, WorkspaceNode>;
  nodes: Record<string, WorkspaceNode>;
  renamingNodeId: string | null;

  explorerUiState: Record<string, FolderUiState>;

  activeNodeId: string | null;
  selectionAnchorId: string | null;
  selectedNodeIds: string[];
  clipboard: { ids: string[]; mode: 'copy' | 'cut' } | null;

  isWorkspaceLoading: boolean;
}
