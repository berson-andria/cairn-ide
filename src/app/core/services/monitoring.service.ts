import { Injectable, Signal, signal } from '@angular/core';

interface EditorCursorPosition {
  line: number;
  col: number;
}

interface EditorData {
  cursorPosition: EditorCursorPosition | null;
  language: string;
}

@Injectable({
  providedIn: 'root',
})
export class MonitoringService {
  readonly #editorData = signal<EditorData | null>(null);

  readonly editorData: Signal<EditorData | null> = this.#editorData.asReadonly();

  setEditorInfo(data: EditorData | null) {
    this.#editorData.set(data);
  }
  updateLanguage(language: string) {
    this.#editorData.update((data) => {
      return {
        language,
        cursorPosition: data?.cursorPosition ?? null,
      };
    });
  }
  updatePostion(line: number, col: number) {
    this.#editorData.update((data) => {
      return {
        language: <string>data?.language,
        cursorPosition: { line, col },
      };
    });
  }
  resetEditorData() {
    this.#editorData.set(null);
  }
}
