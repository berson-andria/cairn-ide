import { Injectable, effect, inject, untracked } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { LspClient } from './lsp-client';
import { LspServerConfig, serverForLanguage } from './lsp-servers';

import { WorkspaceNodeStore } from '../../store/workspace/workspace.store';
import { EditorService } from '../../../features/editor/services/editor.service';
import { EditorCommands } from '../../../features/editor/editor.commands';
import { LspMonitor } from './lsp-monitor.service';

const IDLE_STOP_MS = 60_000;

/**
 * Starts language servers on demand, keyed by the Monaco language of each model:
 *   model created  -> find server for model.getLanguageId() -> start (once) -> didOpen
 *   model disposed -> didClose -> stop the server after it's been idle for a minute
 * Nothing runs for languages you never open.
 */
@Injectable({ providedIn: 'root' })
export class LspManager {
  private readonly editorService = inject(EditorService);
  private readonly command = inject(EditorCommands);
  private readonly store = inject(WorkspaceNodeStore);

  private monaco?: typeof Monaco;
  private initialized = false;

  private readonly clients = new Map<string, Promise<LspClient | null>>(); // by config.id
  private readonly modelClient = new Map<string, LspClient>(); // by model uri
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failed = new Set<string>(); // servers that failed to start (e.g. not installed)
  private readonly monitor = inject(LspMonitor);

  constructor() {
    // Workspace changed -> servers have the wrong root; restart them.
    effect(() => {
      this.store.rootPath(); // read first so the effect always tracks it
      untracked(() => {
        if (this.monaco) void this.restartAll();
      });
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const monaco = (this.monaco = await this.editorService.load());
    monaco.editor.onDidCreateModel((m) => void this.attach(m));
    monaco.editor.onWillDisposeModel((m) => this.detach(m));
    monaco.editor.getModels().forEach((m) => void this.attach(m));

    (window as any).__lspTrace = (on = true) => (LspClient.trace = on);
    (window as any).__lspFullSync = (on = true) => (LspClient.forceFullSync = on);

    // Standalone Monaco can only jump to files that already have a model.
    // Route go-to-definition into other files through the store instead.
    monaco.editor.registerEditorOpener({
      openCodeEditor: (source, resource, selection) => this.openTarget(source, resource, selection),
    });
  }

  // ───────────────────────── models ─────────────────────────

  private async attach(model: Monaco.editor.ITextModel): Promise<void> {
    if (model.uri.scheme !== 'file') return;
    const config = serverForLanguage(model.getLanguageId());
    if (!config || this.failed.has(config.id)) return;

    const key = model.uri.toString();
    if (this.modelClient.has(key)) return;

    const client = await this.ensureClient(config);
    if (!client || model.isDisposed() || this.modelClient.has(key)) return;

    clearTimeout(this.idleTimers.get(config.id));
    this.idleTimers.delete(config.id);

    this.modelClient.set(key, client);
    client.openDocument(model);
  }

  private detach(model: Monaco.editor.ITextModel): void {
    const key = model.uri.toString();
    const client = this.modelClient.get(key);
    if (!client) return;

    this.modelClient.delete(key);
    client.closeDocument(model);

    if (client.openDocumentCount === 0) {
      const id = client.config.id;
      this.idleTimers.set(
        id,
        setTimeout(() => {
          if (client.openDocumentCount === 0) void this.stopClient(client);
        }, IDLE_STOP_MS),
      );
    }
  }

  // ───────────────────────── clients ─────────────────────────

  private ensureClient(config: LspServerConfig): Promise<LspClient | null> {
    let p = this.clients.get(config.id);
    if (!p) {
      p = this.startClient(config);
      this.clients.set(config.id, p);
    }
    return p;
  }

  private async startClient(config: LspServerConfig): Promise<LspClient | null> {
    const client = new LspClient(
      this.monaco!,
      config,
      this.store.rootPath(),
      (c) => this.onClientExit(c),
      this.monitor,
    );
    try {
      await client.start();
      return client;
    } catch (e) {
      console.error(
        `Could not start the ${config.id} language server (is it installed and on PATH?)`,
        e,
      );
      this.failed.add(config.id);
      this.clients.delete(config.id);
      await client.stop().catch(() => {});
      return null;
    }
  }

  private async stopClient(client: LspClient): Promise<void> {
    this.clients.delete(client.config.id);
    this.idleTimers.delete(client.config.id);
    await client.stop();
  }

  /** Server crashed or exited on its own. */
  private onClientExit(client: LspClient): void {
    this.clients.delete(client.config.id);
    for (const [uri, c] of this.modelClient) if (c === client) this.modelClient.delete(uri);
  }

  private async restartAll(): Promise<void> {
    const running = [...this.clients.values()];
    this.clients.clear();
    this.failed.clear();
    this.modelClient.clear();
    this.idleTimers.forEach((t) => clearTimeout(t));
    this.idleTimers.clear();
    await Promise.all(running.map(async (p) => (await p)?.stop()));
    this.monaco!.editor.getModels().forEach((m) => void this.attach(m));
  }

  // ───────────────────────── go-to-definition across files ─────────────────────────

  private async openTarget(
    source: Monaco.editor.ICodeEditor,
    resource: Monaco.Uri,
    selection?: Monaco.IRange | Monaco.IPosition,
  ): Promise<boolean> {
    // Same file: let Monaco's default handling do it.
    if (source.getModel()?.uri.toString() === resource.toString()) return false;
    if (resource.scheme !== 'file') return false;

    const root = this.store.rootPath();
    const fsPath = resource.fsPath;
    if (!root || !fsPath.toLowerCase().startsWith(root.toLowerCase())) return false; // outside workspace

    // Monaco lowercases the drive letter; the store keys nodes by their original path.
    const fileId = await this.store.resolveFileId(root + fsPath.slice(root.length));
    if (!fileId) return new Promise(() => false);
    this.command.openFile(fileId);
    await new Promise((r) => setTimeout(r, 50)); // let the editor swap to the new model

    const editor = this.monaco!.editor.getEditors().find(
      (e) => e.getModel()?.uri.toString() === resource.toString(),
    );
    if (editor && selection) {
      if ('startLineNumber' in selection) {
        editor.setSelection(selection);
        editor.revealRangeInCenter(selection);
      } else {
        editor.setPosition(selection);
        editor.revealPositionInCenter(selection);
      }
      editor.focus();
    }
    return true;
  }
}
