// ═══════════ 1. global styles (src/styles.css): Monaco's DOM is outside Angular's component styles ═══════════
//   .git-blame-inline {
//     margin-left: 3em;
//     color: #5c6370;
//     font-style: italic;
//     white-space: pre;
//     cursor: default;
//   }

// ═══════════ 2. app-commands.ts ═══════════
//   const blame = inject(GitBlameService);
//   commands.register('git.toggleBlame', () => blame.toggle());

// ═══════════ 3. default-keybindings.json ═══════════
//   { "key": "mod+alt+b", "command": "git.toggleBlame" }

// ═══════════ 4. Tauri: nothing to change. `stdin` is a new OPTIONAL argument of git_run. ═══════════
