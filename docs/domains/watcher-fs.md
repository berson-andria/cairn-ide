# Watcher and filesystem events

“Shown on read” describes directory listings. Live events are the paths sent to the
explorer from filesystem notifications. “Git refresh” means an emitted live event
triggers Angular’s debounced Git status refresh; it does not imply the path changes
Git status. Ignored heavy-folder descendants are suppressed by the watcher and
codemap, while the folder entry itself remains visible.

## Visibility and filtering

| Path | Shown on read | Live events | Codemap | Git refresh |
|---|---|---|---|---|
| Normal source file | Yes | Yes | Yes | Yes |
| `.venv` entry | Yes | Yes | No | Yes |
| `.venv/**` | Yes | No | No | No |
| `node_modules/**` | Yes | No | No | No |
| `.git` | No | No | No | No |
| `.git/HEAD` \| `index` \| `packed-refs` \| `refs/**` | No | Yes | No | Yes |
| `.git/objects/**` | No | No | No | No |
| `.cairn` | Yes | Yes | No | Yes |
| `.cairn/settings.json` | Yes | Yes | No | Yes |
| `.cairn/tasks/**` | Yes | Yes | No | Yes |
| `.cairn/notes/**` | Yes | Yes | No | Yes |
| `.cairn/workflows/**` | Yes | Yes | No | Yes |
| `.cairn/cache/**` | No | No | No | No |
| `.cairn/runs/**` | No | No | No | No |

The shared tree visibility rule hides every `.git` component and only the
`cache` and `runs` children of `.cairn` (case-insensitive child-name match).
Other `.cairn` descendants are visible and their events may reach the codemap
queue, where the codemap’s separate strict hidden-path filter ignores them.
Git metadata exceptions apply only to `.git/HEAD`, `.git/index`,
`.git/packed-refs`, and `.git/refs/**`. Heavy-folder live filtering follows the
workspace ignore rules and built-in Python environment/cache rules.

## Filesystem events

| Outside change in the tree | event `fs:changed` `{ events:[{kind,paths}], overflow }`; on `overflow` do a full refresh |
| Watcher failed | event `fs:watch-error` `{ message }` -> show a notice |
