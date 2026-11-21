# Models, Secrets, and Diagnostics

## 1. Purpose and ownership

Angular owns model configuration and writes the `models.registry` and
`models.defaultModel` settings through `SettingsService`; Rust owns API secrets
in the OS keychain and owns the local-model diagnostic process.
Angular also owns in-memory editor/build diagnostics in `DiagnosticsService`.
See [settings registry](../../src/app/feature/setting/settings.registry.ts:262),
[ModelsSettings](../../src/app/feature/setting/model-setting/models-settings.ts:12),
[secrets.rs](../../src-tauri/src/commands/secrets.rs:13), and

## 2. Data shapes

| Rust | Angular | Difference |
|---|---|---|
| No Rust model type | `ModelEntry`: `id`, `type`, `contextLimit`, optional local/API fields | Rust has no registry type; model command details are in [settings](./settings.md). |
| Model command arguments | `ModelEntry` local fields; `ModelDraft` has editable values | See [settings](./settings.md). |
| Secret command arguments | `apiKeyRef?: string` contains `model:<id>`; secret value is not stored in JSON | See [settings](./settings.md). |
| No Rust `Problem` type in `diagnostics.rs` | `ProblemInput`, `Problem`, `Severity`; `Severity = error|warning|info` | Angular diagnostics are a separate in-memory data structure, not IPC records. |

`ModelEntry` is exactly the TypeScript interface in
[model-entry.model.ts](../../src/app/feature/setting/model-setting/model-entry.model.ts:1).
`ModelDraft` is the component-only edit shape
[models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:17).
Settings values are `SettingValue`
[settings.registry.ts](../../src/app/feature/setting/settings.registry.ts:7).

## 3. Rust

### Services

Model and secret command implementation details are documented in
[settings](./settings.md). There is no dedicated Rust diagnostics service.

### Commands

Model and secret command details: see [settings](./settings.md).

| Command | Args in camelCase | Returns |
|---|---|---|
### Events

No model, secret, diagnostic, or log-level event is emitted. Model configuration
is persisted through SettingsService signals; API-key operations have no event
payload [models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:150).

## 4. Angular

### API wrappers

There is no generated or dedicated API wrapper. `ModelsSettings` invokes the
model and secret commands documented in [settings](./settings.md).
No dedicated Angular API class is identified.

### Stores and signals

No `setting.store.ts` file exists in the workspace. `SettingsService` owns
private `userValues` and `workspaceValues` signals and exposes computed effective
values [settings.service.ts](../../src/app/feature/setting/settings.service.ts:20).
`ModelsSettings` exposes `models`, `defaultModel`, `draft`, `apiKey`,
`savedSecret`, `formError`, `busy`, and test-message signals
[models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:14).
`DiagnosticsService` owns `problems`, `counts`, and `revealRequest` computed/signals
[diagnostics.service.ts](../../src/app/core/services/diagnostics.service.ts:17).

### Facade/service methods

| Method/signature | What it calls | Errors handled |
|---|---|---|
| `SettingsService.get<T>(key): Signal<T>` / `select` | effective settings map | unknown-key throws in `definition` |
| `SettingsService.set(key,raw,scope?)` / `reset` | validation and debounced file write | invalid value or scope throws `TypeError`/`Error` |
| `SettingsService.load()` / `reloadWorkspace(root?)` | app-data/workspace JSON; atomic writes | read failures fall back to `{}` |
| `ModelsSettings.saveModel(): Promise<void>` | secret invoke calls, `SettingsService.set` | catches and sets `formError` |
| `ModelsSettings.remove(...)` / `testConnection(...)` | secret, model test, or fetch | catches and sets UI error/test state |
| `DiagnosticsService.set/syncOwners/clear/reveal` | local signal updates | no IPC/error handling |

## 5. Main flows

**Save API model**
UI `saveModel` validates the draft, calls `secret_set` or migrates the secret,
builds `ModelEntry`, writes `models.registry`, and may set `models.defaultModel`
[models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:124).
The SettingsService updates a signal immediately and debounces an app-data write
[settings.service.ts](../../src/app/feature/setting/settings.service.ts:36).
Rust `secret_*` commands read/write the `cairn-ide:model:<id>` keyring entry;
no Tauri event is emitted.

**Remove model**
UI calls `secret_delete` when `apiKeyRef` exists, filters the registry, updates
the registry/default setting, and adjusts open state
[models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:205).
`SettingsService` persists the updated registry; no Rust event is emitted.

**Test local model**
UI calls `invoke('model_test_local')` with camelCase args
[models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:228).
Rust validates the GGUF file and executes `llama-cli` for up to 90 seconds
[models.rs](../../src-tauri/src/commands/models.rs:18).
It returns text or a plain `String` error; UI stores it in `testMessages`.

**Test API model**
UI reads the secret with `secret_get`, validates/composes an OpenAI-compatible
`/chat/completions` URL, performs `fetch`, and stores success/error
[models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:237).
Rust only supplies the key; Angular performs the HTTP request.

**Publish Angular diagnostics**
Producer calls `DiagnosticsService.set` or `syncOwners`; the service updates
`byOwner`, recomputes `problems/counts`, and reveal can set `revealRequest`
[diagnostics.service.ts](../../src/app/core/services/diagnostics.service.ts:27).
No Rust event or Rust diagnostics command participates.

## 6. Gaps

- No Rust model/service type or Rust settings reader is implemented for models.
- No dedicated Angular model API wrapper or store exists.
- `models.registry` is a JSON string in a generic setting rather than a typed Rust
  wire model   [models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:290).
- Secret migration, API testing, local testing, and model parsing are split across
  component and direct Tauri/fetch calls.
- `traceModelCalls` and `modelPerSkill` are defined but planned
  [settings.registry.ts](../../src/app/feature/setting/settings.registry.ts:272).
- Angular diagnostics have no Rust producer contract or event bridge.
- `model_test_local` has no test in this scope; unverified.
- Keyring behavior across unavailable systems/platforms is unverified.
- Rust command errors are plain `String`, not structured `{code,message}`.

## 7. Logic in the wrong layer

| Path:line | Finding |
|---|---|
| [models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:124) | Save validation, key migration/deletion, entry construction, and registry writes belong in a model/service facade. |
| [models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:222) | API key retrieval and HTTP endpoint/testing logic belongs in a model service, not the settings component. |
| [models-settings.ts](../../src/app/feature/setting/model-setting/models-settings.ts:290) | JSON parsing/default normalization belongs in a model service or typed settings parser. |
| [models.rs](../../src-tauri/src/commands/models.rs:18) | GGUF validation, process spawning, polling, timeout, and kill logic belongs in a Rust model service. |
| [secrets.rs](../../src-tauri/src/commands/secrets.rs:13) | Keyring entry validation and secret lifecycle logic belongs in a Rust secrets service. |
