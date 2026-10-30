import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-markdown-editor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './markdown-editor.html',
  styleUrl: './markdown-editor.scss',
})
export class MarkdownEditor {
  @Input() value = '';
  @Input() placeholder = 'Write Markdown...';
  @Input() ariaLabel = 'Markdown source';
  @Output() readonly valueChange = new EventEmitter<string>();

  onInput(value: string): void {
    this.value = value;
    this.valueChange.emit(value);
  }

  get previewHtml(): string {
    return renderMarkdown(this.value);
  }
}

/** Small, dependency-free Markdown renderer for note previews. Source HTML is escaped first. */
function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listTag) blocks.push(`<${listTag}>${list.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${listTag}>`);
    list = [];
    listTag = null;
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      flushParagraph();
      flushList();
      if (code) {
        blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
    } else if (unordered || ordered) {
      flushParagraph();
      const nextTag = unordered ? 'ul' : 'ol';
      if (listTag && listTag !== nextTag) flushList();
      listTag = nextTag;
      list.push((unordered ?? ordered)![1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }

  if (code) blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return blocks.join('');
}

function renderInline(source: string): string {
  return escapeHtml(source)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}
