# Settings and models

## 1. Purpose and ownership

Angular owns settings and model configuration. `SettingsService` reads and writes
the user and workspace JSON files and merges them with registry defaults
[settings.service.ts:1](../../src/app/feature/setting/settings.service.ts#L1).
Rust has no general settings service; its run model broker reads a snapshot of
the user model registry, while settings writes remain Angular-owned. Rust also
receives log-level changes and provides model/secret commands
[models.rs:8](../../src-tauri/src/commands/models.rs#L8),
[secrets.rs:12](../../src-tauri/src/commands/secrets.rs#L12),
[diagnostics.rs:3](../../src-tauri/src/commands/diagnostics.rs#L3).

User settings live under app data; workspace settings live at
`.cairn/settings.json`. Workspace values override user values, then registry
defaults [settings.service.ts:17](../../src/app/feature/setting/settings.service.ts#L17),
[settings.service.ts:83](../../src/app/feature/setting/settings.service.ts#L83).
API keys are secrets in the OS keychain under service `cairn-ide`, referenced
by `model:<id>`; they are not JSON settings
[secrets.rs:3](../../src-tauri/src/commands/secrets.rs#L3),
[models-settings.ts:145](../../src/app/feature/setting/model-setting/models-settings.ts#L145).

## 2. Data shapes

| Rust | TypeScript |
|---|---|
| No settings Rust type or service struct exists. | `SettingDef`: `key`, `type`, `default`, `scope`, `section`, `label`, `description`, `options?`, `status`, `subsection?` [settings.registry.ts:12](../../src/app/feature/setting/settings.registry.ts#L12). |
| No general Rust settings type; `models::Registry` reads user settings for runs. | `SettingValue = boolean \| number \| string \| string[] \| Record<string, unknown>` and `StoredValues = Record<string, SettingValue>` [settings.registry.ts:9](../../src/app/feature/setting/settings.registry.ts#L9), [settings.service.ts:16](../../src/app/feature/setting/settings.service.ts#L16). |
| Rust `services/models::ModelEntry` and `Registry`. | `ModelEntry`: `id`, `type ('local'\|'api')`, `contextLimit`, optional `ggufPath`, `gpuLayers`, `contextSize`, `threads`, `sampling`, `provider`, `baseUrl`, `modelName`, `apiKeyRef` [model-entry.model.ts:1](../../src/app/feature/setting/model-setting/model-entry.model.ts#L1). |

`models.registry` is a string setting whose JSON payload is an array of
`ModelEntry`; `models.defaultModel` is a string setting
[settings.registry.ts:174](../../src/app/feature/setting/settings.registry.ts#L174),
[settings.registry.ts:175](../../src/app/feature/setting/settings.registry.ts#L175).
The Rust model command accepts scalar camelCase arguments and is not passed a
`ModelEntry` [models.rs:9](../../src-tauri/src/commands/models.rs#L9).

## 3. Rust

### Service functions

`services/models` reads the user settings registry at `run_start` and serves
read-only model listing/completion to that run's RPC context. It does not write
settings. `test_local_model` validates a GGUF path and spawns `llama-cli`;
`wait_for_model` polls for exit or timeout
[models.rs:18](../../src-tauri/src/commands/models.rs#L18),
[models.rs:51](../../src-tauri/src/commands/models.rs#L51).
`entry` creates the keyring entry and rejects an empty id
[secrets.rs:5](../../src-tauri/src/commands/secrets.rs#L5).
There is no general settings service function.

### Commands

| Name | Args in camelCase | Return | Errors |
|---|---|---|---|
| `model_test_local` | `ggufPath: String`, `gpuLayers: u32`, `contextSize: u32`, `threads: u32` | `String` | Plain `String`: missing file, spawn failure, timeout, process failure, blocking-task failure [models.rs:9](../../src-tauri/src/commands/models.rs#L9). |
| `secret_set` | `id: String`, `value: String` | `()` | Empty id/keyring unavailable/save failure [secrets.rs:12](../../src-tauri/src/commands/secrets.rs#L12). |
| `secret_get` | `id: String` | `String` | Empty id/keyring unavailable/no entry/read failure [secrets.rs:19](../../src-tauri/src/commands/secrets.rs#L19). |
| `secret_delete` | `id: String` | `()` | Empty id/keyring unavailable/delete failure; no entry succeeds [secrets.rs:27](../../src-tauri/src/commands/secrets.rs#L27). |

The model and secret commands are registered in `lib.rs`
[lib.rs:68](../../src-tauri/src/lib.rs#L68),
[lib.rs:71](../../src-tauri/src/lib.rs#L71). Diagnostic command details:
see [models and diagnostics](./model.md).

### Events

This domain emits no Tauri events. Settings are Angular persistence/signals,
and key/model/log commands return results directly.

## 4. Angular

### API wrapper methods

There is no settings-specific Angular API wrapper. `ModelsSettings` calls
`invoke()` directly for `secret_set`, `secret_get`, `secret_delete`, and
`model_test_local` [models-settings.ts:151](../../src/app/feature/setting/model-setting/models-settings.ts#L151),
[models-settings.ts:228](../../src/app/feature/setting/model-setting/models-settings.ts#L228).
`SettingsRuntimeService` calls `invoke('set_log_level', ...)`;
that command is documented in [Diagnostics](#diagnostics)
[settings-runtime.service.ts:34](../../src/app/core/services/settings-runtime.service.ts#L34).

### Store signals

No store implementation is used: `setting.store.ts` is empty and no
`SettingStore` reference exists. `SettingsService` owns private
`userValues`, `workspaceValues`, `workspacePath`, and public `modifiedCount`;
`get()`/`select()` return computed effective-value signals
[settings.service.ts:18](../../src/app/feature/setting/settings.service.ts#L18),
[settings.service.ts:29](../../src/app/feature/setting/settings.service.ts#L29).

### Service and facade methods

- `get<T>(key)`, `select<T>(key)`: computed effective value.
- `set(key, raw, scope?)`, `reset(key, scope?)`, `sourceOf(key)`,
  `isModified(key)`, `resetAll()`, `load()`, `reloadWorkspace(rootPath?)`.
- Errors: unknown setting/scope/value throws `Error` or `TypeError`;
  read and malformed-file failures fall back to `{}`; write failures are logged
  and do not throw to UI [settings.service.ts:38](../../src/app/feature/setting/settings.service.ts#L38),
  [settings.service.ts:129](../../src/app/feature/setting/settings.service.ts#L129),
  [settings.service.ts:153](../../src/app/feature/setting/settings.service.ts#L153).
- `SettingsRuntimeService` applies theme/density and updates log level.
- `ModelsSettings` methods save/remove/test models and handle command/fetch
  failures into UI signals [models-settings.ts:124](../../src/app/feature/setting/model-setting/models-settings.ts#L124).

## Diagnostics

The diagnostics/log-level setting belongs to the diagnostics domain, even though
its value is owned and persisted by Angular settings.

| Command | Args in camelCase | Return | Errors |
|---|---|---|---|
| `set_log_level` | `level: String` | `()` | Plain `String`: unknown log level [diagnostics.rs:4](../../src-tauri/src/commands/diagnostics.rs#L4). |

`set_log_level` is registered in
[lib.rs:139](../../src-tauri/src/lib.rs#L139). It maps `trace`, `debug`, `info`,
`warn`, or `error` to `LevelFilter` and applies the filter to the Rust log plugin.

**Change log level**

`SettingsRuntimeService` effect reads `diagnostics.logLevel` ->
`invoke('set_log_level', { level })` -> Rust `set_log_level` maps the string to
`LevelFilter`; errors are caught and logged in Angular
[settings-runtime.service.ts:34](../../src/app/core/services/settings-runtime.service.ts#L34).

## 5. Flows

### Load settings

UI startup -> `SettingsService.load()` -> read app-data `settings.json`, then
read workspace `.cairn/settings.json` -> filter/merge signals -> UI getters
reactive to `userValues`/`workspaceValues`
[settings.service.ts:88](../../src/app/feature/setting/settings.service.ts#L88).
No Rust command or event is in this flow.

### Change a setting

UI control -> `Settings.write()` or `toggle()` -> `SettingsService.set()` ->
update signal immediately -> 300 ms snapshot timer -> queued atomic write ->
user app-data file or workspace file
[settings.ts:134](../../src/app/feature/setting/settings.ts#L134),
[settings.service.ts:124](../../src/app/feature/setting/settings.service.ts#L124).
No Tauri command/store/event is involved.

### Save/remove/test model

Models UI -> `ModelsSettings.saveModel/remove/testConnection()` -> local secret
commands and `model_test_local`/`fetch()` -> update `models.registry` through
`SettingsService.set()` -> debounced JSON write; no Rust event/store cache
[models-settings.ts:124](../../src/app/feature/setting/model-setting/models-settings.ts#L124),
[models-settings.ts:205](../../src/app/feature/setting/model-setting/models-settings.ts#L205),
[models-settings.ts:222](../../src/app/feature/setting/model-setting/models-settings.ts#L222).

## 6. Gaps

- Rust's settings access remains read-only and limited to the user model
  registry; workspace settings are not merged into run model configuration.
- `setting.store.ts` exists as an empty file and is unused.
- There is no settings Tauri event; Angular does not need an event listener
  because it writes and owns both signal state and files.
- Model registry JSON is parsed in the component; registry schema validation
  is not a Rust/type-safe service boundary [models-settings.ts:290](../../src/app/feature/setting/model-setting/models-settings.ts#L290).
- `npm run docs:check` and all runtime tests are needed to verify documentation
  and behavior; end-to-end secret/keychain behavior is `unverified`.

## 7. Logic in the wrong layer

| Path:line | Finding |
|---|---|
| [models-settings.ts:124](../../src/app/feature/setting/model-setting/models-settings.ts#L124) | Save validation, key migration/deletion, entry construction, and registry writes belong in a model/service facade. |
| [models-settings.ts:222](../../src/app/feature/setting/model-setting/models-settings.ts#L222) | API key retrieval and HTTP endpoint/testing logic belong in a model service. |
| [models-settings.ts:290](../../src/app/feature/setting/model-setting/models-settings.ts#L290) | JSON parsing and default normalization belong outside the settings component. |
| [models.rs:18](../../src-tauri/src/commands/models.rs#L18) | GGUF validation, process spawning, polling, timeout, and kill logic execute in the command module. |
| [secrets.rs:13](../../src-tauri/src/commands/secrets.rs#L13) | Keyring entry validation and secret lifecycle logic execute in the command module. |
| [diagnostics.rs:4](../../src-tauri/src/commands/diagnostics.rs#L4) | String-to-`LevelFilter` mapping executes in the command module. |
