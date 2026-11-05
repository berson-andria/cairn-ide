import type * as Monaco from 'monaco-editor';

/**
 * VERSION 2: everything matched to the Cairn tokens.
 *
 *  - Background, default text, comments, line numbers, selection, line highlight, widgets, borders,
 *    scrollbars, diff and gutter colors are all read from token.scss (so they follow light/dark).
 *  - Syntax hues (keyword, string, function, type...) stay One Dark / One Light. Only the neutral
 *    syntax colors (default text, delimiters, comments) are pulled from the tokens.
 *
 * Monaco themes are static hex objects: they cannot use CSS variables. So the theme is rebuilt from the
 * current computed token values and re-applied whenever <html data-theme> changes.
 */

type Mode = 'dark' | 'light';

const getMode = (): Mode =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

export const cairnThemeName = (mode: Mode = getMode()): string => `cairn-${mode}`;

/** Fallbacks = the values in token.scss, used only if a variable can't be read. */
const FALLBACKS: Record<Mode, Record<string, string>> = {
  dark: {
    '--color-surface-base': '#1c1a17',
    '--color-surface-panel': '#211e1a',
    '--color-surface-raised': '#2a2620',
    '--color-surface-hover': '#2e2a24',
    '--color-surface-raised-hover': '#3a352d',
    '--color-surface-annotation': '#24211b',
    '--color-divider': '#2e2a24',
    '--color-border': '#3a352d',
    '--color-border-strong': '#4a443a',
    '--color-text-primary': '#e8e2d6',
    '--color-text-secondary': '#c9c1b0',
    '--color-text-muted': '#a39b8b',
    '--color-text-faint': '#7f7868',
    '--color-text-prose': '#d8d0c0',
    '--color-text-code-comment': '#8a8374',
    '--color-attention': '#e2a93b',
    '--color-status-running': '#7fb0d9',
    '--color-status-done': '#6f8f6b',
    '--color-status-blocked': '#d49a8a',
    '--color-added-bg': '#1f2a1e',
    '--color-added-fg': '#b9d2ae',
    '--color-removed-bg': '#2e1d1b',
    '--color-removed-fg': '#e0b0a6',
    '--color-warning-fg': '#e2c27b',
  },
  light: {
    '--color-surface-base': '#fbf8f2',
    '--color-surface-panel': '#f3efe6',
    '--color-surface-raised': '#ece6d8',
    '--color-surface-hover': '#e4decf',
    '--color-surface-raised-hover': '#d9d2c1',
    '--color-surface-annotation': '#f0ebdf',
    '--color-divider': '#e4decf',
    '--color-border': '#d9d2c1',
    '--color-border-strong': '#c4bca8',
    '--color-text-primary': '#2a2620',
    '--color-text-secondary': '#4a443a',
    '--color-text-muted': '#6e6657',
    '--color-text-faint': '#8a8372',
    '--color-text-prose': '#3a352d',
    '--color-text-code-comment': '#7a7362',
    '--color-attention': '#9a610a',
    '--color-status-running': '#2f73a8',
    '--color-status-done': '#4e7a4a',
    '--color-status-blocked': '#a5533e',
    '--color-added-bg': '#e3f0dd',
    '--color-added-fg': '#2f5e2a',
    '--color-removed-bg': '#f8e1dc',
    '--color-removed-fg': '#8f3a2b',
    '--color-warning-fg': '#7a5a0c',
  },
};

/** Reads every token once, for the current mode. */
function readTokens(mode: Mode): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(FALLBACKS[mode])) {
    out[name] = cs.getPropertyValue(name).trim() || fallback;
  }
  return out;
}

/** '#rrggbb' + 0..1 alpha -> '#rrggbbaa' */
const alpha = (hex: string, a: number): string =>
  hex.slice(0, 7) +
  Math.round(Math.min(Math.max(a, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');

const bare = (hex: string): string => hex.replace('#', '');

interface SyntaxPalette {
  keyword: string;
  string: string;
  escape: string; // also operator / predefined / enumMember
  number: string; // also constant / macro / attribute.name
  red: string; // identifiers, tags, properties
  yellow: string; // types, classes, decorators
  blue: string; // functions
  invalid: string;
}

const HUES: Record<Mode, SyntaxPalette> = {
  dark: {
    keyword: 'c678dd',
    string: '98c379',
    escape: '56b6c2',
    number: 'd7a97f',
    red: 'e06c75',
    yellow: 'e5c07b',
    blue: '61afef',
    invalid: 'ff616e',
  },
  light: {
    keyword: 'a626a4',
    string: '50a14f',
    escape: '0184bc',
    number: '986801',
    red: 'e45649',
    yellow: 'c18401',
    blue: '4078f2',
    invalid: 'e45649',
  },
};

function buildRules(mode: Mode, t: Record<string, string>): Monaco.editor.ITokenThemeRule[] {
  const p = HUES[mode];
  const fg = bare(t['--color-text-prose']);
  const comment = bare(t['--color-text-code-comment']);
  return [
    { token: '', foreground: fg },
    { token: 'comment', foreground: comment },
    { token: 'keyword', foreground: p.keyword },
    { token: 'string', foreground: p.string },
    { token: 'string.escape', foreground: p.escape },
    { token: 'number', foreground: p.number },
    { token: 'regexp', foreground: p.red },
    { token: 'operator', foreground: p.escape },
    { token: 'delimiter', foreground: fg },
    { token: 'predefined', foreground: p.escape },
    { token: 'constant', foreground: p.number },
    { token: 'annotation', foreground: p.yellow },
    { token: 'invalid', foreground: p.invalid },
    { token: 'identifier', foreground: p.red },
    { token: 'type.identifier', foreground: p.yellow },
    { token: 'key', foreground: p.red },
    { token: 'type.yaml', foreground: p.red },
    { token: 'tag', foreground: p.red },
    { token: 'metatag', foreground: p.red },
    { token: 'attribute.name', foreground: p.number },
    { token: 'attribute.value', foreground: p.string },
    { token: 'string.key.json', foreground: p.red },
    { token: 'string.value.json', foreground: p.string },
    { token: 'strong', foreground: p.number, fontStyle: 'bold' },
    { token: 'emphasis', foreground: p.keyword, fontStyle: 'italic' },
    { token: 'string.link', foreground: p.keyword },
    { token: 'variable.source', foreground: p.string },
    { token: 'namespace', foreground: p.yellow },
    { token: 'type', foreground: p.yellow },
    { token: 'class', foreground: p.yellow },
    { token: 'struct', foreground: p.yellow },
    { token: 'enum', foreground: p.yellow },
    { token: 'interface', foreground: p.yellow },
    { token: 'typeParameter', foreground: p.yellow },
    { token: 'function', foreground: p.blue },
    { token: 'method', foreground: p.blue },
    { token: 'macro', foreground: p.number },
    { token: 'decorator', foreground: p.yellow },
    { token: 'variable', foreground: p.red },
    { token: 'variable.constant', foreground: p.number },
    { token: 'variable.defaultLibrary', foreground: p.yellow },
    { token: 'parameter', foreground: p.red },
    { token: 'property', foreground: p.red },
    { token: 'enumMember', foreground: p.escape },
    { token: 'event', foreground: p.red },
    { token: 'modifier', foreground: p.keyword },
    { token: 'memberOperatorOverload', foreground: p.keyword },
  ];
}

function buildColors(mode: Mode, t: Record<string, string>): Monaco.editor.IColors {
  const hue = HUES[mode];
  const base = t['--color-surface-base'];
  const panel = t['--color-surface-panel'];
  const raised = t['--color-surface-raised'];
  const raisedHover = t['--color-surface-raised-hover'];
  const hover = t['--color-surface-hover'];
  const annotation = t['--color-surface-annotation'];
  const divider = t['--color-divider'];
  const border = t['--color-border'];
  const borderStrong = t['--color-border-strong'];
  const textPrimary = t['--color-text-primary'];
  const textSecondary = t['--color-text-secondary'];
  const textMuted = t['--color-text-muted'];
  const textFaint = t['--color-text-faint'];
  const prose = t['--color-text-prose'];
  const attention = t['--color-attention'];
  const running = t['--color-status-running'];
  const done = t['--color-status-done'];
  const blocked = t['--color-status-blocked'];

  return {
    // Editor surface and text
    'editor.background': base,
    'editor.foreground': prose,
    'editor.lineHighlightBackground': annotation,
    'editor.selectionBackground': alpha(borderStrong, 0.9),
    'editor.inactiveSelectionBackground': alpha(borderStrong, 0.5),
    'editor.selectionHighlightBackground': alpha(borderStrong, 0.55),
    'editor.selectionHighlightBorder': borderStrong,
    'editor.wordHighlightBackground': alpha(textPrimary, 0.1),
    'editor.wordHighlightStrongBackground': alpha(textPrimary, 0.16),
    'editor.wordHighlightBorder': alpha(textMuted, 0.6),
    'editor.wordHighlightStrongBorder': alpha(textMuted, 0.6),
    'editor.findMatchBackground': alpha(attention, 0.35),
    'editor.findMatchBorder': attention,
    'editor.findMatchHighlightBackground': alpha(attention, 0.18),

    // Cursor, line numbers, guides, whitespace
    'editorCursor.foreground': textPrimary,
    'editorCursor.background': base,
    'editorLineNumber.foreground': textFaint,
    'editorLineNumber.activeForeground': textSecondary,
    'editorIndentGuide.background1': divider,
    'editorIndentGuide.activeBackground1': borderStrong,
    'editorRuler.foreground': border,
    'editorWhitespace.foreground': alpha(textFaint, 0.35),
    'editorBracketMatch.background': alpha(borderStrong, 0.6),
    'editorBracketMatch.border': borderStrong,
    'editorBracketHighlight.foreground1': '#' + hue.number,
    'editorBracketHighlight.foreground2': '#' + hue.keyword,
    'editorBracketHighlight.foreground3': '#' + hue.escape,

    // Diagnostics
    'editorError.foreground': blocked,
    'editorWarning.foreground': t['--color-warning-fg'],

    // Gutter / overview ruler / minimap (git changes)
    'editorGutter.addedBackground': done,
    'editorGutter.modifiedBackground': running,
    'editorGutter.deletedBackground': blocked,
    'editorOverviewRuler.addedForeground': done,
    'editorOverviewRuler.modifiedForeground': running,
    'editorOverviewRuler.deletedForeground': blocked,
    'minimapGutter.addedBackground': done,
    'minimapGutter.modifiedBackground': running,
    'minimapGutter.deletedBackground': blocked,

    // Diff editor (same tints as your review screens)
    'diffEditor.insertedLineBackground': t['--color-added-bg'],
    'diffEditor.insertedTextBackground': alpha(t['--color-added-fg'], 0.22),
    'diffEditor.removedLineBackground': t['--color-removed-bg'],
    'diffEditor.removedTextBackground': alpha(t['--color-removed-fg'], 0.22),

    // Groups, tabs, sticky scroll
    'editorGroup.border': divider,
    'editorGroup.emptyBackground': panel,
    'editorGroupHeader.tabsBackground': panel,
    'editorStickyScroll.background': panel,
    'editorStickyScrollGutter.background': panel,
    'editorStickyScrollHover.background': raised,
    'editorStickyScroll.border': divider,
    'editorStickyScroll.shadow': '#00000000',

    // Widgets: suggest, hover, find, inlay hints
    'editorWidget.background': raised,
    'editorWidget.border': border,
    'editorHoverWidget.background': raised,
    'editorHoverWidget.border': border,
    'editorHoverWidget.highlightForeground': textPrimary,
    'editorSuggestWidget.background': raised,
    'editorSuggestWidget.border': border,
    'editorSuggestWidget.foreground': prose,
    'editorSuggestWidget.selectedBackground': raisedHover,
    'editorSuggestWidget.highlightForeground': textPrimary,
    'editorInlayHint.background': raised,
    'editorInlayHint.foreground': textMuted,
    focusBorder: borderStrong,
    'input.background': panel,
    'input.foreground': prose,
    'input.border': border,

    // Lists inside widgets
    'list.hoverBackground': hover,
    'list.hoverForeground': textPrimary,
    'list.activeSelectionBackground': raisedHover,
    'list.activeSelectionForeground': textPrimary,
    'list.inactiveSelectionBackground': raised,
    'list.inactiveSelectionForeground': textPrimary,
    'list.focusBackground': raisedHover,
    'list.focusForeground': textPrimary,
    'list.highlightForeground': textPrimary,
    'list.warningForeground': t['--color-warning-fg'],

    // Peek view
    'peekViewEditor.background': panel,
    'peekViewEditorGutter.background': panel,
    'peekViewResult.background': raised,
    'peekViewTitle.background': raised,
    'peekView.border': borderStrong,
    'peekViewEditor.matchHighlightBackground': alpha(attention, 0.3),

    // Scrollbars
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': alpha(textMuted, 0.2),
    'scrollbarSlider.hoverBackground': alpha(textMuted, 0.35),
    'scrollbarSlider.activeBackground': alpha(textMuted, 0.5),
  };
}

/** (Re)defines the theme for the CURRENT data-theme and applies it to every open editor. */
export function applyGhostTheme(monaco: typeof Monaco): void {
  const mode = getMode();
  const tokens = readTokens(mode);
  const name = cairnThemeName(mode);

  monaco.editor.defineTheme(name, {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: buildRules(mode, tokens),
    colors: buildColors(mode, tokens),
  });
  monaco.editor.setTheme(name);
}

/**
 * Call once after Monaco loads. Applies the theme now and re-applies it whenever
 * <html data-theme="..."> changes. Returns a disposer.
 *
 *   const stop = defineGhostTheme(monaco);
 *   monaco.editor.create(el, { theme: cairnThemeName(), ... });
 */
export function defineGhostTheme(monaco: typeof Monaco): () => void {
  applyGhostTheme(monaco);

  const observer = new MutationObserver(() => applyGhostTheme(monaco));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}
