import { effect, EffectRef, Injector, untracked } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { GitBlameService } from '../services/git-blame.service';
import { describeBlameLine, hoverMarkdown } from './git-blame.utils';
import { FileBlame } from '../parser/git-parsers';
import { EditorExtension } from '../../editor/editor-extensions';

let hoverRegistered = false;

/**
 * Shows "Author, 3 months ago • subject" after the line the cursor is on, with the full commit details on hover.
 * An editor extension: EditorService creates one per code editor (see provideGitBlame), the editor handle calls
 * `attach` whenever the editor shows another model, and disposes it with the editor. Nothing else touches it.
 *
 * Blame is taken from the editor's CURRENT text, a moment after typing stops, so it follows unsaved edits. In
 * between, a line that no longer matches what git saw says "Unsaved change" instead of a wrong author.
 */
export class BlameController implements EditorExtension {
  private readonly decorations: Monaco.editor.IEditorDecorationsCollection;
  private readonly listeners: Monaco.IDisposable[] = [];
  private readonly effects: EffectRef[] = [];
  private model: Monaco.editor.ITextModel | null = null;
  private blame: FileBlame | null = null;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private blameTimer?: ReturnType<typeof setTimeout>;
  private request = 0;
  /** How long to wait after typing before blaming again. Grows if git is slow on this file. */
  private delay = 800;

  constructor(
    private readonly monaco: typeof Monaco,
    private readonly editor: Monaco.editor.IStandaloneCodeEditor,
    private readonly service: GitBlameService,
    injector: Injector,
  ) {
    this.decorations = editor.createDecorationsCollection();
    this.listeners.push(
      editor.onDidChangeCursorPosition(() => this.scheduleRender()),
      editor.onDidChangeModelContent(() => {
        this.scheduleRender();
        this.scheduleBlame();
      }),
    );
    this.registerHover();

    // Blame is switched on or off: show or clear it right away.
    this.effects.push(
      effect(
        () => {
          service.enabled();
          untracked(() => void this.refresh());
        },
        { injector },
      ),
    );

    // The repository changed (commit, pull, checkout...): what is on screen may be outdated. Same delay as typing.
    let seen = service.repoVersion();
    this.effects.push(
      effect(
        () => {
          const version = service.repoVersion();
          untracked(() => {
            if (version === seen) return; // the effect's first run
            seen = version;
            this.scheduleBlame();
          });
        },
        { injector },
      ),
    );
  }

  /** A different model is now shown (or none). */
  attach(model: Monaco.editor.ITextModel | null): void {
    if (model === this.model) return;
    this.service.forget(this.model);
    this.model = model;
    this.blame = null;
    this.decorations.clear();
    if (model) void this.refresh();
  }

  /** Blame the current model now. */
  private async refresh(): Promise<void> {
    const model = this.model;
    if (!model || !this.service.enabled() || !this.service.isEligible(model)) {
      this.blame = null;
      this.decorations.clear();
      return;
    }
    const id = ++this.request;
    let result;
    try {
      result = await this.service.blame(model);
    } catch (err) {
      return;
    }
    const { blame, ms } = result;
    if (id !== this.request || model !== this.model) return; // a newer request, or another file, took over

    this.delay = ms > 2000 ? 5000 : 800;
    this.blame = blame;
    this.render();
  }

  dispose(): void {
    clearTimeout(this.renderTimer);
    clearTimeout(this.blameTimer);
    this.effects.forEach((e) => e.destroy());
    this.listeners.forEach((l) => l.dispose());
    this.decorations.clear();
    this.service.forget(this.model);
    this.model = null;
  }

  // ───────────── drawing ─────────────

  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 30);
  }

  private scheduleBlame(): void {
    clearTimeout(this.blameTimer);
    if (!this.service.enabled()) return;
    this.blameTimer = setTimeout(() => void this.refresh(), this.delay);
  }

  private render(): void {
    const model = this.model;
    const position = this.editor.getPosition();

    if (!model || !position || !this.blame || !this.service.enabled()) {
      this.decorations.clear();
      return;
    }

    const line = position.lineNumber;
    const entry = this.blame.lines[line - 1];
    let note = describeBlameLine(
      entry,
      entry && this.blame.commits.get(entry.hash),
      model.getLineContent(line),
    );
    if (!note) {
      this.decorations.clear();
      return;
    }
    note = note.substring(0, 71) + '...';
    const column = model.getLineMaxColumn(line);

    this.decorations.set([
      {
        range: new this.monaco.Range(line, column, line, column),
        options: {
          after: {
            content: `\u00a0\u00a0\u00a0\u00a0${note}`,
            inlineClassName: 'git-blame-inline',
          },
          showIfCollapsed: true,
        },
      },
    ]);
  }

  /** Hovering the end of a line shows the commit. Registered once for the whole page. */
  private registerHover(): void {
    if (hoverRegistered) return;
    hoverRegistered = true;
    this.monaco.languages.registerHoverProvider('*', {
      provideHover: (model, position) => {
        if (!this.service.enabled()) return null;
        const blame = this.service.peek(model);
        if (!blame) return null;
        // The annotation sits after the last character: only hovering there (not the code) shows details.
        if (position.column < model.getLineMaxColumn(position.lineNumber)) return null;

        const entry = blame.lines[position.lineNumber - 1];
        const commit = entry && blame.commits.get(entry.hash);
        if (!entry || !commit || entry.text !== model.getLineContent(position.lineNumber))
          return null;
        return { contents: [{ value: hoverMarkdown(commit) }] };
      },
    });
  }
}
