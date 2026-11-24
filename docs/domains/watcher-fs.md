# Watcher and filesystem events

## Rules and consumers

“Shown on read” means what `get_directory_content` can return from a directory
listing. “Live `fs:changed`” means the Rust notify batch reaches Angular.
“Codemap” means the Rust codemap update receives the path and the Rust codemap
can index it. “Git refresh” means the Angular Git service receives the shared
filesystem-event signal and starts its 500 ms debounced refresh.

| Path class | Shown on read | Live `fs:changed` | Codemap | Git refresh | Task/note reload |
|---|---|---|---|---|---|
| Normal source file | Yes | Yes | Yes | Yes | No |
| `.venv` entry | Yes | Yes | No | Yes | No |
| `.venv/**` | Yes | No | No | No | No |
| `node_modules/**` | Yes | Entry Yes; descendants No | No | Entry Yes; descendants No | No |
| `.git` | No | No | No | No | No |
| `.git/HEAD`, `index`, `packed-refs`, `refs/**` | No | Yes | No | Yes | No |
| `.git/objects/**` | No | No | No | No | No |
| `.cairn` | Yes | Yes | No | Yes | No |
| `.cairn/settings.json` | Yes | Yes | No | Yes | No |
| `.cairn/tasks/**` | Yes | Yes | No | Yes | Valid `<id>.json` only |
| `.cairn/notes/**` | Yes | Yes | No | Yes | Valid `<id>.json` only |
| `.cairn/workflows/**` | Yes | Yes | No | Yes | No |
| `.cairn/cache/**` | No | No | No | No | No |
| `.cairn/runs/**` | No | No | No | No | No |
| Hidden file such as `.env` | Yes | Entry Yes | No | Yes | No |

Directory reads use `get_directory_content`, which calls `tree_hidden` only;
there is no generic “hide dotfiles” read rule in that function
([fs.rs](../../src-tauri/src/services/fs.rs):8-24). `tree_hidden` hides only
`.git` components and `.cairn/cache` or `.cairn/runs` children
([watcher.rs](../../src-tauri/src/services/watcher.rs):250-263). Thus `.venv`,
`node_modules`, and `.env` entries remain visible on read. The `.gitignore`
pattern list affects live and codemap filtering; this repository ignores
`/node_modules` and `/.cairn` in [.gitignore](../../.gitignore):10,
/.gitignore:28, but `.cairn` is explicitly re-admitted for live events while
cache/runs remain hidden.

### Ordered event filters

One notify event passes these drop points, in order:

1. **notify callback path filter:** for each notify path,
   `path_allowed(...) || is_cairn_data_path(...)` retains it
   ([watcher.rs](../../src-tauri/src/services/watcher.rs):128-137).
2. **Explorer shape filter:** `path_allowed` calls `explorer_passes`
   ([watcher.rs](../../src-tauri/src/services/watcher.rs):246-247).
   `explorer_passes` first admits `.git/HEAD`, `index`, `packed-refs`, and
   `refs/**`; then drops every `.git` path and `.cairn/cache|runs`; for the
   remaining path it admits the `.cairn` entry and descendants, admits an
   ignored/hidden entry itself, but drops ignored/hidden descendants
   ([watcher.rs](../../src-tauri/src/services/watcher.rs):266-293).
3. **Batch filter:** `build_batch` calls `path_allowed` again and deduplicates
   paths; batches over 2000 unique paths become `overflow`
   ([watcher.rs](../../src-tauri/src/services/watcher.rs):302-330).
4. **Rust internal task/note listener:** `emit_batch` extracts only valid
   `.cairn/tasks|notes/<id>.json` paths and sends them to subscribed project
   services ([watcher.rs](../../src-tauri/src/services/watcher.rs):181-211).
   `ProjectState::reload_changed` classifies task versus note and calls
   `reload_external`; repeated corrupt reads retry once, then emit
   `project:reloaded` ([project.rs](../../src-tauri/src/services/project.rs):82-125).
5. **Angular event split:** `fs:changed` immediately emits `fsEvents$`; Git
   refreshes are debounced 500 ms
   ([workspace-watcher.service.ts](../../src/app/core/services/file-system/workspace-watcher.service.ts):65-79,
   [git.service.ts](../../src/app/feature/git/services/git.service.ts):160-164).
6. **Angular event-kind filter:** `classifyWatchEvent` drops access and metadata
   events; create/remove/modify/rename continue
   ([external-watcher.utils.ts](../../src/app/core/services/file-system/external-watcher.utils.ts):10-31).
7. **Explorer process filter:** `process` drops no path under a basename named
   `.git` (a defensive basename check), then updates/opens/closes nodes
   ([workspace-watcher.service.ts](../../src/app/core/services/file-system/workspace-watcher.service.ts):120-145).
8. **Codemap queue:** non-ignored event kinds add absolute paths to a 400 ms
   batched `codemap.updateFiles` call
   ([workspace-watcher.service.ts](../../src/app/core/services/file-system/workspace-watcher.service.ts):106-119).
9. **Codemap strict hidden/filter drop:** `update_files` drops paths outside the
   root or for which `is_ignored` sees any dot component or an ignore match
   ([service.rs](../../src-tauri/src/services/codemap/service.rs):88-108,
   [service.rs](../../src-tauri/src/services/codemap/service.rs):352-381).

### Ignore and hidden name lists

| List | Definition | Behavior |
|---|---|---|
| `.git`; `.cairn/cache`; `.cairn/runs` | `CAIRN_HIDDEN_CHILDREN = ["cache", "runs"]` and `tree_hidden` | Read and live drops; cache/runs are case-insensitive matches, `.git` is exact |
| Python environment/cache: `.venv/`, `venv/`, `__pycache__/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/` | `watcher_ignore` | Watch/codemap ignore patterns; `.venv` folder entry is retained live, descendants are dropped |
| Any dot component | `is_ignored` | Codemap strict drop for hidden files/folders |
| Root `.gitignore`; `.git/info/exclude` | `watcher_ignore` | Read fresh into watcher/codemap ignore rules; nested `.gitignore` files are not read for watcher paths |
| Git metadata allowlist: `HEAD`, `index`, `packed-refs`, `refs/**` | `git_path_needed` | These Git metadata paths pass the live explorer filter even though `.git` is hidden |
| Heavy entry in workspace search: `node_modules`, `.git`, `target` | Directory-search skip at scan | Search/listing optimization, not the shared live event filter |
| Valid task/note external reload: exactly `.cairn/tasks|notes/<name>.json` | `is_cairn_data_path` | Reload only names not starting `.`, not ending `.tmp`, and with `.json` extension |

## Filesystem events

| Outside change in the tree | event `fs:changed` `{ events:[{kind,paths}], overflow }`; on `overflow` do a full refresh |
| Watcher failed | event `fs:watch-error` `{ message }` -> show a notice |

## Tauri commands

| Command | JS arguments (camelCase) | Return |
|---|---|---|
| `watch_start` | `path` | `()` |
| `watch_stop` | — | `()` |

Both commands return string errors; their implementations are in
[watcher.rs](../../src-tauri/src/commands/watcher.rs).
