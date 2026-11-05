import { DestroyRef, inject, Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { computeMinimalEdit } from '../../../core/services/file-system/external-watcher.utils';
import { EDITOR_EXTENSIONS } from '../editor-extensions';
import {
  BaseEditorHandle,
  HandleContext,
  StandaloneEditorHandle,
  DiffEditorHandle,
} from '../editor-handles';
import { enhanceBuiltInLanguages } from '../setup/monaco-enhance';
import { setupMonacoEnvironment } from '../setup/monaco-environment';
import { registerExtraLanguages } from '../setup/monaco-languages';
import { defineGhostTheme } from '../setup/monaco-theme';
import { openUrl } from '@tauri-apps/plugin-opener';

/** A file path on disk, or any URI (a Monaco Uri or plain components, e.g. for git content). */
export type ModelUri = string | Monaco.UriComponents;

export interface ModelSpec {
  id: string;
  uri: ModelUri;
  content: string;
  language: string;
  /** Only used by whoever creates the model first. Fires when the dirty state flips. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** The owner name a file tab registers on its model. Shared by the editor component and EditorCommands. */
export const fileTabOwner = (fileId: string) => `tab:${fileId}`;

export interface MountOptions {
  onCursorChange?: (position: Monaco.Position) => void;
  onSave?: () => void;
}

interface ModelEntry {
  model: Monaco.editor.ITextModel;
  /** What is on disk (or the git snapshot). */
  originalContent: string;
  savedVersionId: number;
  dirty: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** Everything currently using this model: `tab:<id>`, a diff tab id, ... */
  owners: Set<string>;
}

@Injectable({ providedIn: 'root' })
export class EditorService implements OnDestroy {
  private readonly zone = inject(NgZone);
  /** Features that decorate code editors (git blame...), provided by the app. */
  private readonly extensionFactories = inject(EDITOR_EXTENSIONS, { optional: true }) ?? [];

  // Models are live, mutable resources, not state: a plain Map, no signal.
  private readonly models = new Map<string, ModelEntry>();
  private readonly handles = new Set<BaseEditorHandle>();
  private readonly viewStates = new Map<string, Monaco.editor.IEditorViewState | null>();

  private readonly ctx: HandleContext = {
    viewStates: this.viewStates,
    getModel: (id) => this.getModel(id),
    release: (h) => this.handles.delete(h),
  };

  private monaco?: typeof Monaco;
  private loading?: Promise<typeof Monaco>;

  readonly #ready = signal(false);
  /** True once Monaco is loaded; model methods work synchronously after that. */
  readonly isReady = this.#ready.asReadonly();

  readonly #modelsVersion = signal(0);
  /** Bumps when a model is replaced under the same id (a renamed file), so editors know to show it again. */
  readonly modelsVersion = this.#modelsVersion.asReadonly();

  readonly editorOption: Monaco.editor.IStandaloneEditorConstructionOptions = {
    model: null,
    theme: 'cairn-dark',
    fontSize: 14,
    minimap: { enabled: true },
    fixedOverflowWidgets: true,
    scrollBeyondLastLine: true,
    'semanticHighlighting.enabled': true,
    wordWrap: 'off',
    automaticLayout: false,
  };

  // ───────────── loading ─────────────

  load(): Promise<typeof Monaco> {
    if (this.monaco) return Promise.resolve(this.monaco);

    this.loading ??= this.zone
      .runOutsideAngular(async () => {
        setupMonacoEnvironment();
        const monaco = await import('monaco-editor');
        await registerExtraLanguages(monaco);
        await enhanceBuiltInLanguages(monaco);
        defineGhostTheme(monaco);

        this.monaco = monaco;
        const ts = monaco.typescript;
        for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
          d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
        }

        monaco.editor.registerLinkOpener({
          async open(resource: Monaco.Uri) {
            if (
              resource.scheme === 'http' ||
              resource.scheme === 'https' ||
              resource.scheme === 'mailto'
            ) {
              await openUrl(resource.toString(true));
              return true; // handled, so Monaco won't try its own opener
            }
            return false; // let other openers handle it
          },
        });
        this.#ready.set(true);
        return monaco;
      })
      .catch((err) => {
        this.loading = undefined; // don't cache a failed load; the next call retries
        throw err;
      });

    return this.loading;
  }

  // ───────────── editors ─────────────

  mountEditor(host: HTMLElement, destroyRef: DestroyRef, opts: MountOptions = {}) {
    return this.mount(destroyRef, (monaco) => {
      const editor = monaco.editor.create(host, { ...this.editorOption, readOnly: false });

      if (opts.onCursorChange) {
        const report = () => {
          const position = editor.getPosition();
          if (position) this.zone.run(() => opts.onCursorChange!(position));
        };
        editor.onDidFocusEditorText(report);
        editor.onDidChangeCursorPosition(report);
      }
      if (opts.onSave) {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          this.zone.run(opts.onSave!),
        );
      }
      const extensions = this.extensionFactories.map((create) => create(monaco, editor));
      return new StandaloneEditorHandle(editor, this.ctx, extensions);
    });
  }

  mountDiffEditor(
    host: HTMLElement,
    destroyRef: DestroyRef,
    opts: Pick<MountOptions, 'onSave'> = {},
  ) {
    return this.mount(destroyRef, (monaco) => {
      const editor = monaco.editor.createDiffEditor(host, {
        ...this.editorOption,
        readOnly: true, // DiffEditorHandle.show() switches it per diff
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
        ignoreTrimWhitespace: false,
        renderOverviewRuler: true,
      });
      if (opts.onSave) {
        editor
          .getModifiedEditor()
          .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
            this.zone.run(opts.onSave!),
          );
      }
      return new DiffEditorHandle(editor, this.ctx);
    });
  }

  /** Waits for Monaco, bails out if the component died meanwhile, ties disposal to its DestroyRef. */
  private async mount<T extends BaseEditorHandle>(
    destroyRef: DestroyRef,
    create: (monaco: typeof Monaco) => T,
  ): Promise<T | null> {
    let destroyed = false;
    destroyRef.onDestroy(() => (destroyed = true));

    const monaco = this.monaco ?? (await this.load());
    if (destroyed) return null;

    const handle = this.zone.runOutsideAngular(() => create(monaco));
    this.handles.add(handle);
    destroyRef.onDestroy(() => handle.dispose());
    return handle;
  }

  // ───────────── models ─────────────

  /**
   * Returns the model for `spec.id`, creating it on first use, and registers `owner` as a user of it.
   * If the model already exists, `spec.content` is ignored: the live model wins.
   * Returns null only if Monaco isn't loaded yet.
   */
  acquireModel(owner: string, spec: ModelSpec): Monaco.editor.ITextModel | null {
    const existing = this.models.get(spec.id);
    if (existing) {
      existing.owners.add(owner);
      return existing.model;
    }

    const monaco = this.monaco;
    if (!monaco) return null;

    const model = monaco.editor.createModel(
      spec.content,
      spec.language,
      this.toUri(monaco, spec.uri),
    );
    const entry: ModelEntry = {
      model,
      originalContent: spec.content,
      savedVersionId: model.getAlternativeVersionId(),
      dirty: false,
      onDirtyChange: spec.onDirtyChange,
      owners: new Set([owner]),
    };
    model.onDidChangeContent(() =>
      this.setDirty(entry, model.getAlternativeVersionId() !== entry.savedVersionId),
    );

    this.models.set(spec.id, entry);
    return model;
  }

  /** Unregisters `owner`. Disposes the model only if nobody else uses it; returns true if disposed. */
  releaseModel(id: string, owner: string): boolean {
    const entry = this.models.get(id);
    if (!entry) return false;
    entry.owners.delete(owner);
    if (entry.owners.size > 0) return false;
    this.disposeEntry(id, entry);
    return true;
  }

  /** Registers `owner` on a model that already exists; null if there is none. */
  retainModel(owner: string, id: string): Monaco.editor.ITextModel | null {
    const entry = this.models.get(id);
    if (!entry) return null;
    entry.owners.add(owner);
    return entry.model;
  }

  /** Replaces the text of a read-only snapshot model (the git side of a diff) if it changed. */
  updateSnapshot(id: string, text: string) {
    const model = this.models.get(id)?.model;
    if (model && model.getValue() !== text) model.setValue(text);
  }

  modelIds(): string[] {
    return [...this.models.keys()];
  }

  /**
   * A file was renamed or moved. Monaco can't change a model's uri, so build a new model with the same text,
   * keep the owners and the dirty state, and let go of the old one.
   */
  moveModel(id: string, path: string, language: string) {
    const monaco = this.monaco;
    const entry = this.models.get(id);
    if (!monaco || !entry) return;

    const uri = monaco.Uri.file(path);
    const old = entry.model;
    if (old.uri.toString() === uri.toString()) return;

    const model = monaco.editor.createModel(old.getValue(), language, uri);
    entry.model = model;
    entry.savedVersionId = entry.dirty ? -1 : model.getAlternativeVersionId();
    model.onDidChangeContent(() =>
      this.setDirty(entry, model.getAlternativeVersionId() !== entry.savedVersionId),
    );

    this.handles.forEach((h) => h.usesModel(old) && h.detach());
    old.dispose();
    this.#modelsVersion.update((v) => v + 1);
  }

  /** Replaces the text with a minimal edit, as one undo step, so the cursor and scroll survive. */
  replaceContent(id: string, next: string) {
    const model = this.models.get(id)?.model;
    if (!model) return;
    const { start, endPrev, text } = computeMinimalEdit(model.getValue(), next);
    const a = model.getPositionAt(start);
    const b = model.getPositionAt(endPrev);
    model.pushStackElement();
    model.pushEditOperations(
      [],
      [
        {
          range: {
            startLineNumber: a.lineNumber,
            startColumn: a.column,
            endLineNumber: b.lineNumber,
            endColumn: b.column,
          },
          text,
        },
      ],
      () => null,
    );
    model.pushStackElement();
  }

  /**
   * Selects `text` on `lineNumber` in whichever editor shows the model.
   * Returns false while that editor isn't there yet (the caller retries); true once handled.
   */
  revealText(id: string, lineNumber: number, text: string): boolean {
    const model = this.models.get(id)?.model;
    const handle = model && [...this.handles].find((h) => h.usesModel(model));
    if (!model || !handle) return false;

    if (lineNumber < 1 || lineNumber > model.getLineCount()) return true;
    const index = model.getLineContent(lineNumber).indexOf(text);
    if (index === -1) {
      console.warn(`Text "${text}" not found on line ${lineNumber}`);
      return true;
    }
    handle.reveal({
      startLineNumber: lineNumber,
      startColumn: index + 1,
      endLineNumber: lineNumber,
      endColumn: index + 1 + text.length,
    });
    return true;
  }

  /** Everything currently using this model (empty if there is no model). */
  ownersOf(id: string): string[] {
    return [...(this.models.get(id)?.owners ?? [])];
  }

  /** True if `owner` is the only thing keeping this model alive. */
  isLastOwner(id: string, owner: string): boolean {
    const owners = this.models.get(id)?.owners;
    return !!owners && owners.size === 1 && owners.has(owner);
  }

  /** The file was deleted or moved: dispose regardless of who still holds it. */
  forceDispose(id: string) {
    const entry = this.models.get(id);
    if (entry) this.disposeEntry(id, entry);
  }

  getModel(id: string): Monaco.editor.ITextModel | undefined {
    return this.models.get(id)?.model;
  }

  getContent(id: string): string | undefined {
    return this.models.get(id)?.model.getValue();
  }

  hasModel(id: string): boolean {
    return this.models.has(id);
  }

  /**
   * `diskContent` is now what is on disk (after a save, or an external reload).
   * The model is clean if it matches it, dirty if it was edited in the meantime.
   */
  markSaved(id: string, diskContent: string) {
    const entry = this.models.get(id);
    if (!entry) return;
    entry.originalContent = diskContent;
    const inSync = entry.model.getValue() === diskContent;
    entry.savedVersionId = inSync ? entry.model.getAlternativeVersionId() : -1;
    this.setDirty(entry, !inSync);
  }

  /** The "Discard" choice of the save prompt: put the model back to what is on disk. */
  discardChanges(id: string) {
    const entry = this.models.get(id);
    if (!entry) return;
    entry.model.setValue(entry.originalContent);
    this.markSaved(id, entry.originalContent);
  }

  // ───────────── internals ─────────────

  private setDirty(entry: ModelEntry, dirty: boolean) {
    if (entry.dirty === dirty) return; // report flips only, not every keystroke
    entry.dirty = dirty;
    entry.onDirtyChange?.(dirty);
  }

  private disposeEntry(id: string, entry: ModelEntry) {
    // Any editor still showing the model lets go of it first.
    this.handles.forEach((h) => h.usesModel(entry.model) && h.detach());
    entry.model.dispose();
    this.models.delete(id);
    this.viewStates.delete(id);
  }

  private toUri(monaco: typeof Monaco, uri: ModelUri): Monaco.Uri {
    if (typeof uri === 'string') return monaco.Uri.file(uri);
    return uri instanceof monaco.Uri ? uri : monaco.Uri.from(uri);
  }

  ngOnDestroy() {
    this.handles.forEach((h) => h.dispose());
    this.models.forEach((e) => e.model.dispose());
    this.models.clear();
  }
}
