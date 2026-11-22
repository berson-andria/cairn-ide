# Cairn IDE

> A lean, high-performance, extensible desktop IDE built with **Tauri**, **Angular**, and **Monaco Editor**, for structured, deterministic AI-assisted development.

---

> [!NOTE]
> **Project Status: Active Development**
>
> The editor, integrated terminal, file explorer, Git tools, LSP bridge, settings, task and note services, Rust code map, run lifecycle, proposals, and stdlib-only Python SDK are implemented. Runs and proposals are covered by automated tests; end-to-end verification inside the app is in progress. The README and runtime are still converging; a real workflow through the full app and several recovery/platform paths are not yet fully verified.

---

## The Vision

Most AI coding tools retrieve context as a probabilistic black box and wrap it in a hardcoded chat interface. Cairn takes a different approach:

> **The IDE provides Tasks, Notes, and a Living Code Map; the user programs the Agent in Python.**

Cairn separates discovery from extraction. A code map gives the model structured symbol and reference information instead of dumping whole project files into every prompt. Tasks and contextual notes retain the work to be done and the decisions around it.

The IDE is an open host rather than a closed agent. The default workflow is one workflow, not an irreversible core feature. Project and global Python workflows communicate with Rust over JSON-RPC and use the first-class SDK to read tasks and notes, inspect run context, report progress, and propose work.

Cairn is a native desktop application: Rust owns project data and process lifecycle; Angular provides the workspace UI and caches; Python workflows run as separate processes.

---

## Core Pillars

### 1. Structured Context

- Tree-sitter extracts Rust code symbols and computes body hashes for the Rust code map.
- Call and callee information supports structural code discovery.
- Tasks and notes keep plans, dependencies, acceptance criteria, and contextual links separate from prompts.
- The explorer, Monaco editor, LSP bridge, terminal, diagnostics, search, and Git tools provide the surrounding workbench.

### 2. Tasks, Notes, Runs, and Proposals

- Rust services own task, note, proposal, and run records.
- Task status transitions and revisions are enforced in Rust.
- Workflow runs execute Python separately and expose run context, steps, resume state, and finish results.
- Scripts may propose tasks or subtasks; scripts cannot create tasks directly or mark tasks complete.
- Proposal records and the proposal stores are implemented for task, batch, and subtask kinds.

### 3. The Python Agent SDK
The stdlib-only SDK in `sdk/python/cairn` talks to the host over JSON-RPC 2.0. Stdout is reserved for RPC; Python `print()` output is redirected to stderr and becomes run log output.

> **Workflows run through uv, which installs the packages a workflow lists in its header into an isolated environment. Install uv first; Cairn shows a clear message if it's missing.**

The SDK exposes:

| Namespace | Real methods |
|---|---|
| `cairn.tasks` | `get(task_id)`, `list()`, `propose(...)`, `propose_batch(...)`, `propose_subtasks(...)` |
| `cairn.notes` | `get(note_id)`, `for_task(task_id)` |
| `cairn.proposals` | `list()` |
| `cairn.run` | `context()`, `pending_steps()`, `step_start(...)`, `step_finish(...)`, `step(...)`, `finish(...)` |
| `cairn.call(...)` | Raw JSON-RPC call with API v1 handshake behavior |

The SDK raises `CairnError(code, message)` for RPC errors and exits when the host closes stdin. The first SDK call performs the `hello` handshake.

```python
from cairn import tasks, run

task = tasks.get("task-123")
context = run.context()

proposal_id = tasks.propose(
    "Add focused regression coverage",
    description="Cover the failing edge case",
    presentation="notify",
)
run.finish("needs_review", summary="Proposed verification work")
```

### 4. Model and Provider Integration

Settings and model entries are managed in the Angular app. Rust owns API-key storage through the OS keyring and exposes local-model testing. Cloud-provider and local-endpoint behavior is implemented through the model settings and services rather than being embedded in Python workflows.

---

## Architecture

```text
┌──────────────── Angular UI ─────────────────┐
│ Monaco  │  Explorer  │  Tasks/Notes  │  Runs │
│ Signals-based stores and caches             │
└───────────────────────┬─────────────────────┘
                        │ Tauri commands / events
┌───────────────────────▼─────────────────────┐
│             Rust core (Tauri)               │
│ project  │ task  │ note  │ proposal │ run    │
│ codemap  │ watcher │ LSP │ Git │ terminal   │
└───────────┬─────────────────────────────────┘
            │ JSON-RPC 2.0 over child stdin/stdout
┌───────────▼─────────────────────────────────┐
│  Python workflow process + cairn SDK        │
│  trusted project workflow or global workflow│
└─────────────────────────────────────────────┘
```

**Desktop framework:** Tauri v2 / Rust  
**Frontend:** Angular standalone components and signals  
**Editor:** Monaco Editor  
**Language intelligence:** Rust Tree-sitter and LSP bridge  
**Agent runtime:** Python stdlib SDK and JSON-RPC 2.0  
**Icons:** `@ng-icons/lucide` and `@ng-icons/bootstrap-icons`

Recent projects are stored in the application data directory as a device-local history, not in the opened project folder. The workspace domain documents this behavior in `docs/domains/workspace.md`.

---

## Current Status and Roadmap

- [x] **Monaco Editor Core:** multi-tab editing, model lifecycle, syntax highlighting.
- [x] **Custom LSP Client:** process bridge, JSON-RPC, diagnostics, semantic tokens.
- [x] **IDE Shell:** explorer, terminal, output, search, Git tools, and workspace panels.
- [x] **Rust Code Map:** Tree-sitter extraction for Rust (other languages planned, TypeScript next); cached summaries planned
- [ ] **Code Map Panel:** planned.
- [x] **Reference Graph Engine:** lexical caller/callee graph (LSP call hierarchy resolution planned)
- [x] **Python runner and SDK (runs, steps, proposals):** done
- [ ] **Default agent workflow with model calls:** planned
- [x] **Task and Note Management:** Rust services, stores, Angular facades, and persisted project records.
- [ ] **TypeScript Code Map Grammar:** planned.
- [ ] **Default End-to-End Workflow:** planned until a real app workflow is verified.

---

## Getting Started

### Prerequisites

- Node.js v26.1.0 (unverified; `package.json` has no `engines` field)
- Stable Rust toolchain
- Tauri v2 platform prerequisites
- `uv` for launching Python workflows

### Development

```bash
npm install
npm run tauri:dev
```

Rust tests:

```bash
cd src-tauri
cargo test
```

---

## Documentation
- [Module Map](docs/MAP.md)
- [Architecture](docs/architecture.md)
- [Frontend Core](docs/domains/frontend-core.md)
- [Codemap](docs/domains/codemap.md)
- [Editor](docs/domains/editor.md)
- [Explorer](docs/domains/explorer.md)
- [Git](docs/domains/git.md)
- [LSP](docs/domains/lsp.md)
- [Models and Settings](docs/domains/settings.md)
- [Notes and Tasks](docs/domains/tasks-notes.md)
- [Proposals](docs/domains/proposals.md)
- [Runs](docs/domains/runs.md)
- [Terminal](docs/domains/terminal.md)
- [Workspace](docs/domains/workspace.md)

Domain documentation is being completed; see docs/MAP.md for the module index.
