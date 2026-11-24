import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
// Use the same Monaco import style as the rest of the editor code.
import * as monaco from 'monaco-editor';
import { SANITIZE_CONFIG, createMarkdown, fenced, renderBlocks } from './markdown-render';

function resolveLanguage(tag: string): string | null {
  const t = tag.toLowerCase();
  if (!t) return null;
  const hit = monaco.languages
    .getLanguages()
    .find(
      (l) =>
        l.id === t ||
        l.aliases?.some((a) => a.toLowerCase() === t) ||
        l.extensions?.includes('.' + t),
    );
  return hit?.id ?? null;
}

@Component({
  selector: 'markdown-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrl: './markdown-view.scss',
  template: `
    <div class="md" [class.md-compact]="compact()" (click)="onClick($event)">
      @for (block of blocks(); track $index) {
        <div class="md-block" [innerHTML]="block"></div>
      }
    </div>
  `,
})
export class MarkdownView {
  readonly source = input.required<string>();
  readonly streaming = input(false);
  readonly compact = input(false);
  /**
   * When set, `source` is treated as code and wrapped in a fence of this
   * language (e.g. 'python'). Leave unset for normal markdown.
   */
  readonly codeLanguage = input<string | null>(null);
  /** Emits the raw href. The host decides what to do (external opener, node/tab logic). */
  readonly linkClicked = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly md = createMarkdown();

  // Same string -> same SafeHtml object, so unchanged blocks never touch the DOM.
  private safeCache = new Map<string, SafeHtml>();
  private readonly throttled = signal('');
  private framePending = false;

  protected readonly blocks = computed<SafeHtml[]>(() => {
    const raw = this.streaming() ? this.throttled() : this.source();
    const lang = this.codeLanguage();
    const text = lang === null ? raw : fenced(raw, lang);
    const next = new Map<string, SafeHtml>();
    const result = renderBlocks(this.md, text).map((html) => {
      let safe = next.get(html) ?? this.safeCache.get(html);
      if (!safe) {
        safe = this.sanitizer.bypassSecurityTrustHtml(
          String(DOMPurify.sanitize(html, SANITIZE_CONFIG)),
        );
      }
      next.set(html, safe);
      return safe;
    });
    this.safeCache = next;
    return result;
  });

  constructor() {
    // Streaming: coalesce chunks into one render per animation frame.
    effect(() => {
      const text = this.source();
      if (!this.streaming() || this.framePending) return;
      this.framePending = true;
      requestAnimationFrame(() => {
        this.framePending = false;
        this.throttled.set(untracked(() => this.source()));
      });
      void text;
    });

    // Colorize closed code blocks once the message is complete.
    effect(() => {
      this.blocks();
      if (this.streaming()) return;
      untracked(() => setTimeout(() => void this.highlight(), 0));
    });
  }

  protected onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    const copy = target?.closest<HTMLElement>('.md-copy');
    if (copy) {
      this.copyCode(copy);
      return;
    }
    const anchor = target?.closest<HTMLAnchorElement>('a[href]');
    if (anchor) {
      ev.preventDefault();
      this.linkClicked.emit(anchor.getAttribute('href') ?? '');
    }
  }

  private copyCode(button: HTMLElement): void {
    const codeEl = button.closest('.md-code')?.querySelector<HTMLElement>('code');
    // Monaco's colorized HTML separates lines with <br>, so prefer the saved original.
    const code = codeEl?.dataset['raw'] ?? codeEl?.textContent ?? '';
    navigator.clipboard
      .writeText(code)
      .then(() => {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      })
      .catch(() => {
        button.textContent = 'Copy failed';
        setTimeout(() => (button.textContent = 'Copy'), 1500);
      });
  }

  private async highlight(): Promise<void> {
    const codes = this.host.nativeElement.querySelectorAll<HTMLElement>(
      'code[data-lang]:not([data-done])',
    );
    for (const el of Array.from(codes)) {
      el.setAttribute('data-done', '');
      const lang = resolveLanguage(el.dataset['lang'] ?? '');
      if (!lang) continue;
      const raw = el.textContent ?? '';
      el.dataset['raw'] = raw;
      try {
        el.innerHTML = await monaco.editor.colorize(raw, lang, { tabSize: 4 });
      } catch {
        /* leave plain text */
      }
    }
  }
}
