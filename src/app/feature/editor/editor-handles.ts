import type * as Monaco from 'monaco-editor';
import type { EditorExtension } from './editor-extensions';

type ViewState = Monaco.editor.IEditorViewState | null;

export interface HandleContext {
  viewStates: Map<string, ViewState>;
  getModel(id: string): Monaco.editor.ITextModel | undefined;
  /** Called by a handle when it is disposed, so the service stops tracking it. */
  release(handle: BaseEditorHandle): void;
}

export abstract class BaseEditorHandle {
  protected currentKey: string | null = null;

  protected constructor(
    protected readonly editor: Monaco.editor.IEditor,
    protected readonly ctx: HandleContext,
  ) {}

  /** The code editor that receives focus and selections (the modified side for a diff). */
  protected abstract get textEditor(): Monaco.editor.ICodeEditor;
  /** True if this editor is currently displaying `model`. */
  abstract usesModel(model: Monaco.editor.ITextModel): boolean;
  /** Detach whatever model(s) are shown so they can be disposed safely. */
  abstract detach(): void;

  layout() {
    this.editor.layout();
  }

  focus() {
    this.textEditor.focus();
  }

  reveal(range: Monaco.IRange) {
    const e = this.textEditor;
    e.setSelection(range);
    e.revealRangeInCenter(range);
    e.focus();
  }

  protected saveCurrentViewState() {
    if (this.currentKey && this.editor.getModel()) {
      this.ctx.viewStates.set(this.currentKey, this.editor.saveViewState());
    }
  }

  protected restoreViewState(key: string) {
    this.editor.restoreViewState(this.ctx.viewStates.get(key) ?? null);
  }

  /** Show nothing: remember the view state, then detach the model(s). */
  clear() {
    this.saveCurrentViewState();
    this.detach(); // a diff editor throws if a model is disposed while still attached
    this.currentKey = null;
  }

  dispose() {
    this.clear();
    this.beforeDispose();
    this.editor.dispose();
    this.ctx.release(this);
  }

  /** Hook for subclasses: runs after the model is detached, before the editor is disposed. */
  protected beforeDispose() {}
}

export class StandaloneEditorHandle extends BaseEditorHandle {
  private onCursorChange?: (position: Monaco.Position) => void;

  constructor(
    private readonly code: Monaco.editor.IStandaloneCodeEditor,
    ctx: HandleContext,
    private readonly extensions: EditorExtension[] = [],
  ) {
    super(code, ctx);
  }

  protected get textEditor() {
    return this.code;
  }

  setOnCursorChange(callback: (position: Monaco.Position) => void) {
    this.onCursorChange = callback;
  }

  /**
   * `fileId` is both the model id and the view-state key.
   * Null, or an id with no model (e.g. a diff tab is focused), shows nothing.
   */
  show(fileId: string | null) {
    const model = fileId ? this.ctx.getModel(fileId) : undefined;
    if (!fileId || !model) return this.clear();

    this.saveCurrentViewState();
    this.code.setModel(model);
    this.extensions.forEach((x) => x.attach(model));
    this.restoreViewState(fileId);
    this.currentKey = fileId;

    // Report the cursor position after the model is set
    const position = this.code.getPosition();
    if (position && this.onCursorChange) {
      this.onCursorChange(position);
    }
  }

  usesModel(model: Monaco.editor.ITextModel) {
    return this.code.getModel() === model;
  }

  detach() {
    this.code.setModel(null);
    this.extensions.forEach((x) => x.attach(null));
  }

  protected override beforeDispose() {
    this.extensions.forEach((x) => x.dispose());
  }
}

export class DiffEditorHandle extends BaseEditorHandle {
  constructor(
    private readonly diff: Monaco.editor.IStandaloneDiffEditor,
    ctx: HandleContext,
  ) {
    super(diff, ctx);
  }

  protected get textEditor() {
    return this.diff.getModifiedEditor();
  }

  /** `key` is the diff tab id, so its scroll position survives tab switches. */
  show(
    key: string,
    original: Monaco.editor.ITextModel,
    modified: Monaco.editor.ITextModel,
    modifiedEditable: boolean,
  ) {
    this.saveCurrentViewState();
    this.diff.updateOptions({ readOnly: !modifiedEditable });
    this.diff.setModel({ original, modified });
    this.restoreViewState(key);
    this.currentKey = key;
  }

  usesModel(model: Monaco.editor.ITextModel) {
    const m = this.diff.getModel();
    return m?.original === model || m?.modified === model;
  }
  goToDiff(direction: 'next' | 'previous') {
    this.diff.goToDiff(direction);
  }
  detach() {
    this.diff.setModel(null);
  }
}

export type EditorHandle = StandaloneEditorHandle | DiffEditorHandle;
