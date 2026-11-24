import MarkdownIt from 'markdown-it';

/** Instance type that works whichever @types/markdown-it version is installed. */
export type Md = InstanceType<typeof MarkdownIt>;

/**
 * Pure markdown -> HTML-string rendering. No Angular, no DOM, no Monaco.
 * Raw HTML in the source is disabled; the output is still sanitized by the
 * component (DOMPurify) before it is bound.
 */

/** DOMPurify settings for the HTML this renderer can produce, nothing more. */
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'em',
    'strong',
    'del',
    's',
    'a',
    'span',
    'div',
    'button',
    'input',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  ALLOWED_ATTR: [
    'href',
    'class',
    'rel',
    'type',
    'checked',
    'disabled',
    'data-lang',
    'aria-label',
    'title',
    'start',
    'style',
  ],
  ALLOW_DATA_ATTR: false,
};

/** Read-only checkboxes for `- [ ]` / `- [x]` items. */
function taskLists(md: Md): void {
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const t = state.tokens;
    for (let i = 2; i < t.length; i++) {
      if (
        t[i].type !== 'inline' ||
        t[i - 1].type !== 'paragraph_open' ||
        t[i - 2].type !== 'list_item_open'
      ) {
        continue;
      }
      const first = t[i].children?.[0];
      const m = first && first.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
      if (!first || !m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input class="md-task" type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
      t[i].children!.unshift(box);
      t[i - 2].attrJoin('class', 'md-task-item');
    }
  });
}

export function createMarkdown(): Md {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  md.use(taskLists);

  // Links: always inert in the DOM; the component intercepts the click.
  const linkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return linkOpen(tokens, idx, options, env, self);
  };

  // Images are never loaded (remote fetches can leak data and hit the CSP).
  md.renderer.rules.image = (tokens, idx) => {
    const alt = md.utils.escapeHtml(tokens[idx].content);
    return `<span class="md-image" title="Images are not loaded">[image${alt ? ': ' + alt : ''}]</span>`;
  };

  // Fenced code: plain text here; the component colorizes closed fences later.
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = (t.info.trim().split(/\s+/)[0] ?? '').replace(/[^\w+#.-]/g, '');
    const code = md.utils.escapeHtml(t.content);
    return (
      `<div class="md-code"><div class="md-code-bar"><span>${lang}</span>` +
      `<button type="button" class="md-copy" aria-label="Copy code">Copy</button></div>` +
      `<pre><code data-lang="${lang}">${code}</code></pre></div>`
    );
  };

  // Wide tables scroll inside their own box.
  md.renderer.rules.table_open = () => '<div class="md-table"><table>';
  md.renderer.rules.table_close = () => '</table></div>';

  return md;
}

/**
 * Renders each top-level block separately. While a message streams, earlier
 * blocks produce identical strings, so the view can leave their DOM alone and
 * only update the last block.
 */
export function renderBlocks(md: Md, src: string): string[] {
  const env = {};
  const tokens = md.parse(src, env);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    if (tokens[i].nesting === 1) {
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        depth += tokens[i].nesting;
        i++;
      }
    } else {
      i++;
    }
    out.push(md.renderer.render(tokens.slice(start, i), md.options, env));
  }
  return out;
}

/** Wraps code in a fence long enough to survive backticks inside the code. */
export function fenced(code: string, lang = ''): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}`;
}
