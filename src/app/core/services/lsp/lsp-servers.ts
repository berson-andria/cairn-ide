/**
 * Which language server handles which Monaco language id.
 * Language ids come from your store's getMonacoLanguage / extension map,
 * so adding a language is one entry here.
 */
export interface LspServerConfig {
  id: string;
  /** Monaco language ids this server handles. */
  languages: string[];
  command: string;
  args: string[];
  /** npm-installed servers are `.cmd` shims on Windows and need that suffix. */
  npm?: boolean;
  enabled: boolean;
}

export const LSP_SERVERS: LspServerConfig[] = [
  // Adjust command names to what you actually installed
  // (e.g. pip's `pylsp` instead of npm's pyright -> { command: 'pylsp', args: [], npm: false }).
  {
    id: 'python',
    languages: ['python'],
    command: 'pylsp',
    args: [],
    enabled: true,
  },
  { id: 'rust', languages: ['rust'], command: 'rust-analyzer', args: [], enabled: true },
  {
    id: 'yaml',
    languages: ['yaml'],
    command: 'yaml-language-server',
    args: ['--stdio'],
    npm: true,
    enabled: true,
  },
  {
    id: 'dockerfile',
    languages: ['dockerfile'],
    command: 'docker-langserver',
    args: ['--stdio'],
    npm: true,
    enabled: true,
  },
  // Off by default: Monaco's built-in TS worker already provides completions/diagnostics
  // and the two would duplicate each other. Turn on once you disable the built-in one.
  {
    id: 'typescript',
    languages: ['typescript', 'javascript'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    npm: true,
    enabled: true,
  },
];

const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

export function resolveCommand(config: LspServerConfig): string {
  return config.npm && isWindows ? `${config.command}.cmd` : config.command;
}

export function serverForLanguage(languageId: string): LspServerConfig | undefined {
  return LSP_SERVERS.find((s) => s.enabled && s.languages.includes(languageId));
}
