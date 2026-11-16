import { LSP_SERVERS } from '../../core/services/lsp/lsp-servers';

export type SettingType =
  | 'boolean'
  | 'number'
  | 'string'
  | 'enum'
  | 'string-list'
  | 'path'
  | 'command';

export type SettingScope = 'user' | 'workspace' | 'both';
export type SettingStatus = 'active' | 'planned';
export type SettingValue = boolean | number | string | string[] | Record<string, unknown>;

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDef {
  key: string;
  type: SettingType;
  default: SettingValue;
  scope: SettingScope;
  section: string;
  label: string;
  description: string;
  options?: SettingOption[];
  status: SettingStatus;
  subsection?: 'lsp';
}

export interface Section {
  id: string;
  label: string;
  order: number;
}

export const SECTIONS: Section[] = [
  { id: 'appearance', label: 'Appearance', order: 1 },
  { id: 'editor', label: 'Editor', order: 2 },
  { id: 'terminal', label: 'Terminal', order: 3 },
  { id: 'languages', label: 'Languages & LSP', order: 4 },
  { id: 'models', label: 'Models', order: 5 },
  { id: 'codemap', label: 'Code Map', order: 6 },
  { id: 'tasks', label: 'Tasks', order: 7 },
  { id: 'agents', label: 'Agents', order: 8 },
  { id: 'trust', label: 'Trust', order: 9 },
  { id: 'diagnostics', label: 'Diagnostics', order: 10 },
];

const option = (value: string, label = value): SettingOption => ({ value, label });

function setting(
  section: string,
  name: string,
  type: SettingType,
  defaultValue: SettingValue,
  scope: SettingScope,
  status: SettingStatus,
  description: string,
  options?: SettingOption[],
): SettingDef {
  return {
    key: `${section}.${name}`,
    type,
    default: defaultValue,
    scope,
    section,
    label: name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[._-]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    description,
    ...(options ? { options } : {}),
    status,
  };
}

const active = 'active' as const;
const planned = 'planned' as const;

export const SETTINGS: SettingDef[] = [
  setting(
    'appearance',
    'theme',
    'enum',
    'dark',
    'user',
    active,
    'Color theme for the application.',
    [option('dark', 'Dark'), option('light', 'Light'), option('system', 'System')],
  ),
  setting(
    'appearance',
    'layoutDensity',
    'enum',
    'comfortable',
    'user',
    active,
    'Spacing density for interface controls.',
    [option('compact'), option('comfortable')],
  ),
  setting(
    'appearance',
    'editorFontFamily',
    'string',
    "Consolas, 'Courier New', monospace",
    'user',
    active,
    'Font family for the editor.',
  ),
  setting(
    'appearance',
    'editorFontSize',
    'number',
    14,
    'user',
    active,
    'Editor font size in pixels.',
  ),
  setting(
    'appearance',
    'editorLineHeight',
    'number',
    0,
    'user',
    active,
    'Editor line height in pixels; zero uses the default.',
  ),

  setting(
    'editor',
    'tabSize',
    'number',
    4,
    'both',
    active,
    'Number of spaces represented by a tab.',
  ),
  setting(
    'editor',
    'insertSpaces',
    'boolean',
    true,
    'both',
    active,
    'Insert spaces when pressing Tab.',
  ),
  setting('editor', 'wordWrap', 'enum', 'off', 'both', active, 'Controls how long lines wrap.', [
    option('off'),
    option('on'),
    option('wordWrapColumn'),
    option('bounded'),
  ]),
  setting('editor', 'minimap', 'boolean', true, 'both', active, 'Show the editor minimap.'),
  setting(
    'editor',
    'autoSave',
    'enum',
    'off',
    'both',
    active,
    'Controls when files are saved automatically.',
    [option('off'), option('afterDelay'), option('onFocusChange'), option('onWindowChange')],
  ),
  setting(
    'editor',
    'formatOnSave',
    'boolean',
    false,
    'both',
    active,
    'Format files when they are saved.',
  ),
  setting(
    'editor',
    'bracketColorization',
    'boolean',
    true,
    'both',
    active,
    'Colorize matching bracket pairs.',
  ),
  setting(
    'editor',
    'renderWhitespace',
    'enum',
    'selection',
    'both',
    active,
    'Controls when whitespace characters are shown.',
    [option('none'), option('boundary'), option('selection'), option('trailing'), option('all')],
  ),

  setting(
    'terminal',
    'shell',
    'path',
    '',
    'user',
    active,
    'Executable path for the default terminal shell.',
  ),
  setting(
    'terminal',
    'shellArgs',
    'string-list',
    [],
    'user',
    active,
    'Arguments passed to the default shell.',
  ),
  setting('terminal', 'fontSize', 'number', 14, 'user', active, 'Terminal font size in pixels.'),
  setting(
    'terminal',
    'scrollback',
    'number',
    1000,
    'user',
    active,
    'Maximum number of terminal lines retained.',
  ),
  setting('terminal', 'cursorStyle', 'enum', 'block', 'user', active, 'Terminal cursor shape.', [
    option('block'),
    option('line'),
    option('underline'),
  ]),

  ...LSP_SERVERS.flatMap((server) => [
    setting(
      'lsp',
      `${server.id}.enabled`,
      'boolean',
      server.enabled,
      'both',
      active,
      `Enable the ${server.id} language server.`,
    ),
    setting(
      'lsp',
      `${server.id}.commandPath`,
      'path',
      server.command,
      'both',
      active,
      `Executable path for the ${server.id} language server.`,
    ),
    setting(
      'lsp',
      `${server.id}.args`,
      'string-list',
      [...server.args],
      'both',
      active,
      `Arguments for the ${server.id} language server.`,
    ),
  ]),

  setting(
    'models',
    'registry',
    'string',
    '',
    'user',
    active,
    'Registry of named model configurations.',
  ),
  setting('models', 'defaultModel', 'string', '', 'user', active, 'Name of the default model.'),
  setting(
    'models',
    'modelPerSkill',
    'string',
    '',
    'user',
    planned,
    'Optional model selection for each skill.',
  ),

  setting(
    'codemap',
    'autoUpdateOnSave',
    'boolean',
    true,
    'workspace',
    planned,
    'Update the code map when files are saved.',
  ),
  setting(
    'codemap',
    'ignorePatterns',
    'string-list',
    [],
    'workspace',
    planned,
    'Patterns excluded from the code map.',
  ),
  setting(
    'codemap',
    'summaryModel',
    'string',
    '',
    'workspace',
    planned,
    'Model used to summarize code map entries.',
  ),
  setting(
    'codemap',
    'contextDepth',
    'number',
    2,
    'workspace',
    planned,
    'Depth of related code included in map context.',
  ),

  setting(
    'tasks',
    'checkCommands',
    'string',
    '',
    'workspace',
    planned,
    'Commands for test, lint, and typecheck tasks.',
  ),

  setting('agents', 'pythonPath', 'path', '', 'both', planned, 'Python executable used by agents.'),
  setting(
    'agents',
    'lazyStart',
    'boolean',
    true,
    'both',
    planned,
    'Start agent processes only when needed.',
  ),
  setting(
    'agents',
    'defaultWorkflowEnabled',
    'boolean',
    true,
    'both',
    planned,
    'Enable the default agent workflow.',
  ),

  setting(
    'trust',
    'restrictedMode',
    'boolean',
    false,
    'workspace',
    planned,
    'Restrict actions in this workspace.',
  ),

  setting(
    'diagnostics',
    'logLevel',
    'enum',
    'info',
    'user',
    active,
    'Minimum severity written to application logs.',
    [option('trace'), option('debug'), option('info'), option('warn'), option('error')],
  ),
  setting(
    'diagnostics',
    'traceModelCalls',
    'boolean',
    false,
    'user',
    planned,
    'Record detailed model call traces.',
  ),
].map((def) => {
  if (def.key.startsWith('lsp.')) return { ...def, section: 'languages', subsection: 'lsp' };
  return def;
});
