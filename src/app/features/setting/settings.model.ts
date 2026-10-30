/**
 * Declarative settings registry. The settings UI is generated from this list:
 * adding / removing / reordering a setting is a one-line change here, no template edit.
 * Order in this array = order on screen (sections appear in order of first use).
 */

export type SettingValue = boolean | number | string;
export type SettingType = 'boolean' | 'number' | 'select' | 'text';

export type CategoryId =
  | 'workbench'
  | 'editor'
  | 'files'
  | 'terminal'
  | 'git'
  | 'ai'
  | 'application';

export interface SettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingDef {
  /** Unique, dotted, VS Code style key. Components read it with SettingsService.get / select. */
  key: string;
  type: SettingType;
  category: CategoryId;
  section: string;
  label: string;
  description: string;
  default: SettingValue;
  /** select */
  options?: SettingOption[];
  /** select: render as a segmented control instead of a dropdown (best for 2-3 options) */
  ui?: 'segmented';
  /** number */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** text */
  placeholder?: string;
  monospace?: boolean;
  /** extra search terms */
  keywords?: string[];
}

export const SETTING_CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'workbench', label: 'Workbench' },
  { id: 'editor', label: 'Text Editor' },
  { id: 'files', label: 'Files & Explorer' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'git', label: 'Git' },
  { id: 'ai', label: 'AI & Agent' },
  { id: 'application', label: 'Application' },
];

// ---------------------------------------------------------------------------
// tiny builders to keep the list readable
// ---------------------------------------------------------------------------
type Meta = Pick<SettingDef, 'key' | 'category' | 'section' | 'label' | 'description' | 'keywords'>;

const meta = (
  category: CategoryId,
  section: string,
  key: string,
  label: string,
  description: string,
  keywords?: string[],
): Meta => ({ category, section, key, label, description, keywords });

const opt = (value: string, label: string, description?: string): SettingOption => ({
  value,
  label,
  description,
});

const bool = (m: Meta, def: boolean): SettingDef => ({ ...m, type: 'boolean', default: def });

const num = (
  m: Meta,
  def: number,
  o: { min?: number; max?: number; step?: number; unit?: string } = {},
): SettingDef => ({ ...m, type: 'number', default: def, ...o });

const pick = (
  m: Meta,
  def: string,
  options: SettingOption[],
  ui?: 'segmented',
): SettingDef => ({ ...m, type: 'select', default: def, options, ui });

const text = (
  m: Meta,
  def: string,
  o: { placeholder?: string; monospace?: boolean } = {},
): SettingDef => ({ ...m, type: 'text', default: def, ...o });

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------
export const SETTINGS: SettingDef[] = [
  // ============================== WORKBENCH ================================
  pick(
    meta('workbench', 'Appearance', 'workbench.density', 'Density',
      'Spacing between panels and corner rounding. Compact has no gaps and square corners.',
      ['gap', 'radius', 'border', 'rounded', 'spacing']),
    'compact',
    [opt('compact', 'Compact'), opt('comfortable', 'Comfortable')],
    'segmented',
  ),
  pick(
    meta('workbench', 'Appearance', 'workbench.colorTheme', 'Color Theme',
      'Overall color theme of the application.', ['dark', 'light']),
    'dark',
    [opt('dark', 'Dark'), opt('light', 'Light'), opt('system', 'System')],
    'segmented',
  ),

  pick(
    meta('workbench', 'Layout', 'workbench.sideBar.location', 'Side Bar Location',
      'Moves the activity bar and the explorer to the other side. The agent panel goes to the opposite side.',
      ['swap', 'left', 'right', 'activity bar']),
    'left',
    [opt('left', 'Left'), opt('right', 'Right')],
    'segmented',
  ),
  pick(
    meta('workbench', 'Layout', 'workbench.panel.alignment', 'Terminal Alignment',
      'Which panels the terminal spans at the bottom of the window.', ['panel', 'bottom']),
    'all',
    [
      opt('all', 'Full width', 'The terminal spans the whole window under every panel.'),
      opt('editor', 'Editor only', 'Under the editor; the side panels keep their full height.'),
      opt('with-explorer', 'With explorer', 'Under the explorer and the editor; the agent panel keeps its full height.'),
      opt('with-agent', 'With agent', 'Under the editor and the agent panel; the explorer keeps its full height.'),
    ],
  ),

  bool(
    meta('workbench', 'Visibility', 'workbench.sideBar.visible', 'Primary Side Bar',
      'Show the explorer / source control side bar.', ['explorer']),
    true,
  ),
  bool(
    meta('workbench', 'Visibility', 'workbench.secondarySideBar.visible', 'Secondary Side Bar',
      'Show the agent / todo / notes side bar.', ['agent', 'chat']),
    false,
  ),
  bool(
    meta('workbench', 'Visibility', 'workbench.panel.visible', 'Terminal Panel',
      'Show the terminal panel.', ['panel']),
    false,
  ),

  num(
    meta('workbench', 'Sizes', 'workbench.sideBar.width', 'Primary Side Bar Width',
      'Width of the primary side bar when it is open.'),
    280, { min: 250, max: 600, step: 10, unit: 'px' },
  ),
  num(
    meta('workbench', 'Sizes', 'workbench.secondarySideBar.width', 'Secondary Side Bar Width',
      'Width of the secondary side bar when it is open.'),
    320, { min: 250, max: 600, step: 10, unit: 'px' },
  ),
  num(
    meta('workbench', 'Sizes', 'workbench.panel.height', 'Terminal Panel Height',
      'Height of the terminal panel when it is open.'),
    320, { min: 50, max: 500, step: 10, unit: 'px' },
  ),

  // =============================== EDITOR ==================================
  text(
    meta('editor', 'Font', 'editor.fontFamily', 'Font Family',
      'Controls the font family of the editor.'),
    "Consolas, 'Courier New', monospace", { monospace: true },
  ),
  num(
    meta('editor', 'Font', 'editor.fontSize', 'Font Size', 'Controls the font size in pixels.'),
    14, { min: 8, max: 32, step: 1, unit: 'px' },
  ),
  num(
    meta('editor', 'Font', 'editor.lineHeight', 'Line Height',
      'Line height in pixels. 0 computes it from the font size.'),
    0, { min: 0, max: 100, step: 1, unit: 'px' },
  ),
  bool(
    meta('editor', 'Font', 'editor.fontLigatures', 'Font Ligatures',
      'Enables font ligatures such as => and !==.'),
    false,
  ),

  num(
    meta('editor', 'Indentation', 'editor.tabSize', 'Tab Size',
      'The number of spaces a tab is equal to.', ['indent']),
    4, { min: 1, max: 16, step: 1 },
  ),
  bool(
    meta('editor', 'Indentation', 'editor.insertSpaces', 'Insert Spaces',
      'Insert spaces when pressing Tab.', ['indent']),
    true,
  ),
  bool(
    meta('editor', 'Indentation', 'editor.detectIndentation', 'Detect Indentation',
      'Detect tab size and spaces / tabs from the file content when it is opened.'),
    true,
  ),

  pick(
    meta('editor', 'Display', 'editor.wordWrap', 'Word Wrap', 'Controls how long lines wrap.'),
    'off',
    [opt('off', 'Off'), opt('on', 'On')],
    'segmented',
  ),
  pick(
    meta('editor', 'Display', 'editor.lineNumbers', 'Line Numbers', 'Controls the display of line numbers.'),
    'on',
    [opt('on', 'On'), opt('relative', 'Relative'), opt('off', 'Off')],
    'segmented',
  ),
  bool(
    meta('editor', 'Display', 'editor.minimap.enabled', 'Minimap', 'Show the minimap on the right.'),
    true,
  ),
  bool(
    meta('editor', 'Display', 'editor.stickyScroll.enabled', 'Sticky Scroll',
      'Keep the current scopes (class, function) pinned at the top while scrolling.'),
    true,
  ),
  pick(
    meta('editor', 'Display', 'editor.renderWhitespace', 'Render Whitespace',
      'Controls how whitespace characters are rendered.'),
    'selection',
    [
      opt('none', 'None'),
      opt('boundary', 'Boundary'),
      opt('selection', 'Selection'),
      opt('trailing', 'Trailing'),
      opt('all', 'All'),
    ],
  ),
  bool(
    meta('editor', 'Display', 'editor.bracketPairColorization.enabled', 'Bracket Pair Colorization',
      'Color matching brackets with the same color per nesting level.'),
    true,
  ),
  bool(
    meta('editor', 'Display', 'editor.scrollBeyondLastLine', 'Scroll Beyond Last Line',
      'Allow scrolling past the last line.'),
    true,
  ),

  pick(
    meta('editor', 'Cursor', 'editor.cursorStyle', 'Cursor Style', 'Controls the cursor style.'),
    'line',
    [opt('line', 'Line'), opt('block', 'Block'), opt('underline', 'Underline')],
    'segmented',
  ),
  pick(
    meta('editor', 'Cursor', 'editor.cursorBlinking', 'Cursor Blinking', 'Controls the cursor animation style.'),
    'blink',
    [
      opt('blink', 'Blink'),
      opt('smooth', 'Smooth'),
      opt('phase', 'Phase'),
      opt('expand', 'Expand'),
      opt('solid', 'Solid'),
    ],
  ),
  bool(
    meta('editor', 'Cursor', 'editor.smoothScrolling', 'Smooth Scrolling', 'Animate scrolling.'),
    false,
  ),
  bool(
    meta('editor', 'Cursor', 'editor.mouseWheelZoom', 'Mouse Wheel Zoom',
      'Zoom the editor font with Ctrl + mouse wheel.'),
    false,
  ),

  bool(
    meta('editor', 'Formatting', 'editor.formatOnSave', 'Format On Save', 'Format the file when it is saved.'),
    false,
  ),
  bool(
    meta('editor', 'Formatting', 'editor.formatOnPaste', 'Format On Paste', 'Format pasted content.'),
    false,
  ),

  // ========================= FILES & EXPLORER ==============================
  pick(
    meta('files', 'Saving', 'files.autoSave', 'Auto Save', 'Controls when modified files are saved automatically.'),
    'off',
    [
      opt('off', 'Off'),
      opt('afterDelay', 'After delay'),
      opt('onFocusChange', 'On focus change'),
      opt('onWindowChange', 'On window change'),
    ],
  ),
  num(
    meta('files', 'Saving', 'files.autoSaveDelay', 'Auto Save Delay',
      'Delay before saving when Auto Save is set to "After delay".'),
    1000, { min: 100, max: 60000, step: 100, unit: 'ms' },
  ),
  bool(
    meta('files', 'Saving', 'files.trimTrailingWhitespace', 'Trim Trailing Whitespace',
      'Remove trailing whitespace when saving.'),
    false,
  ),
  bool(
    meta('files', 'Saving', 'files.insertFinalNewline', 'Insert Final Newline',
      'Insert a final newline at the end of the file when saving.'),
    false,
  ),

  pick(
    meta('files', 'Format', 'files.eol', 'End Of Line', 'Default end of line sequence for new files.', ['newline', 'crlf', 'lf']),
    'auto',
    [opt('auto', 'Auto'), opt('lf', 'LF'), opt('crlf', 'CRLF')],
    'segmented',
  ),
  pick(
    meta('files', 'Format', 'files.encoding', 'Encoding', 'Default character set used when reading and writing files.'),
    'utf8',
    [opt('utf8', 'UTF-8'), opt('utf16le', 'UTF-16 LE'), opt('utf16be', 'UTF-16 BE'), opt('windows1252', 'Western (Windows 1252)')],
  ),

  bool(
    meta('files', 'Explorer', 'explorer.confirmDelete', 'Confirm Delete',
      'Ask for confirmation when deleting a file or folder.'),
    true,
  ),
  bool(
    meta('files', 'Explorer', 'explorer.confirmDragAndDrop', 'Confirm Drag And Drop',
      'Ask for confirmation when moving files or folders by drag and drop.'),
    true,
  ),
  bool(
    meta('files', 'Explorer', 'explorer.compactFolders', 'Compact Folders',
      'Show single-child folder chains on one row (a/b/c).'),
    true,
  ),
  pick(
    meta('files', 'Explorer', 'explorer.sortOrder', 'Sort Order', 'Controls how files and folders are sorted.'),
    'default',
    [
      opt('default', 'Default', 'Folders first, then files, alphabetically.'),
      opt('filesFirst', 'Files first'),
      opt('mixed', 'Mixed'),
      opt('type', 'By type'),
      opt('modified', 'By modified date'),
    ],
  ),

  // ============================== TERMINAL =================================
  text(
    meta('terminal', 'Font', 'terminal.integrated.fontFamily', 'Font Family',
      'Font family of the terminal. Empty uses the editor font.'),
    '', { placeholder: 'Same as the editor font', monospace: true },
  ),
  num(
    meta('terminal', 'Font', 'terminal.integrated.fontSize', 'Font Size', 'Font size of the terminal in pixels.'),
    14, { min: 6, max: 100, step: 1, unit: 'px' },
  ),
  pick(
    meta('terminal', 'Cursor', 'terminal.integrated.cursorStyle', 'Cursor Style', 'Style of the terminal cursor.'),
    'block',
    [opt('block', 'Block'), opt('line', 'Line'), opt('underline', 'Underline')],
    'segmented',
  ),
  bool(
    meta('terminal', 'Cursor', 'terminal.integrated.cursorBlinking', 'Cursor Blinking', 'Blink the terminal cursor.'),
    false,
  ),
  text(
    meta('terminal', 'Shell', 'terminal.integrated.shell', 'Default Shell',
      'Path of the shell used for new terminals. Empty uses the system default.'),
    '', { placeholder: 'System default', monospace: true },
  ),
  num(
    meta('terminal', 'Behavior', 'terminal.integrated.scrollback', 'Scrollback',
      'Maximum number of lines kept in the terminal buffer.'),
    1000, { min: 0, max: 100000, step: 100, unit: 'lines' },
  ),
  bool(
    meta('terminal', 'Behavior', 'terminal.integrated.copyOnSelection', 'Copy On Selection',
      'Copy the selected text to the clipboard automatically.'),
    false,
  ),
  bool(
    meta('terminal', 'Behavior', 'terminal.integrated.enableBell', 'Enable Bell', 'Play the terminal bell.'),
    false,
  ),

  // ================================= GIT ===================================
  bool(
    meta('git', 'General', 'git.enabled', 'Enabled', 'Enable Git integration.'),
    true,
  ),
  text(
    meta('git', 'General', 'git.defaultBranchName', 'Default Branch Name',
      'Name of the first branch when initializing a repository.'),
    'main', { placeholder: 'main' },
  ),
  bool(
    meta('git', 'Commit', 'git.enableSmartCommit', 'Smart Commit',
      'Commit all changes when there are no staged changes.'),
    false,
  ),
  bool(
    meta('git', 'Sync', 'git.autofetch', 'Auto Fetch', 'Fetch from the remote periodically.'),
    false,
  ),
  num(
    meta('git', 'Sync', 'git.autofetchPeriod', 'Auto Fetch Period', 'Seconds between automatic fetches.'),
    180, { min: 10, max: 3600, step: 10, unit: 's' },
  ),
  bool(
    meta('git', 'Sync', 'git.confirmSync', 'Confirm Sync', 'Ask for confirmation before synchronizing.'),
    true,
  ),

  // ============================== AI & AGENT ===============================
  bool(
    meta('ai', 'Chat', 'ai.chat.sendWithEnter', 'Send With Enter',
      'Enter sends the message and Shift+Enter inserts a new line. When off, Ctrl+Enter sends.'),
    true,
  ),
  bool(
    meta('ai', 'Chat', 'ai.chat.includeActiveFile', 'Include Active File',
      'Add the file open in the editor to the context of each message.'),
    true,
  ),
  bool(
    meta('ai', 'Agent', 'ai.tools.confirmBeforeRun', 'Confirm Before Running Tools',
      'Ask before the agent runs terminal commands or edits files.'),
    true,
  ),
  bool(
    meta('ai', 'Engine', 'ai.engine.unloadWhenIdle', 'Unload When Idle',
      'Unload the local model after a period of inactivity to free VRAM.', ['vram', 'memory']),
    true,
  ),
  num(
    meta('ai', 'Engine', 'ai.engine.idleTimeoutMinutes', 'Idle Timeout',
      'Minutes of inactivity before the local model is unloaded.'),
    10, { min: 1, max: 240, step: 1, unit: 'min' },
  ),

  // ============================= APPLICATION ===============================
  num(
    meta('application', 'Window', 'window.zoomLevel', 'Zoom Level',
      'Zoom level of the window. 0 is 100%, each step is about 20%.'),
    0, { min: -3, max: 5, step: 0.5 },
  ),
  pick(
    meta('application', 'Window', 'window.confirmBeforeClose', 'Confirm Before Close',
      'Ask for confirmation before closing the application.'),
    'never',
    [opt('never', 'Never'), opt('keyboardOnly', 'Keyboard only'), opt('always', 'Always')],
    'segmented',
  ),
  bool(
    meta('application', 'Window', 'application.restoreWindowState', 'Restore Window State',
      'Reopen the window with its previous size and position.'),
    true,
  ),
];
