import type * as Monaco from 'monaco-editor';

const tomlConf: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

const tomlTokens: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.toml',
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
  ],
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/^\s*\[\[[^\]]*\]\]/, 'type'], // [[array.of.tables]]
      [/^\s*\[[^\]]*\]/, 'type'], //     [table.header]
      [/[A-Za-z0-9_-]+(?=\s*=)/, 'key'],
      [/"""/, 'string', '@multiBasic'],
      [/'''/, 'string', '@multiLiteral'],
      [/"/, 'string', '@basic'],
      [/'[^']*'/, 'string'],
      [/\b(?:true|false)\b/, 'keyword'],
      [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/, 'number'],
      [/[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+)/, 'number'],
      [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/, 'number'],
      [/[+-]?(?:inf|nan)\b/, 'number'],
      [/[=,.]/, 'delimiter'],
      [/[{}[\]]/, '@brackets'],
    ],
    basic: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    multiBasic: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string'],
    ],
    multiLiteral: [
      [/[^']+/, 'string'],
      [/'''/, 'string', '@pop'],
      [/'/, 'string'],
    ],
  },
};

/**
 * Languages Monaco doesn't ship a tokenizer for.
 * Must run before any model is created with these language ids.
 */
export async function registerExtraLanguages(monaco: typeof Monaco): Promise<void> {
  monaco.languages.register({ id: 'toml', extensions: ['.toml'], aliases: ['TOML'] });
  monaco.languages.setMonarchTokensProvider('toml', tomlTokens);
  monaco.languages.setLanguageConfiguration('toml', tomlConf);

  // Vue / Svelte / Astro: borrow Monaco's HTML tokenizer (tags, attributes, embedded <script>/<style>).
  // @ts-ignore - deep import into basic-languages; resolved by the package's exports map
  const html = await import('monaco-editor/languages/definitions/html/html');
  for (const id of ['vue', 'svelte', 'astro']) {
    monaco.languages.register({ id, extensions: [`.${id}`], aliases: [id] });
    monaco.languages.setMonarchTokensProvider(id, html.language);
    monaco.languages.setLanguageConfiguration(id, html.conf);
  }
}
