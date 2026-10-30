import { Injectable, NgZone, inject } from '@angular/core';
// Put default-keybindings.json in src/assets and adjust this relative path to where this file lives.
import defaultBindings from '../../../../assets/default-keybindings.json';
import { CommandService } from './command.service';
import {
  Keybinding,
  comboFromEvent,
  formatCombo,
  mergeKeybindings,
  parseKeyString,
} from './keybinding.model';

interface ResolvedBinding {
  combo: string;
  command: string;
  when?: string;
  args?: unknown;
}

/**
 * One keydown listener for the whole window.
 *
 * It listens in the CAPTURE phase, so it runs before Monaco or any input sees the key. When a
 * shortcut matches, the event is cancelled, which also stops the WebView's own handling
 * (Ctrl+S "save page", Ctrl+P "print", Ctrl+O "open file", ...).
 * These are shortcuts for THIS window, not OS-wide hotkeys.
 */
@Injectable({ providedIn: 'root' })
export class KeybindingService {
  private readonly zone = inject(NgZone);
  private readonly commands = inject(CommandService);

  private readonly isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  private table = new Map<string, ResolvedBinding[]>(); // canonical combo -> bindings
  private readonly context = new Set<string>(); // active context keys, for `when`
  private started = false;

  /**
   * Call once at startup. `userBindings` is where settings-file overrides will plug in later.
   */
  init(userBindings: Keybinding[] = []): void {
    this.setBindings(mergeKeybindings(defaultBindings as Keybinding[], userBindings));
    if (this.started) return;
    this.started = true;
    // Outside Angular: a listener on every keydown must not trigger change detection each time.
    this.zone.runOutsideAngular(() =>
      window.addEventListener('keydown', this.onKeyDown, { capture: true }),
    );
  }

  /** Replace all bindings (e.g. after the user edits their settings). */
  setBindings(bindings: Keybinding[]): void {
    const table = new Map<string, ResolvedBinding[]>();
    for (const b of bindings) {
      const combo = parseKeyString(b.key, this.isMac);
      if (!combo) {
        console.warn(
          `Ignoring keybinding for '${b.command}': invalid or unsupported key "${b.key}"`,
        );
        continue;
      }
      const list = table.get(combo) ?? [];
      if (list.some((x) => (x.when ?? '') === (b.when ?? '') && x.command !== b.command)) {
        console.warn(
          `Keybinding conflict: "${b.key}" is bound to both '${b.command}' and another command.`,
        );
      }
      list.push({ combo, command: b.command, when: b.when, args: b.args });
      table.set(combo, list);
    }
    this.table = table;
  }

  /**
   * Context keys drive `when` conditions. Local shortcuts later = set a key when a region gains
   * focus and clear it on blur:  keys.setContext('explorerFocus', true)
   */
  setContext(key: string, on: boolean): void {
    on ? this.context.add(key) : this.context.delete(key);
  }

  /** "Ctrl+S" for showing next to menu items and tooltips; null if the command has no shortcut. */
  labelFor(command: string): string | null {
    for (const list of this.table.values()) {
      const hit = list.find((b) => b.command === command);
      if (hit) return formatCombo(hit.combo, this.isMac);
    }
    return null;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return; // IME in progress
    if (e.getModifierState('AltGraph')) return; // AltGr (Ctrl+Alt on Windows) is for typing characters

    const combo = comboFromEvent(e);
    const candidates = combo ? this.table.get(combo) : undefined;
    if (!combo || !candidates) return;

    // A bare key (no Ctrl/Alt/Cmd) while typing is just typing. Only F-keys and Esc stay active.
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (bare && !/^(f\d+|esc)$/.test(combo) && this.isEditable(e.target)) return;

    const binding = this.pick(candidates);
    if (!binding || !this.commands.has(binding.command)) return; // unhandled: leave the key alone

    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // holding the key down must not re-run the command

    this.zone.run(() => void this.commands.execute(binding.command, binding.args));
  };

  /** Among bindings for one key, the one whose `when` holds; a conditional binding beats an unconditional one. */
  private pick(candidates: ResolvedBinding[]): ResolvedBinding | undefined {
    return candidates
      .filter((b) => this.whenHolds(b.when))
      .sort((a, b) => (b.when ? 1 : 0) - (a.when ? 1 : 0))[0];
  }

  private whenHolds(when?: string): boolean {
    if (!when?.trim()) return true;
    return when.split('&&').every((term) => {
      const t = term.trim();
      return t.startsWith('!') ? !this.context.has(t.slice(1).trim()) : this.context.has(t);
    });
  }

  private isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  }
}
