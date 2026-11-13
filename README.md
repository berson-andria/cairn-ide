# Cairn IDE

> A lean, high-performance, and extensible developer environment built with **Tauri**, **Angular**, and **Monaco Editor**, designed for deterministic AI-assisted workflows and programmable agentic systems.

---

> [!NOTE]
> **Project Status: Active Development (Work in Progress)**  
> Cairn is an ongoing, evolving project. Core editor functionalities, terminal, file explorer, and a custom Language Server Protocol (LSP) bridge are operational. The deterministic AST code-mapping engine and scriptable Python agent runtime are currently in active design and implementation.

---

## 🧭 The Vision

Most modern AI coding environments treat context retrieval as a black box—relying on probabilistic vector search or heavy file attachments optimized for massive, expensive cloud models, wrapped in hardcoded chat interfaces that developers cannot inspect or control. When working with smaller local models or optimizing for token efficiency and precision, this approach quickly breaks down.

> **The Core Formula:**  
> **The IDE provides Tasks, Notes, and a Living Code Map; you program the Agent to orchestrate them.**

**Cairn takes a fundamentally different approach:**
1. **Two-Stage Context Retrieval:** Other tools often dump multiple entire functions or full files into the context window. Cairn separates discovery from code extraction:
   * **Discovery via Descriptions:** The agent scans lightweight behavioral summaries in the Code Map to locate the function it needs or verify whether a function already exists, avoiding redundant implementations.
   * **Tree-sitter & LSP:** Once the target is identified from its description, Tree-sitter and LSP selectively extract *only* that function's body and its direct callers/callees, feeding the model the exact context required without token bloat.
2. **Provider-Agnostic & Privacy-Friendly:** Connect your preferred LLM provider via Bring-Your-Own-Key (OpenAI, Anthropic, OpenRouter, Groq, etc.) or connect to local inference engines (Ollama, llama.cpp, vLLM) for offline, privacy-first, and zero-cost development.
3. **Programmable Agent Runtime (Open Host vs. Closed Box):** What is described above is only the **default workflow**. Cairn treats the IDE as an extensible host with a stable API. Through a first-class **Python SDK**, developers have full programmatic control (read, write, delete) over all IDE primitives—tasks, contextual notes, the code map, workspace files, and model endpoints. If you don't like the default agent loop, you can script your own without touching Rust or recompiling the IDE.
4. **Lean & Resource-Conscious:** Powered by a native Rust core (Tauri) and a modern Angular frontend, avoiding the heavy memory overhead of traditional Electron-based editors.

---

## ⚡ Core Pillars

### 1. The Code Map & Two-Stage Context Engine *(In Progress)*
* **AST Extraction:** Uses Tree-sitter to parse project files into functions and classes, mapping exact signatures and body spans.
* **Behavioral Descriptions:** Cached one-line summaries describe what each function actually does, allowing the agent to find needed logic or detect existing functions without reading full implementations.
* **On-Demand Hydration:** Tree-sitter + LSP pulls only the resolved function and its reference graph (`context_for(files)`), keeping prompts hyper-focused.
* **Smart Invalidation via Body Hashing:** Function bodies are hashed (`xxhash`/`blake3`) so the AI only generates summaries for code that actually changed.
* **Who-Calls-Whom Reference Graph:** Tracks direct callers and callees to provide structural context on demand.

### 2. Flexible Model Integration (Local & Cloud)
* **Inference Providers:** First-class support for cloud API providers (OpenAI, Anthropic, OpenRouter, Groq, etc.) with custom model selection and rate-limit friendliness.
* **Local Models:** Fully compatible with local OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp). Highly optimized for efficient reasoning on modest models (e.g., 14B–35B MoE) by minimizing context noise.

### 3. Brainstorming, Planning & "Nuclear" Tasks
* **Brainstorm $\to$ Plan $\to$ Execute Flow:** Collaborate with the agent to brainstorm architectural ideas, clarify requirements, and convert unstructured thoughts into a structured plan.
* **Nuclear (Atomic) Tasks:** Models—especially modest local models—excel when work is narrowly scoped. From the plan, developers can manually define or let the model suggest atomic "nuclear" tasks with explicit acceptance criteria.
* **Automated Subtask Decomposition:** If a task involves multiple steps, it is systematically split into granular subtasks, ensuring iterative, verifiable execution rather than uncontrolled, sprawling edits.
* **Contextual Notes:** Anchor quick notes directly to functions, AST nodes, or files to capture architectural thoughts and pending dependencies without losing your train of thought.

### 4. The Python Agent SDK & Extensible Runtime
Cairn does not hardcode agent logic into the core binary. **Every default capability—brainstorming, planning, nuclear task decomposition, subtask creation, and code map retrieval—is exposed as a first-class primitive in the Python SDK** over decoupled JSON-RPC:

* `planning`: Trigger collaborative brainstorming sessions, generate structured plans, and synthesize atomic tasks.
* `tasks`: Full CRUD operations, subtask decomposition, status transitions, and runnable verification criteria.
* `codemap`: Search function descriptions, check for duplicates, and extract AST bodies + call graphs (`context_for`).
* `notes`: Read, write, anchor to AST nodes, and promote notes into actionable tasks.
* `workspace` & `editor`: Propose diffs on isolated branches, inspect files, and trigger automated test/linter checks.
* `models`: Dispatch prompts to registered local or cloud model endpoints.

```python
# .cairn/workflows/default_flow.py
from cairn import tasks, notes, codemap, models, review

# The default agent loop is completely open and modifiable
for task in tasks.list(status="todo"):
    # 1. Walk the AST graph for surgical context (signatures, callers, callees)
    ctx = codemap.context_for(task.files, depth=1)
    extra_notes = notes.for_task(task.id)

    # 2. Feed precision context to your configured model (local or cloud)
    result = models.current().run(task.prompt, context=[ctx, extra_notes])

    # 3. Propose a diff on a clean branch and request human review
    tasks.propose_changes(task.id, result.diff)
    review.request(task.id)
```

> **Build Your Own Agents:** Developers can override workflows globally (`~/.config/cairn/workflows/`) or per-project (`.cairn/workflows/`) to implement custom methodologies—such as Spec-Driven Development, TDD loops, or multi-agent supervisor systems.

---

## 🛠️ Architecture & Tech Stack

```
┌────────────────────────────────────────────────────────┐
│                   Angular Frontend                     │
│ • Monaco Editor integration                            │
│ • Signals-based state management (@ngrx/signals)       │
│ • Workbench panels (LSP monitor, output, diagnostics)  │
└───────────────────────────▲────────────────────────────┘
                            │ Tauri IPC Channels / Invocation
┌───────────────────────────▼────────────────────────────┐
│                    Rust Backend (Tauri)                │
│ • Native OS filesystem & watcher                       │
│ • Child process manager (LSPs, Python runtime)         │
│ • Tree-sitter AST extraction & symbol caching          │
│ • Low-latency JSON-RPC & event streaming               │
└───────────────────────────▲────────────────────────────┘
                            │ JSON-RPC (stdio / sockets)
┌───────────────────────────▼────────────────────────────┐
│             External Services & Providers              │
│ • Language Servers (rust-analyzer, tsserver, etc.)     │
│ • LLM Backends (Local Ollama / Cloud API Providers)    │
│ • User-Defined Python Agent Scripts                    │
└────────────────────────────────────────────────────────┘
```

* **Desktop Framework:** [Tauri v2](https://tauri.app/) (Rust)
* **Frontend UI:** [Angular](https://angular.dev/) (Standalone Components, Signals)
* **Code Editor:** [Monaco Editor](https://microsoft.github.io/monaco-editor/)
* **Language Intelligence:** Custom LSP Client Bridge (`src/app/core/services/lsp`)
* **Syntax Engine:** Tree-sitter (Native Rust backend)
* **Icons:** `@ng-icons/lucide` & `@ng-icons/bootstrap-icons`

---

## 🚦 Current Status & Roadmap

- [x] **Monaco Editor Core:** Multi-tab editing, model lifecycle management, syntax highlighting.
- [x] **Custom LSP Client:** Stdio child process spawning, JSON-RPC communication, diagnostics streaming to Problems panel, semantic tokens.
- [x] **IDE Shell:** File explorer, integrated terminal, output logs, tooling panel.
- [ ] **Tree-sitter Integration:** Native Rust parsing, symbol inventory, function body hashing.
- [ ] **Workbench Code Map Panel:** Dynamic function summary view with cached AI summaries.
- [ ] **Reference Graph Engine:** Lexical and LSP call hierarchy resolution.
- [ ] **Python Agent Runner:** JSON-RPC host bridge and thin Python SDK for custom user workflows.
- [ ] **Task & Note Management:** Structured task board and AST-anchored notes.

---

## 🚀 Getting Started (Development)

### Prerequisites
* [Node.js](https://nodejs.org/) (v20+ recommended)
* [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
* [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system

### Installation & Launch

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/cairn-ide.git
   cd cairn-ide
   ```

2. **Install frontend dependencies:**
   ```bash
   npm install
   ```

3. **Run in development mode:**
   ```bash
   npm run tauri:dev
   ```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
