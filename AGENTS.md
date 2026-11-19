# AGENTS.md

Cairn IDE: Tauri v2 (Rust) + Angular (standalone components, signals) +
Monaco. Read `docs/architecture.md` (decisions) and `docs/current-state.md`
(facts) before changing structure. Keep this file short.

## Commands

- Dev: `npm run tauri:dev`
- Type check: `npx tsc --noEmit -p tsconfig.app.json`
- Frontend build: `npx ng build --configuration development`
- Rust check: `cd src-tauri && cargo check`
- Known: a pre-existing warning in `missing-language-dialog.ts` and some
  existing Rust warnings. Do not fix them unless asked.

## Rules

- Make only the change requested. Do not refactor nearby code.
- Tasks and notes: Rust is the only reader/writer. Angular stores are
  caches fed by events. Never add a second writer.
- Settings: Angular owns them (`SettingsService`). Read values through
  `SettingsService.get(...)`. Never hardcode what a setting controls.
- Secrets (API keys) go through the keychain commands, never into JSON.
- Style new UI with the design tokens in `token.scss`. Do not invent
  CSS rules or utility classes that do not exist.
- Rust commands live in `src-tauri/src/commands/<name>.rs`; register them in
  `commands/mod.rs` and `lib.rs`. Shared logic goes in `services/`.
- `src/app/shared/models/persistence.model.ts` is a wishlist of possible data.
  It is not a source of truth. Do not derive schemas from it.
- `task.store.ts`, `note.store.ts`, `setting.store.ts` are intentional
  placeholders until the tasks/notes migration reaches them.
- Do not read or edit `src/assets`, icons or lockfiles.

## Finishing a task

- Run the type check and `cargo check` when you touched that side.
- If you changed structure, update the relevant section of
  `docs/current-state.md` in the same change.
- List files changed and anything left unverified. Do not claim what you did
  not run.