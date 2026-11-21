# LSP

## 1. Purpose and ownership

The LSP bridge lets Monaco use external language servers. Rust owns process
and stdio transport state: it spawns/kills servers and frames JSON-RPC.
Angular owns server selection, settings, JSON-RPC sessions, Monaco providers,
and UI-facing diagnostics/log state. Rust does not parse JSON-RPC; Angular
does. [Rust bridge](../../src-tauri/src/commands/lsp.rs:3), [manager](../../src/app/core/services/lsp/lsp-manager.service.ts:12),
[client](../../src/app/core/services/lsp/lsp-client.ts:61)

## 2. Data shapes

| Rust | TypeScript | Difference |
|---|---|---|
| `LspEvent` enum: `{ event: "message", data: String }`, `{ event: "stderr", data: String }`, or `{ event: "exit", data: i32 \| null }` (`#[serde(rename_all = "camelCase")]`) | `LspEvent` union with the same three discriminated shapes | Names match; Rust field `i32` maps to `number \| null` in TypeScript. [Rust](../../src-tauri/src/commands/lsp.rs:24), [TypeScript](../../src/app/core/services/lsp/lsp-client.ts:12) |
| `LspHandle`: `stdin: Arc<Mutex<ChildStdin>>`, optional oneshot kill sender | internal TypeScript only: `serverId`, send chain, pending requests, document and capability maps | Rust state is process handles; TypeScript state is an LSP session. [Rust](../../src-tauri/src/commands/lsp.rs:35), [TypeScript](../../src/app/core/services/lsp/lsp-client.ts:64) |
| `LspState`: ID -> `LspHandle` | No Rust-equivalent API type | Managed by Tauri and registered under `LspState`. [Rust](../../src-tauri/src/commands/lsp.rs:40), [registration](../../src-tauri/src/lib.rs:27) |
| No Rust struct | `LspServerConfig`: `id`, `languages`, `command`, `args`, optional `npm`, `enabled` | Entirely Angular configuration. [TypeScript](../../src/app/core/services/lsp/lsp-servers.ts:7) |
| No Rust struct | `ServerStatus` and `ServerState` include monitor status, timestamps, capabilities and document count | UI-owned status, not persisted or returned by Rust. [TypeScript](../../src/app/core/services/lsp/lsp-monitor.service.ts:8), [TypeScript](../../src/app/core/services/lsp/lsp-monitor.service.ts:20) |
| No Rust diagnostic type | `FileDiagnostic`/`FileDiagnostics` mirror Monaco-facing data, with 1-based positions | Converted from `vscode-languageserver-types` in Angular. [TypeScript](../../src/app/core/services/lsp/lsp-monitor.service.ts:31), [TypeScript](../../src/app/core/services/lsp/lsp-monitor.service.ts:48) |

## 3. Rust

### Service functions

There is no Rust LSP service module; `src-tauri/src/commands/lsp.rs` contains
the implementation directly.

### Commands

- `lsp_start(command, args, cwd, onEvent)` -> `Promise<string>`: spawns a process,
  stores stdin/kill state, starts stdout/stderr/exit tasks, and returns a UUID.
  Errors are plain strings such as spawn or missing stdin/stdout/stderr failures.
  [implementation](../../src-tauri/src/commands/lsp.rs:43), [args](../../src-tauri/src/commands/lsp.rs:44)
- `lsp_send(id, message)` -> `Promise<void>`: looks up the server, writes a
  `Content-Length` frame to stdin, and flushes. Unknown IDs return
  `"unknown language server"`; pipe/write/flush errors are plain strings.
  [implementation](../../src-tauri/src/commands/lsp.rs:105)
- `lsp_stop(id)` -> `Promise<void>`: removes the handle and sends its oneshot
  kill signal. Unknown or already stopped IDs are currently successful no-ops.
  [implementation](../../src-tauri/src/commands/lsp.rs:134)

All three commands are registered in `lib.rs`. [registration](../../src-tauri/src/lib.rs:65)

### Events emitted

These are Tauri `Channel` events, not broadcast Tauri events:

- `message`: one complete de-framed JSON-RPC body. [Rust](../../src-tauri/src/commands/lsp.rs:26), [send](../../src-tauri/src/commands/lsp.rs:171)
- `stderr`: one stderr line. [Rust](../../src-tauri/src/commands/lsp.rs:30), [send](../../src-tauri/src/commands/lsp.rs:179)
- `exit`: process exit code, or `null` after a kill/unknown status.
  [Rust](../../src-tauri/src/commands/lsp.rs:32), [send](../../src-tauri/src/commands/lsp.rs:98)

## 4. Angular

### API wrapper

`LspClient` is the direct Tauri/JSON-RPC wrapper. `doStart()` invokes
`lsp_start`; `send()` chains invokes to `lsp_send`; `stop()` invokes
`lsp_stop`. Start can reject with plain strings/`Error`; request failures are
rejected or suppressed by `requestSafe()`, and send failures are logged.
[start](../../src/app/core/services/lsp/lsp-client.ts:103),
[stop](../../src/app/core/services/lsp/lsp-client.ts:181),
[send](../../src/app/core/services/lsp/lsp-client.ts:469)

### Stores/signals

`LspMonitor` is the LSP signal store. It exposes `servers`, `serverList`,
`diagnosticsByFile`, `filesWithProblems`, `events`, `logs`, `totals`, and
`diagnosticsFor(uri)`. `track(config)` creates a run-scoped handle and updates
server status, lifecycle events, diagnostics, and logs. Stale run handles are
ignored. [signals](../../src/app/core/services/lsp/lsp-monitor.service.ts:83),
[track](../../src/app/core/services/lsp/lsp-monitor.service.ts:126)

### Services/facades

- `LspManager.init()` initializes Monaco listeners and providers; model create
  triggers attach and model disposal triggers detach. It also restarts clients
  when settings or workspace root change. [init](../../src/app/core/services/lsp/lsp-manager.service.ts:59),
  [attach/detach](../../src/app/core/services/lsp/lsp-manager.service.ts:80)
- `LspClient` owns JSON-RPC requests/notifications, handshake, document sync,
  Monaco providers, cancellation, and server-request handling.
- `LspMonitor.track()` is the status/store facade used by `LspClient`.
- `LspBridgeService` maps monitor signals into the Output and Problems surfaces;
  it has no error-recovery API. [bridge](../../src/app/core/services/lsp/lsp-bridge.service.ts:28)

## 5. Main flows

**Model open**

Monaco model created -> `CodeEditor`/`LspManager` calls `init` ->
`LspManager.attach(model)` -> `configForLanguage` -> `ensureClient` ->
`new LspClient` + `track` -> `LspClient.start` -> `invoke("lsp_start",...)`
-> Rust spawn and Channel -> initialize JSON-RPC via `lsp_send` ->
`LspMonitor.ready` -> Monaco providers -> `openDocument` sends didOpen.
[UI caller](../../src/app/feature/editor/features/code-editor.component.ts:101),
[manager](../../src/app/core/services/lsp/lsp-manager.service.ts:64),
[client](../../src/app/core/services/lsp/lsp-client.ts:116)

**Edit**

Monaco content change -> `LspClient.onChange` -> conversion to LSP range/text
-> didChange JSON-RPC -> chained `invoke("lsp_send")` -> Rust
`Content-Length` frame -> server stdout later returns a Channel `message`.
[change](../../src/app/core/services/lsp/lsp-client.ts:204),
[send](../../src/app/core/services/lsp/lsp-client.ts:469)

**Diagnostics**

Server notification -> Rust Channel `message` -> `LspClient.handleMessage`
-> `handleNotification("textDocument/publishDiagnostics")` ->
`LspMonitor.diagnostics` -> `LspMonitor` signal update -> Monaco markers and
`LspBridgeService` Problems sync. [notification](../../src/app/core/services/lsp/lsp-client.ts:531),
[bridge](../../src/app/core/services/lsp/lsp-bridge.service.ts:45)

**Idle stop/restart**

Last document closed -> manager timer (60 s) -> `stopClient` ->
`LspClient.stop` -> shutdown/exit notifications -> `invoke("lsp_stop")`
-> Rust removes handle and sends kill -> Channel `exit` -> Rust state removal.
Settings/workspace changes instead call `restartServer`/`restartAll`.
[idle](../../src/app/core/services/lsp/lsp-manager.service.ts:98),
[stop](../../src/app/core/services/lsp/lsp-client.ts:181)

## 6. Gaps

- No Rust LSP service: process transport, framing, and state live in commands.
- Server stderr is handled by `console.debug` in `LspClient`; it is not sent
  to `LspServerHandle.log`. [client](../../src/app/core/services/lsp/lsp-client.ts:105)
- `LspClient.stop()` calls `mon.stopping()` but never `mon.stopped()`; the
  monitor can remain at `stopping`. [client](../../src/app/core/services/lsp/lsp-client.ts:181)
- `lsp_stop` on an unknown ID is unverified to behave consistently across
  races; code returns `Ok(())` for every missing handle.
- End-to-end behavior with real installed servers and Windows `.cmd` resolution
  is unverified in this code pass.
- No structured LSP error type: Rust returns plain strings and Angular
  normalizes some failures ad hoc.
- The line/column offset constants are hard-coded to zero; the comments mark
  their real behavior as something needing visual verification.
  [bridge](../../src/app/core/services/lsp/lsp-bridge.service.ts:13)
- `LspMonitor.exited()` always records `crashed` even if exit happens after
  a stop, but `LspClient.handleExit` ignores exit when `stopped`.
  [monitor](../../src/app/core/services/lsp/lsp-monitor.service.ts:184),
  [client](../../src/app/core/services/lsp/lsp-client.ts:168)

## 7. Logic in the wrong layer

| File:line | What it does | Where it belongs |
|---|---|---|
| `src-tauri/src/commands/lsp.rs:43-102` | `lsp_start` owns process spawning, Windows flags, stdin/stdout/stderr extraction, process registry insertion, async read/exit tasks, and kill waiting. | A Rust LSP process/service module; command should only validate arguments and delegate. |
| `src-tauri/src/commands/lsp.rs:105-143` | `lsp_send` and `lsp_stop` contain transport lookup, Content-Length framing, pipe writes, and kill-signal lifecycle policy. | A Rust LSP service/module with command functions reduced to argument/result plumbing. |
| `src-tauri/src/commands/lsp.rs:145-185` | `read_loop` and `stderr_loop` implement stdout framing and stderr draining in the command module. | A Rust LSP transport service/module used through a service handle. |
