/** One entry of keybindings.json. */
export interface Keybinding {
  /** e.g. "mod+shift+f". `mod` = Ctrl on Windows/Linux, Cmd on macOS. Empty string = unbind. */
  key: string;
  /** Command id, e.g. "file.save". */
  command: string;
  /**
   * Optional context condition, e.g. "explorerFocus", "!editorFocus", "a && b".
   * Omitted = global (works anywhere). This is how local shortcuts will be added later.
   */
  when?: string;
  /** Optional argument passed to the command handler. */
  args?: unknown;
}

// ───────────── key naming ─────────────
// Canonical form: modifiers in the fixed order ctrl, alt, shift, meta, then the key, lowercase.
//   "ctrl+shift+f"   "ctrl+tab"   "alt+up"   "f2"   "ctrl+="

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';
interface Mods { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

const MODIFIER_ALIASES: Record<string, Modifier | 'mod'> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta',
  mod: 'mod',
};

/** KeyboardEvent.code -> canonical key name */
const NAMED_KEYS: Record<string, string> = {
  Escape: 'esc', Enter: 'enter', Tab: 'tab', Space: 'space', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
const PUNCTUATION: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  IntlBackslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};
/** What users may type in the JSON -> canonical key name */
const KEY_ALIASES: Record<string, string> = {
  escape: 'esc', del: 'delete', ins: 'insert', return: 'enter',
  pgup: 'pageup', pgdn: 'pagedown',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};

const VALID_KEYS = new Set<string>([
  ...Object.values(NAMED_KEYS),
  ...Object.values(PUNCTUATION),
]);
const isValidKey = (k: string): boolean =>
  VALID_KEYS.has(k) || /^[a-z0-9]$/.test(k) || /^f([1-9]|1\d|2[0-4])$/.test(k);

const build = (m: Mods, key: string): string =>
  [m.ctrl && 'ctrl', m.alt && 'alt', m.shift && 'shift', m.meta && 'meta', key].filter(Boolean).join('+');

/**
 * "Mod+Shift+F" -> "ctrl+shift+f" (or "meta+shift+f" on macOS).
 * Returns null if the text isn't a valid single-step shortcut (chords like "ctrl+k ctrl+s" are not supported yet).
 */
export function parseKeyString(text: string, isMac: boolean): string | null {
  const mods: Mods = { ctrl: false, alt: false, shift: false, meta: false };
  let key: string | null = null;

  for (const raw of text.toLowerCase().split('+')) {
    const part = raw.trim();
    if (!part) continue;
    const mod = MODIFIER_ALIASES[part];
    if (mod) {
      mods[mod === 'mod' ? (isMac ? 'meta' : 'ctrl') : mod] = true;
    } else {
      if (key) return null; // two non-modifier keys
      key = KEY_ALIASES[part] ?? part;
    }
  }
  return key && isValidKey(key) ? build(mods, key) : null;
}

/**
 * Key name of a keydown event, or null for keys we don't bind (bare modifiers, numpad, media keys...).
 *  - Letters follow the active layout, but fall back to the physical key on non-Latin layouts,
 *    so Ctrl+S still works when the keyboard is set to Russian, Greek, Arabic, etc.
 *  - Digits and punctuation use the physical key so Shift doesn't change the name (Shift+1 is "1", not "!").
 */
export function keyFromEvent(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) {
    const k = e.key.toLowerCase();
    return /^[a-z]$/.test(k) ? k : code.slice(3).toLowerCase();
  }
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code.toLowerCase();
  return NAMED_KEYS[code] ?? PUNCTUATION[code] ?? null;
}

export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyFromEvent(e);
  return key ? build({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }, key) : null;
}

/** "ctrl+shift+f" -> "Ctrl+Shift+F" (for menus and tooltips). */
export function formatCombo(combo: string, isMac: boolean): string {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'alt') return isMac ? 'Option' : 'Alt';
      if (p === 'shift') return 'Shift';
      if (p === 'meta') return isMac ? 'Cmd' : 'Win';
      if (p === 'esc') return 'Esc';
      if (p === 'pageup') return 'PageUp';
      if (p === 'pagedown') return 'PageDown';
      return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    })
    .join('+');
}

/**
 * Defaults + the user's overrides. Per command: if the user lists a command, the default
 * bindings of that command are replaced by theirs. An entry with an empty key just unbinds it.
 */
export function mergeKeybindings(defaults: Keybinding[], user: Keybinding[]): Keybinding[] {
  const overridden = new Set(user.map((b) => b.command));
  return [...defaults.filter((b) => !overridden.has(b.command)), ...user.filter((b) => b.key.trim())];
}
