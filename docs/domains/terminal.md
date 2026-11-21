# Terminal

## 1. Purpose and ownership

The integrated terminal owns live shell sessions and xterm display state. Rust
owns the PTY processes and session registry; Angular owns the visible Terminal
instances and session cache. [`PtyState`](/src-tauri/src/commands/pty.rs:38)
is managed by Tauri and [`TerminalService`](/src/app/feature/terminal/terminal.service.ts:136)
is provided at the Angular root.

## 2. Data shapes

| Rust | Angular / TypeScript | Difference |
|---|---|---|
| `PtyEvent::Data(String)` / `PtyEvent::Exit(Option<u32>)` | `PtyEvent = { event: 'data'; data: string } \| { event: 'exit'; data: number \| null }` | Rust uses the enum tag `event` and shared `data` field; TypeScript mirrors the serialized shape. Rust exit code is `u32`, while serialized Angular code is `number \| null`. |
| `PtySession { master, writer, killer }`; private and not serialized | `TerminalSession { id, title, exited, term, fit, element, ptyId?, opened, queue }` | Rust has live PTY handles; Angular adds local display/DOM state. There is no Rust public session record corresponding one-to-one to `TerminalSession`. |
| `PtyState(Arc<Mutex<HashMap<String, PtySession>>>)` | `sessions = signal<TerminalSession[]>([])`, `activeId`, `activeSession` | Rust maps PTY id to live handles; Angular caches display sessions and does not persist them. |

The Rust enum and TypeScript union are at
[`pty.rs:24-27`](/src-tauri/src/commands/pty.rs:24) and
[`terminal.service.ts:7-8`](/src/app/feature/terminal/terminal.service.ts:7).
The private Rust session and public Angular session are at
[`pty.rs:31-38`](/src-tauri/src/commands/pty.rs:31) and
[`terminal.service.ts:11-23`](/src/app/feature/terminal/terminal.service.ts:11).

## 3. Rust

### Service functions

There is no dedicated terminal Rust service in the inspected terminal row.
The PTY operations are implemented directly in command functions in
[`pty.rs`](/src-tauri/src/commands/pty.rs).

### Commands

| Command | Arguments (camelCase) | Return |
|---|---|---|
| `pty_spawn` | `cwd`, `shell`, `args`, `cols`, `rows`, `onEvent` | `Result<String, String>`: PTY id |
| `pty_write` | `id`, `data` | `Result<(), String>` |
| `pty_resize` | `id`, `cols`, `rows` | `Result<(), String>` |
| `pty_kill` | `id` | `Result<(), String>` |

The signatures are in [`pty.rs:53-60`](/src-tauri/src/commands/pty.rs:53),
[`pty.rs:151-151`](/src-tauri/src/commands/pty.rs:151),
[`pty.rs:162-168`](/src-tauri/src/commands/pty.rs:162), and
[`pty.rs:182-182`](/src-tauri/src/commands/pty.rs:182). All four are registered
in [`lib.rs:72-75`](/src-tauri/src/lib.rs:72); `PtyState` is registered at
[`lib.rs:28`](/src-tauri/src/lib.rs:28).

Errors are plain `String`: PTY open/start failure, poisoned state, unknown
terminal, write/flush failure, and resize failure
([`pty.rs:62-92`](/src-tauri/src/commands/pty.rs:62),
[`pty.rs:151-178`](/src-tauri/src/commands/pty.rs:151)).

### Events

PTY output and exit use one Tauri `Channel<PtyEvent>` passed as `onEvent`, not
broadcast Tauri events ([`pty.rs:60`](/src-tauri/src/commands/pty.rs:60)).
The payload is `{ event: "data", data: string }` or
`{ event: "exit", data: number | null }`
([`pty.rs:24-27`](/src-tauri/src/commands/pty.rs:24),
[`pty.rs:106-144`](/src-tauri/src/commands/pty.rs:106)).

## 4. Angular

### API wrapper and facade

There is no separate Angular API wrapper for this row. `TerminalService`
calls Tauri `invoke` and `Channel` directly
([`terminal.service.ts:136-181`](/src/app/feature/terminal/terminal.service.ts:136)).

- `create(cwd: string | null, shell?: string): Promise<TerminalSession>`: builds
  xterm state, invokes `pty_spawn`, adds the session, and makes it active
  ([`terminal.service.ts:173-193`](/src/app/feature/terminal/terminal.service.ts:173)).
- `activate(id: string): void`: sets `activeId`
  ([`terminal.service.ts:201-203`](/src/app/feature/terminal/terminal.service.ts:201)).
- `close(id: string): Promise<void>`: removes local state and invokes
  `pty_kill`; kill errors are ignored
  ([`terminal.service.ts:205-217`](/src/app/feature/terminal/terminal.service.ts:205)).
- `clearSessions(): void`: replaces the session list
  ([`terminal.service.ts:219-221`](/src/app/feature/terminal/terminal.service.ts:219)).
- `attach`, `detach`, `fit`: DOM/xterm presentation operations
  ([`terminal.service.ts:223-244`](/src/app/feature/terminal/terminal.service.ts:223)).
- Private `enqueue` chains `pty_write` and `pty_resize` calls and suppresses
  their errors ([`terminal.service.ts:311-313`](/src/app/feature/terminal/terminal.service.ts:311)).

### Store and component

There is no Angular store for the terminal. `sessions`, `activeId`, and
`activeSession` are signals in `TerminalService`
([`terminal.service.ts:142-146`](/src/app/feature/terminal/terminal.service.ts:142)).
The `Terminal` component renders sessions, activates and closes them
([`terminal.ts:207-260`](/src/app/feature/terminal/terminal.ts:207)).
`BottomPanel.createNewSession()` calls `TerminalService.create`
([`bottom-panel.ts:99-101`](/src/app/layout/panels/bottom-panel/bottom-panel.ts:99)).

## 5. Main flows

### Open or create a session

UI New Session button -> `BottomPanel.createNewSession()` ->
`TerminalService.create(rootPath)` -> `invoke('pty_spawn', { cwd, shell,
args, cols, rows, onEvent })` -> Rust opens PTY and stores `PtySession` ->
Tauri Channel sends `PtyEvent::Data/Exit` -> `TerminalService` writes xterm or
sets `exited` -> `sessions`/`activeId` signals update.
Verified call sites:
[`bottom-panel.html:51`](/src/app/layout/panels/bottom-panel/bottom-panel.html:51),
[`bottom-panel.ts:99-101`](/src/app/layout/panels/bottom-panel/bottom-panel.ts:99),
[`terminal.service.ts:173-193`](/src/app/feature/terminal/terminal.service.ts:173),
[`pty.rs:53-146`](/src-tauri/src/commands/pty.rs:53).

### Type, resize, and exit

UI keystroke/resize -> xterm callback -> `TerminalService.enqueue` ->
`invoke('pty_write')` / `invoke('pty_resize')` -> Rust mutates the live
PTY -> shell output returns through the Channel -> `TerminalService` writes
it to xterm.
Resize and data callbacks are
[`terminal.service.ts:279-287`](/src/app/feature/terminal/terminal.service.ts:279);
Rust writes/resizes are
[`pty.rs:151-178`](/src-tauri/src/commands/pty.rs:151).

### Close

UI close button -> `Terminal.close` -> `TerminalService.close` -> remove
Angular session first -> `invoke('pty_kill')` -> Rust removes and kills
the PTY session.
The UI call is [`terminal.ts:256-260`](/src/app/feature/terminal/terminal.ts:256),
and the Rust call is [`pty.rs:182-192`](/src-tauri/src/commands/pty.rs:182).

## 6. Gaps

- No dedicated Rust terminal service; PTY lifecycle currently lives in a command
  module ([`pty.rs`](/src-tauri/src/commands/pty.rs)).
- There is no terminal store, persisted session list, or broadcast event;
  state is service-owned and PTY event delivery is a per-session Channel
  ([`terminal.service.ts:142-146`](/src/app/feature/terminal/terminal.service.ts:142)).
- Create and write/resize errors are not normalized to structured service
  errors; they remain plain Tauri strings or are swallowed
  ([`pty.rs:151-192`](/src-tauri/src/commands/pty.rs:151),
  [`terminal.service.ts:311-313`](/src/app/feature/terminal/terminal.service.ts:311)).
- Shell availability and default-shell behavior vary by platform; Unix
  `SHELL` fallback and Windows `powershell.exe` are implemented, but end-to-end
  coverage outside the current Windows environment is unverified
  ([`pty.rs:40-48`](/src-tauri/src/commands/pty.rs:40)).
- A real shell session and all resize/write/exit behavior are unverified
  by this pass; source inspection is complete, runtime behavior is not.

## 7. Logic in the wrong layer

| Path:line | Finding | Reason |
|---|---|---|
| [`pty.rs:53-146`](/src-tauri/src/commands/pty.rs:53) | `pty_spawn` mixes argument plumbing with PTY creation, shell setup, session registration, output pumping, and exit waiting. | This lifecycle belongs in a Rust terminal/PTY service; commands should dispatch and return. |
| [`pty.rs:151-178`](/src-tauri/src/commands/pty.rs:151) | `pty_write` and `pty_resize` directly find and mutate live PTY state. | State lookup and PTY I/O belong in a Rust terminal/PTY service. |
| [`pty.rs:182-192`](/src-tauri/src/commands/pty.rs:182) | `pty_kill` directly removes a session and invokes the child killer. | Kill/session cleanup belongs in a Rust terminal/PTY service. |
