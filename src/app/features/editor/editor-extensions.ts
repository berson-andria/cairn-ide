import { InjectionToken } from '@angular/core';
import type * as Monaco from 'monaco-editor';

/**
 * Something that decorates a code editor (git blame, ...). One instance per editor: EditorService creates it when
 * it mounts the editor, the editor handle tells it which model is shown, and disposes it with the editor.
 */
export interface EditorExtension {
  /** A different model is shown now, or null for none. */
  attach(model: Monaco.editor.ITextModel | null): void;
  dispose(): void;
}

export type EditorExtensionFactory = (
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
) => EditorExtension;

/**
 * Provide factories with `multi: true` (see provideGitBlame). EditorService applies them to every standalone
 * editor it mounts, so it needs no knowledge of git or anything else.
 */
export const EDITOR_EXTENSIONS = new InjectionToken<EditorExtensionFactory[]>('EDITOR_EXTENSIONS');
