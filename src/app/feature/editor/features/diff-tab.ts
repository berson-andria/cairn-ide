/** What one side of a diff shows. Paths are ABSOLUTE: what the explorer and the editor use. */
export type DiffSide =
  | { kind: 'empty'; path: string }
  | { kind: 'worktree'; fileId: string; path: string } // the real file: shares the live model of its tab (editable)
  | { kind: 'index'; path: string } // staged version
  | { kind: 'head'; path: string } // last commit
  | { kind: 'commit'; rev: string; path: string }; // a hash, or `${hash}^` for its parent

export type GitSide = Exclude<DiffSide, { kind: 'worktree' }>;

export interface DiffRequest {
  original: DiffSide;
  modified: DiffSide;
}

/** An open diff. The request is all it needs: DiffSourceService loads the content when the tab is shown. */
export interface DiffTab {
  id: string;
  title: string;
  request: DiffRequest;
}

/**
 * The id of the model behind a side. A worktree side uses the file id, so it is the SAME model the
 * file's own tab uses. Git sides are keyed by what they show, so two diffs that share a side share its model.
 */
export const sideModelId = (side: DiffSide): string =>
  side.kind === 'worktree'
    ? side.fileId
    : side.kind === 'commit'
      ? `git:${side.rev}:${side.path}`
      : `git:${side.kind}:${side.path}`;

/** Deterministic, so opening the same diff twice focuses the tab that is already open. */
export const diffTabId = (r: DiffRequest): string =>
  `diff:${sideModelId(r.original)}|${sideModelId(r.modified)}`;

const sideLabel = (side: DiffSide): string => {
  switch (side.kind) {
    case 'worktree':
      return 'Working Tree';
    case 'index':
      return 'Index';
    case 'head':
      return 'HEAD';
    case 'commit':
      return side.rev.replace(/\^$/, '').slice(0, 7) + (side.rev.endsWith('^') ? '^' : '');
    case 'empty':
      return 'Deleted';
  }
};
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export interface DiffRequest {
  original: DiffSide;
  modified: DiffSide;
}

/** A side as a component writes it: a working file is named by its path, its id is looked up when the diff opens. */
export type DiffSideInput = GitSide | { kind: 'worktree'; path: string };

/** What a component passes to GitDiffService.open(). */
export interface DiffRequestInput {
  original: DiffSideInput;
  modified: DiffSideInput;
}

/** An open diff. The request is all it needs: DiffSourceService loads the content when the tab is shown. */
export interface DiffTab {
  id: string;
  title: string;
  request: DiffRequest;
}

export const diffTitle = (r: DiffRequest): string => {
  const name = r.modified.path.split(/[\\/]/).pop() ?? r.modified.path;
  return `${name} (${sideLabel(r.original)} ↔ ${sideLabel(r.modified)})`;
};

// Keep your existing isDiffTabId. It still works if it checks the `diff:` prefix.
