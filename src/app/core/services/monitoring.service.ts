import { Injectable, Signal, signal } from '@angular/core';

interface EditorCursorPosition {
  line: number;
  col: number;
}

interface EditorData {
  cursorPostion: EditorCursorPosition | null;
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
  updatePostion(line: number, col: number) {
    this.#editorData.update((data) => {
      return {
        language: <string>data?.language,
        cursorPostion: { line, col },
      };
    });
  }
  resetEditorData() {
    this.#editorData.set(null);
  }
}
