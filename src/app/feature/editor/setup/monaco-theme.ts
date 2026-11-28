import type * as Monaco from 'monaco-editor';

/**
 * VERSION 2: everything matched to the Praide tokens.
 *
 *  - Background, default text, comments, line numbers, selection, line highlight, widgets, borders,
 *    scrollbars, diff and gutter colors are all read from token.scss (so they follow light/dark).
 *  - Syntax colors, default code text and comments follow One Dark Pro (dark) / One Light (light), so
 *    code reads like it does in those reference themes. Only the light-mode comment color is pulled
 *    from the tokens (One Light's own comment grey is too faint on the neutral light surface).
 *
 * Monaco themes are static hex objects: they cannot use CSS variables. So the theme is rebuilt from the
 * current computed token values and re-applied whenever <html data-theme> changes.
 */

type Mode = 'dark' | 'light';

const getMode = (): Mode =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

export const praideThemeName = (mode: Mode = getMode()): string => `praide-${mode}`;

/** Fallbacks = the values in token.scss (neutral base), used only if a variable can't be read. */
const FALLBACKS: Record<Mode, Record<string, string>> = {
  dark: {
    '--color-surface-base': '#1c1d1f',
    '--color-surface-panel': '#212225',
    '--color-surface-raised': '#2a2b2f',
    '--color-surface-hover': '#2f3034',
    '--color-surface-raised-hover': '#3a3b40',
    '--color-surface-annotation': '#232428',
    '--color-divider': '#2f3034',
    '--color-border': '#3a3b40',
    '--color-border-strong': '#4a4b51',
    '--color-text-primary': '#e6e7e9',
    '--color-text-secondary': '#c5c7cb',
    '--color-text-muted': '#9fa2a8',
    '--color-text-faint': '#7c7f86',
    '--color-text-prose': '#d5d7da',
    '--color-text-code-comment': '#878a91',
    '--color-attention': '#e2a93b',
    '--color-status-running': '#5aa9e6',
    '--color-status-done': '#6fae85',
    '--color-status-blocked': '#d98f98',
    '--color-added-bg': '#1c2b23',
    '--color-added-fg': '#a8d5b5',
    '--color-removed-bg': '#352428',
    '--color-removed-fg': '#ee5a66',
    '--color-warning-fg': '#e2c27b',
  },
  light: {
    '--color-surface-base': '#fafafa',
    '--color-surface-panel': '#f2f2f3',
    '--color-surface-raised': '#ebebed',
    '--color-surface-hover': '#e3e3e6',
    '--color-surface-raised-hover': '#d8d8dc',
    '--color-surface-annotation': '#f0f0f1',
    '--color-divider': '#e3e3e6',
    '--color-border': '#d8d8dc',
    '--color-border-strong': '#c2c2c8',
    '--color-text-primary': '#1c1d1f',
    '--color-text-secondary': '#44454a',
    '--color-text-muted': '#686a70',
    '--color-text-faint': '#85878d',
    '--color-text-prose': '#2e2f33',
    '--color-text-code-comment': '#76787e',
    '--color-attention': '#9a610a',
    '--color-status-running': '#2f73a8',
    '--color-status-done': '#3f7d58',
    '--color-status-blocked': '#a8434f',
    '--color-added-bg': '#e2f1e8',
    '--color-added-fg': '#23603a',
    '--color-removed-bg': '#f6e3e5',
    '--color-removed-fg': '#d93a47',
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
  fg: string; // default code text, delimiters
  comment?: string; // omit to use the --color-text-code-comment token
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
    fg: 'abb2bf',
    comment: '7f848e',
    keyword: 'c678dd',
    string: '98c379',
    escape: '56b6c2',
    number: 'd19a66',
    red: 'e06c75',
    yellow: 'e5c07b',
    blue: '61afef',
    invalid: 'f44747',
  },
  light: {
    fg: '383a42',
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
  const fg = p.fg;
  const comment = p.comment ?? bare(t['--color-text-code-comment']);
  const link = mode === 'dark' ? '61afef' : '4078f2';

  // Monaco matches the LONGEST token prefix, so a language-suffixed rule (e.g. 'tag.python') wins over
  // the generic one ('tag'). Token names below are the ones Monaco's Monarch tokenizers (monaco-editor
  // 0.58) and the JSON language service emit. Comments say which One Dark Pro scope each rule follows.
  return [
    // ---- Base ----
    { token: '', foreground: fg },
    { token: 'white', foreground: fg },
    { token: 'comment', foreground: comment },
    { token: 'invalid', foreground: p.invalid },
    { token: 'string.invalid', foreground: p.invalid },
    { token: 'string.escape.invalid', foreground: p.invalid },
    { token: 'regexp.invalid', foreground: p.invalid },

    // ---- Keywords, operators, punctuation ----
    { token: 'keyword', foreground: p.keyword }, // keyword, storage.type, keyword.control
    { token: 'keyword.other', foreground: p.keyword },
    { token: 'operator', foreground: p.escape }, // keyword.operator.* (python, sql, rust, scss)
    { token: 'operators', foreground: p.escape },
    { token: 'delimiter', foreground: fg }, // punctuation (typescript/javascript also put operators here)
    { token: 'delimiter.bracket', foreground: fg },
    { token: 'delimiter.parenthesis', foreground: fg },
    { token: 'delimiter.curly', foreground: fg },
    { token: 'delimiter.square', foreground: fg },
    { token: 'delimiter.angle', foreground: fg },
    { token: 'predefined', foreground: p.escape }, // support.function (cyan)
    { token: 'constant', foreground: p.number },
    { token: 'macro', foreground: p.number },

    // ---- Strings, numbers, regexp ----
    { token: 'string', foreground: p.string },
    { token: 'string.escape', foreground: p.escape }, // constant.character.escape
    { token: 'string.heredoc', foreground: p.string },
    { token: 'string.quote', foreground: p.string },
    { token: 'number', foreground: p.number }, // constant.numeric (covers .hex .float .octal .binary)
    { token: 'regexp', foreground: p.escape }, // string.regexp
    { token: 'regexp.escape', foreground: p.red }, // constant.other.character-class.regexp
    { token: 'regexp.escape.control', foreground: p.number }, // keyword.operator.quantifier.regexp

    // ---- Identifiers, types ----
    { token: 'identifier', foreground: p.red }, // variable (Monarch cannot split calls from variables)
    { token: 'identifier.quote', foreground: p.red },
    { token: 'type', foreground: p.yellow }, // entity.name.type
    { token: 'type.identifier', foreground: p.yellow },
    { token: 'keyword.type', foreground: p.yellow }, // rust primitive types
    { token: 'namespace', foreground: p.yellow },
    { token: 'annotation', foreground: p.yellow }, // java / go / c++ annotations
    { token: 'variable', foreground: p.red },
    { token: 'variable.predefined', foreground: p.yellow }, // variable.language ($?, $0 ...)
    { token: 'variable.source', foreground: p.string },

    // ---- Markup / tags ----
    { token: 'tag', foreground: p.red }, // entity.name.tag
    { token: 'metatag', foreground: p.red },
    { token: 'attribute.name', foreground: p.number }, // entity.other.attribute-name
    { token: 'attribute.value', foreground: p.string },
    { token: 'key', foreground: p.red },

    // ---- Python ----
    { token: 'tag.python', foreground: p.blue }, // decorators: meta.function.decorator

    // ---- JSON (JSON language service) ----
    { token: 'string.key.json', foreground: p.red }, // support.type.property-name.json
    { token: 'string.value.json', foreground: p.string },
    { token: 'keyword.json', foreground: p.escape }, // true / false / null: constant.language.json

    // ---- YAML ----
    { token: 'type.yaml', foreground: p.red }, // keys
    { token: 'keyword.yaml', foreground: p.number }, // true / false / null
    { token: 'tag.yaml', foreground: p.yellow }, // anchors, !tags
    { token: 'meta.directive.yaml', foreground: fg },
    { token: 'operators.directivesEnd.yaml', foreground: fg },
    { token: 'operators.documentEnd.yaml', foreground: fg },

    // ---- CSS / SCSS ----
    { token: 'tag.css', foreground: p.red }, // selectors
    { token: 'tag.scss', foreground: p.red },
    { token: 'attribute.name.css', foreground: p.escape }, // support.type.property-name.css
    { token: 'attribute.name.scss', foreground: p.escape },
    { token: 'attribute.value.css', foreground: p.number }, // support.constant.property-value.css
    { token: 'attribute.value.number.css', foreground: p.number },
    { token: 'attribute.value.unit.css', foreground: p.red }, // keyword.other.unit
    { token: 'attribute.value.hex.css', foreground: p.number },
    { token: 'variable.decl.scss', foreground: p.red },
    { token: 'variable.ref.scss', foreground: p.red },

    // ---- Markdown ----
    { token: 'keyword.md', foreground: p.red }, // markup.heading
    { token: 'strong', foreground: p.number, fontStyle: 'bold' }, // markup.bold
    { token: 'emphasis', foreground: p.keyword, fontStyle: 'italic' }, // markup.italic
    { token: 'string.link', foreground: link }, // link text
    { token: 'string.target', foreground: p.escape }, // link url
    { token: 'string.md', foreground: p.string },

    // ---- INI / shell ----
    { token: 'metatag.ini', foreground: p.blue }, // entity.name.section.group-title.ini
    { token: 'metatag.shell', foreground: comment }, // shebang

    // ---- Overrides of Monaco's stock vs / vs-dark rules ----
    // The theme uses inherit: true, so any stock rule we do not override leaks through, and stock rules are
    // more specific than our generic ones. For example 'meta.scss' is #A79873 in vs-dark, which is the muddy
    // khaki on SCSS/CSS function names such as var(), rgb(), calc() and color-mix().
    { token: 'meta', foreground: p.escape }, // support.function / url( / #{ interpolation
    { token: 'meta.scss', foreground: p.escape },
    { token: 'meta.tag', foreground: p.red },
    { token: 'metatag.html', foreground: p.red },
    { token: 'metatag.xml', foreground: p.red },
    { token: 'metatag.content.html', foreground: p.red },
    { token: 'metatag.php', foreground: p.red },
    { token: 'tag.id.pug', foreground: p.blue },
    { token: 'tag.class.pug', foreground: p.number },
    { token: 'variable.parameter', foreground: fg },
    { token: 'keyword.flow', foreground: p.keyword },
    { token: 'keyword.flow.scss', foreground: p.keyword },
    { token: 'number.hex', foreground: p.number },
    { token: 'string.html', foreground: p.string },
    { token: 'string.yaml', foreground: p.string },
    { token: 'string.sql', foreground: p.string },
    { token: 'attribute.value.html', foreground: p.string },
    { token: 'attribute.value.xml', foreground: p.string },
    { token: 'attribute.value.number', foreground: p.number },
    { token: 'attribute.value.unit', foreground: p.red },
    { token: 'operator.scss', foreground: p.escape },
    { token: 'operator.sql', foreground: p.escape },
    { token: 'operator.swift', foreground: p.escape },
    { token: 'predefined.sql', foreground: p.escape },
    { token: 'delimiter.html', foreground: fg },
    { token: 'delimiter.xml', foreground: fg },

    // ---- Semantic tokens (if a language service provides them) ----
    { token: 'class', foreground: p.yellow },
    { token: 'struct', foreground: p.yellow },
    { token: 'enum', foreground: p.yellow },
    { token: 'interface', foreground: p.yellow },
    { token: 'typeParameter', foreground: p.yellow },
    { token: 'function', foreground: p.blue },
    { token: 'method', foreground: p.blue },
    { token: 'decorator', foreground: p.blue },
    { token: 'parameter', foreground: fg }, // variable.parameter.function is plain text in One Dark Pro
    { token: 'property', foreground: p.red },
    { token: 'event', foreground: p.red },
    { token: 'enumMember', foreground: p.escape },
    { token: 'variable.constant', foreground: p.number },
    { token: 'variable.defaultLibrary', foreground: p.yellow },
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
    'editor.foreground': '#' + hue.fg,
    'editor.lineHighlightBackground': annotation,
    // Selection is a translucent blue (not a grey), so it stays visible on top of the green/red diff tints.
    'editor.selectionBackground': alpha(running, 0.4),
    'editor.inactiveSelectionBackground': alpha(running, 0.22),
    'editor.selectionHighlightBackground': alpha(running, 0.2),
    'editor.selectionHighlightBorder': alpha(running, 0.5),
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

    // Diff editor. Line tints are translucent (derived from the added/removed foreground tokens) instead of
    // the opaque added-bg / removed-bg, so they never cover the selection layer on changed lines.
    'diffEditor.insertedLineBackground': alpha(t['--color-added-fg'], 0.12),
    'diffEditor.insertedTextBackground': alpha(t['--color-added-fg'], 0.22),
    'diffEditor.removedLineBackground': alpha(t['--color-removed-fg'], 0.2),
    'diffEditor.removedTextBackground': alpha(t['--color-removed-fg'], 0.3),

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
    'editorHoverWidget.highlightForeground': '#' + hue.blue,
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
export function applyTheme(monaco: typeof Monaco): void {
  const mode = getMode();
  const tokens = readTokens(mode);
  const name = praideThemeName(mode);

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
 *   const stop = defineTheme(monaco);
 *   monaco.editor.create(el, { theme: praideThemeName(), ... });
 */
export function defineTheme(monaco: typeof Monaco): () => void {
  applyTheme(monaco);

  const observer = new MutationObserver(() => applyTheme(monaco));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}
