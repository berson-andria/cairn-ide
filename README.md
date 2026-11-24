# Cairn IDE

> A lean, high-performance, extensible desktop IDE built with **Tauri**, **Angular**, and **Monaco Editor**, for structured, deterministic AI-assisted development.

---

> [!NOTE]
> **Project Status: Active Development**
>
> The editor, integrated terminal, file explorer, Git tools, LSP bridge, settings, Rust code map, task/note/run/proposal services, and stdlib-only Python SDK are implemented. Run timeline, patch review, and proposal inbox screens are still in progress. Unverified: a real model-backed workflow, app recovery, packaged resources, and Unix process handling.

---

## The Vision

Most AI coding tools retrieve context as a probabilistic black box and wrap it in a hardcoded chat interface. Cairn takes a different approach:

> **The IDE provides Tasks, Notes, and a Living Code Map; the user programs the Agent in Python.**

Cairn separates discovery from extraction. A code map gives the model structured symbol and reference information instead of dumping whole project files into every prompt. Tasks and contextual notes retain the work to be done and the decisions around it.

The IDE is an open host rather than a closed agent. Project, global, and bundled Python workflows communicate with Rust over JSON-RPC and use the first-class SDK to read tasks and notes, inspect run context, report progress, read selected project files, and propose work.

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

### 3. Python Workflows and SDK

Each workflow scope has a single `main.py` entry: project
`.cairn/workflows/main.py`, the global workflow under the platform config
directory, or Cairn's bundled default at `sdk/python/workflows/main.py`. A
valid project workflow takes precedence; when a project workflow folder has
files but no `main.py`, Rust requires a source choice and remembers it for that
project; the full Angular choice flow is in progress. Project workflow trust is
reviewed in Settings, covers the whole folder, and is stored in app data rather
than the repository. Approved scripts run with the user's permissions.

The bundled default workflow reads task context and proposes edits through
patches, or proposes splitting a task. Scripts cannot write workspace files:
the patch review UI is in progress, and only the user-side apply/discard
operations can change workspace files. Task and subtask proposals remain
pending until a user accepts or rejects them; the proposal inbox UI is in
progress.

The stdlib-only SDK in `sdk/python/cairn` communicates with Rust using
JSON-RPC 2.0. Stdout is reserved for RPC; Python `print()` output goes to
stderr and becomes run-log output. Its API v1 methods are:

`hello`, `run.context`, `run.finish`, `tasks.get`, `tasks.list`, `notes.get`,
`notes.for_task`, `models.list`, `models.complete`, `files.read`, `files.list`,
`patch.propose`, `step.start`, `step.finish`, `tasks.propose`,
`tasks.propose_batch`, `tasks.propose_subtasks`, and `proposals.list`.

The SDK raises `CairnError(code, message)` for RPC errors and exits when the
host closes stdin. A workflow that calls a model sends the task text, linked
notes and the project files it reads to the model provider you configured; a
local endpoint keeps data on your machine. Files such as `.env` and key files
are never readable by workflows.

### 4. Model and Provider Integration

Settings and model entries are managed in the Angular app. Rust owns API-key storage through the OS keyring and provides an OpenAI-compatible model broker to workflows. Model calls can use a provider you configure or a local endpoint.

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
- [x] **Rust Code Map:** Tree-sitter extraction for Rust; additional grammars planned.
- [ ] **Code Map Panel:** planned.
- [x] **Reference Graph Engine:** lexical caller/callee graph (LSP call hierarchy resolution planned)
- [x] **Python runner and SDK (runs, steps, proposals):** services implemented.
- [x] **Bundled default workflow:** code implemented; real model/app trial unverified.
- [x] **Task and Note Management:** Rust services, stores, Angular facades, and task/note screens.
- [ ] **Run and step timeline:** services done, UI in progress (run view is an empty shell).
- [ ] **Patch review:** services done, UI in progress (services only; no feature screen).
- [ ] **Proposal inbox and planning view:** services done, UI in progress (services only; no feature screen).
- [ ] **Workflow choice and trust flows:** services done, UI in progress.
- [ ] **TypeScript Code Map Grammar:** planned.
- [ ] **Model-call usage display:** planned.

---

## Getting Started

### Prerequisites

- Node.js (tested with Node 26.x; `node -v` returned `v26.1.0`)
- Stable Rust toolchain
- Tauri v2 platform prerequisites
- uv: Workflows run through uv, which installs the packages a workflow lists in
  its header into an isolated environment. Install uv first; Cairn shows a
  clear message if it's missing.

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
- [Context](docs/CONTEXT.md)
- [Frontend Core](docs/domains/frontend-core.md)
- [Codemap](docs/domains/codemap.md)
- [Editor](docs/domains/editor.md)
- [Explorer](docs/domains/explorer.md)
- [Git](docs/domains/git.md)
- [LSP](docs/domains/lsp.md)
- [Models and Settings](docs/domains/settings.md)
- [Model Broker](docs/domains/model.md)
- [Notes and Tasks](docs/domains/tasks-notes.md)
- [Patches](docs/domains/patches.md)
- [Proposals](docs/domains/proposals.md)
- [Runs](docs/domains/runs.md)
- [Terminal](docs/domains/terminal.md)
- [Workspace](docs/domains/workspace.md)

The module map links each domain to its code and documentation.
