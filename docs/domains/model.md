# Models, Secrets, and Diagnostics

## 1. Purpose and ownership

Angular owns model configuration and writes the `models.registry` and
`models.defaultModel` settings through `SettingsService`; Rust owns API secrets
in the OS keychain and owns the local-model diagnostic process.
Angular also owns in-memory editor/build diagnostics in `DiagnosticsService`.
The Rust log-level command applies logging policy to the Rust log plugin.
See [settings registry](../src/app/feature/setting/settings.registry.ts:262),
[ModelsSettings](../src/app/feature/setting/model-setting/models-settings.ts:12),
[secrets.rs](../src-tauri/src/commands/secrets.rs:13), and
[diagnostics.rs](../src-tauri/src/commands/diagnostics.rs:4).

## 2. Data shapes

| Rust | Angular | Difference |
|---|---|---|
| No Rust model type: `model_test_local` accepts scalar args | `ModelEntry`: `id`, `type`, `contextLimit`, optional local/API fields | Rust model test args are not a Rust `ModelEntry`; no Rust-side registry type exists. |
| `model_test_local(gguf_path: String, gpu_layers: u32, context_size: u32, threads: u32) -> Result<String,String>` | `ModelEntry` local fields; `ModelDraft` has editable values | camelCase IPC args; Rust snake_case names are Tauri-mapped to camelCase. |
| `secret_set(id:String,value:String)`, `secret_get(id:String) -> String`, `secret_delete(id:String) -> ()` | `apiKeyRef?: string` contains `model:<id>`; secret value is not stored in JSON | only the reference is in model settings; key value stays in OS keychain. |
| `set_log_level(level:String) -> Result<(),String>` | `diagnostics.logLevel: enum` is a string; `traceModelCalls` is planned | Rust receives an enum-like string and maps it to `LevelFilter`. |
| No Rust `Problem` type in `diagnostics.rs` | `ProblemInput`, `Problem`, `Severity`; `Severity = error|warning|info` | Angular diagnostics are a separate in-memory data structure, not IPC records. |

`ModelEntry` is exactly the TypeScript interface in
[model-entry.model.ts](../src/app/feature/setting/model-setting/model-entry.model.ts:1).
`ModelDraft` is the component-only edit shape
[models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:17).
Settings values are `SettingValue`
[settings.registry.ts](../src/app/feature/setting/settings.registry.ts:7).

## 3. Rust

### Services

There is no Rust model, secret, or log-level service. These operations are
implemented directly in Tauri command modules:

| Name | What it does | Errors |
|---|---|---|
| `test_local_model` | Validates a GGUF file, starts `llama-cli`, polls for 90 seconds | plain `Result<String,String>` errors for missing file/start/read/time-out/non-zero exit |
| `wait_for_model` | Polls child process status | plain `Result<bool,String>` read/status errors |
| `entry` | Validates and creates a keyring entry | plain `String`; empty id or keyring unavailable |

Unverified: whether a dedicated Rust model/service type should exist.
Functions are at [models.rs](../src-tauri/src/commands/models.rs:18),
[secrets.rs](../src-tauri/src/commands/secrets.rs:5).

### Commands

| Command | Args in camelCase | Returns |
|---|---|---|
| `model_test_local` | `ggufPath`, `gpuLayers`, `contextSize`, `threads` | `String` success text or `String` error |
| `secret_set` | `id`, `value` | `()` or `String` error |
| `secret_get` | `id` | secret `String` or `String` error |
| `secret_delete` | `id` | `()` or `String` error |
| `set_log_level` | `level` | `()` or `String` error |

Registration is [lib.rs](../src-tauri/src/lib.rs:68) and
[lib.rs](../src-tauri/src/lib.rs:139).
Secret argument shape comes from [secrets.rs](../src-tauri/src/commands/secrets.rs:13).

### Events

No model, secret, diagnostic, or log-level event is emitted. Model configuration
is persisted through SettingsService signals; API-key operations have no event
payload [models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:150).

## 4. Angular

### API wrappers

There is no generated or dedicated API wrapper. `ModelsSettings` calls Tauri
`invoke` directly: `secret_set`, `secret_get`, `secret_delete`, and
`model_test_local` [models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:150).
`SettingsRuntimeService` calls `invoke('set_log_level',...)` directly
[settings-runtime.service.ts](../src/app/core/services/settings-runtime.service.ts:34).
No dedicated Angular API class is identified.

### Stores and signals

No `setting.store.ts` file exists in the workspace. `SettingsService` owns
private `userValues` and `workspaceValues` signals and exposes computed effective
values [settings.service.ts](../src/app/feature/setting/settings.service.ts:20).
`ModelsSettings` exposes `models`, `defaultModel`, `draft`, `apiKey`,
`savedSecret`, `formError`, `busy`, and test-message signals
[models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:14).
`DiagnosticsService` owns `problems`, `counts`, and `revealRequest` computed/signals
[diagnostics.service.ts](../src/app/core/services/diagnostics.service.ts:17).

### Facade/service methods

| Method/signature | What it calls | Errors handled |
|---|---|---|
| `SettingsService.get<T>(key): Signal<T>` / `select` | effective settings map | unknown-key throws in `definition` |
| `SettingsService.set(key,raw,scope?)` / `reset` | validation and debounced file write | invalid value or scope throws `TypeError`/`Error` |
| `SettingsService.load()` / `reloadWorkspace(root?)` | app-data/workspace JSON; atomic writes | read failures fall back to `{}` |
| `SettingsRuntimeService` constructor effect | `set_log_level` invoke | catches invoke failure and logs warning |
| `ModelsSettings.saveModel(): Promise<void>` | secret invoke calls, `SettingsService.set` | catches and sets `formError` |
| `ModelsSettings.remove(...)` / `testConnection(...)` | secret, model test, or fetch | catches and sets UI error/test state |
| `DiagnosticsService.set/syncOwners/clear/reveal` | local signal updates | no IPC/error handling |

## 5. Main flows

**Save API model**
UI `saveModel` validates the draft, calls `secret_set` or migrates the secret,
builds `ModelEntry`, writes `models.registry`, and may set `models.defaultModel`
[models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:124).
The SettingsService updates a signal immediately and debounces an app-data write
[settings.service.ts](../src/app/feature/setting/settings.service.ts:36).
Rust `secret_*` commands read/write the `cairn-ide:model:<id>` keyring entry;
no Tauri event is emitted.

**Remove model**
UI calls `secret_delete` when `apiKeyRef` exists, filters the registry, updates
the registry/default setting, and adjusts open state
[models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:205).
`SettingsService` persists the updated registry; no Rust event is emitted.

**Test local model**
UI calls `invoke('model_test_local')` with camelCase args
[models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:228).
Rust validates the GGUF file and executes `llama-cli` for up to 90 seconds
[models.rs](../src-tauri/src/commands/models.rs:18).
It returns text or a plain `String` error; UI stores it in `testMessages`.

**Test API model**
UI reads the secret with `secret_get`, validates/composes an OpenAI-compatible
`/chat/completions` URL, performs `fetch`, and stores success/error
[models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:237).
Rust only supplies the key; Angular performs the HTTP request.

**Apply log level**
Settings signal changes; `SettingsRuntimeService` calls `set_log_level`
[settings-runtime.service.ts](../src/app/core/services/settings-runtime.service.ts:12).
Rust maps the string to `LevelFilter`; failures are warned in Angular
[diagnostics.rs](../src-tauri/src/commands/diagnostics.rs:4).

**Publish Angular diagnostics**
Producer calls `DiagnosticsService.set` or `syncOwners`; the service updates
`byOwner`, recomputes `problems/counts`, and reveal can set `revealRequest`
[diagnostics.service.ts](../src/app/core/services/diagnostics.service.ts:27).
No Rust event or Rust diagnostics command participates.

## 6. Gaps

- No Rust model/service type or Rust settings reader is implemented for models.
- No dedicated Angular model API wrapper or store exists.
- `models.registry` is a JSON string in a generic setting rather than a typed Rust
  wire model [models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:290).
- Secret migration, API testing, local testing, and model parsing are split across
  component and direct Tauri/fetch calls.
- `traceModelCalls` and `modelPerSkill` are defined but planned
  [settings.registry.ts](../src/app/feature/setting/settings.registry.ts:272).
- Angular diagnostics have no Rust producer contract or event bridge.
- `model_test_local` has no test in this scope; unverified.
- Keyring behavior across unavailable systems/platforms is unverified.
- Rust command errors are plain `String`, not structured `{code,message}`.

## 7. Logic in the wrong layer

| Path:line | Finding |
|---|---|
| [models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:124) | Save validation, key migration/deletion, entry construction, and registry writes belong in a model/service facade. |
| [models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:222) | API key retrieval and HTTP endpoint/testing logic belongs in a model service, not the settings component. |
| [models-settings.ts](../src/app/feature/setting/model-setting/models-settings.ts:290) | JSON parsing/default normalization belongs in a model service or typed settings parser. |
| [models.rs](../src-tauri/src/commands/models.rs:18) | GGUF validation, process spawning, polling, timeout, and kill logic belongs in a Rust model service. |
| [secrets.rs](../src-tauri/src/commands/secrets.rs:13) | Keyring entry validation and secret lifecycle logic belongs in a Rust secrets service. |
| [diagnostics.rs](../src-tauri/src/commands/diagnostics.rs:4) | Mapping strings to `LevelFilter` belongs in a diagnostics/logging service, not the command boundary. |
