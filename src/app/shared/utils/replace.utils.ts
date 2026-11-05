export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

export interface CompiledPattern {
  /** Global regex, or null when the query is empty or can't be used for replacing. */
  re: RegExp | null;
  /** Why `re` is null, when the user typed something we can't use. */
  error: string | null;
}

/**
 * The search itself runs in Rust; replacing runs here, with JS regex semantics. A pattern that only
 * Rust understands (for example "(?i)foo") is rejected instead of being half-applied.
 */
export interface PatternOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export function compilePattern(query: string, options?: PatternOptions): CompiledPattern {
  if (!query) return { re: null, error: null };
  try {
    let source = query;
    if (options?.wholeWord) {
      source = `\\b(?:${source})\\b`;
    }
    const flags = options?.caseSensitive ? 'g' : 'gi';
    const testFlags = options?.caseSensitive ? '' : 'i';
    // "x*", "^" and friends match everywhere; a replace with them would rewrite every line.
    if (new RegExp(source, testFlags).test('')) {
      return {
        re: null,
        error: 'This pattern also matches empty text, so replacing with it is disabled.',
      };
    }
    return { re: new RegExp(source, flags), error: null };
  } catch (e) {
    return { re: null, error: `Replace can't use this pattern: ${(e as Error).message}` };
  }
}

/** Same regex without the `g` flag, safe for repeated `.test()` (a global regex remembers lastIndex). */
export const nonGlobal = (re: RegExp): RegExp => new RegExp(re.source, re.flags.replace('g', ''));

export function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

/**
 * What `$1`, `$&`, `$<name>` ... expand to for ONE match, in context.
 * Rather than re-implementing the expansion rules, let the engine do it: a sticky regex pinned to
 * the match start replaces only that match, and the inserted text is cut out of the result.
 * This is the same machinery that applies the real replacement, so preview and result agree.
 */
function expandedReplacement(
  line: string,
  match: RegExpMatchArray,
  re: RegExp,
  replacement: string,
): string {
  const start = match.index as number;
  const end = start + match[0].length;
  const pinned = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  pinned.lastIndex = start;
  const replaced = line.replace(pinned, replacement);
  return replaced.slice(start, replaced.length - (line.length - end));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The regex used to highlight what a search found. The search runs the query as a regex, so this does too;
 * when the query isn't valid JS regex (or would match empty text) it falls back to a literal match.
 */
export function highlightRegex(query: string, options?: PatternOptions): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const compiled = compilePattern(q, options);
  if (compiled.re) return compiled.re;
  let source = escapeRegExp(q);
  if (options?.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  const flags = options?.caseSensitive ? 'g' : 'gi';
  return new RegExp(source, flags);
}

/** Beginning of a line that has no match to show: escaped and cut to a readable length. */
function plainLine(line: string, context: number): string {
  return escapeHtml(line.length > 2 * context ? line.slice(0, 2 * context) + '…' : line);
}

/**
 * The text around the matches, `context` characters on each side, with every match rendered by
 * `renderMatch`. All text outside the matches is HTML-escaped HERE, so no caller can forget to do it.
 */
function renderWindowed(
  line: string,
  matches: RegExpMatchArray[],
  context: number,
  renderMatch: (m: RegExpMatchArray) => string,
): string {
  const first = matches[0].index as number;
  const lastMatch = matches[matches.length - 1];
  const lastEnd = (lastMatch.index as number) + lastMatch[0].length;
  const from = Math.max(0, first - context);
  const to = Math.min(line.length, lastEnd + context);

  let html = from > 0 ? '…' : '';
  let pos = from;
  for (const m of matches) {
    const start = m.index as number;
    html += escapeHtml(line.slice(pos, start)) + renderMatch(m);
    pos = start + m[0].length;
  }
  html += escapeHtml(line.slice(pos, to));
  return to < line.length ? html + '…' : html;
}

/**
 * HTML for one result line in normal mode: the matches wrapped in <mark>, the rest escaped.
 * Replaces the `textWindow | highlight` chain, which handed raw file text to innerHTML.
 */
export function buildSearchSnippet(
  text: string,
  query: string | RegExp,
  context = 40,
  maxMatches = 20,
): string {
  const line = text.replace(/\r?\n$/, '');
  const re = query instanceof RegExp ? (query.global ? query : new RegExp(query.source, query.flags + 'g')) : highlightRegex(query);
  const matches = re ? [...line.matchAll(re)].slice(0, maxMatches) : [];
  if (!matches.length) return plainLine(line, context);
  return renderWindowed(
    line,
    matches,
    context,
    (m) => `<mark class="custom-highlight">${escapeHtml(m[0])}</mark>`,
  );
}

/**
 * HTML for one result line in replace mode: each match shown as <del>old</del><ins>new</ins>.
 */
export function buildReplacePreview(
  text: string,
  re: RegExp,
  replacement: string,
  context = 40,
  maxMatches = 20,
): string {
  const line = text.replace(/\r?\n$/, '');
  const matches = [...line.matchAll(re)].slice(0, maxMatches);
  if (!matches.length) return plainLine(line, context);
  return renderWindowed(
    line,
    matches,
    context,
    (m) =>
      `<del>${escapeHtml(m[0])}</del><ins>${escapeHtml(expandedReplacement(line, m, re, replacement))}</ins>`,
  );
}
