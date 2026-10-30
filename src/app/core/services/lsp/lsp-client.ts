import { Channel, invoke } from '@tauri-apps/api/core';
import type * as Monaco from 'monaco-editor';
import type * as lsp from 'vscode-languageserver-types';
import * as conv from './lsp-convert';
import { LspServerConfig, resolveCommand } from './lsp-servers';
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import { LspServerHandle, LspMonitor } from './lsp-monitor.service';

type LspEvent =
  | { event: 'message'; data: string }
  | { event: 'stderr'; data: string }
  | { event: 'exit'; data: number | null };

// Token kinds we tell the server we understand (our theme has rules for these).
const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
];

interface DocState {
  model: Monaco.editor.ITextModel;
  listener: Monaco.IDisposable;
}

/** One running language server + the JSON-RPC session talking to it. */
export class LspClient {
  /** Devtools: __lspTrace(true) logs every JSON-RPC message, both directions. */
  static trace = false;
  /** Devtools: __lspFullSync(true) sends the whole document on every edit instead of incremental changes. */
  static forceFullSync = false;

  private serverId?: string;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // lsp_send calls are chained so didOpen/didChange can never reach Rust out of order.
  private sendChain: Promise<unknown> = Promise.resolve();
  private caps: any = {};
  private docs = new Map<string, DocState>();
  private disposables: Monaco.IDisposable[] = [];
  private workspaceFolders: { uri: string; name: string }[] | null = null;
  private initialized = false;
  private stopped = false;
  // Created in registerProviders (not a field initializer: it needs this.monaco).
  private semanticRefresh?: Monaco.Emitter<void>;
  private readonly mon: LspServerHandle;

  constructor(
    private readonly monaco: typeof Monaco,
    readonly config: LspServerConfig,
    private readonly rootPath: string | null,
    private readonly onExit: (client: LspClient) => void,
    monitor: LspMonitor,
  ) {
    this.mon = monitor.track(config);
  }

  get openDocumentCount(): number {
    return this.docs.size;
  }

  // ───────────────────────── lifecycle ─────────────────────────
  async start(): Promise<void> {
    try {
      await this.doStart();
    } catch (e) {
      this.mon.failed(e);
      throw e;
    }
  }
  async doStart(): Promise<void> {
    const channel = new Channel<LspEvent>();
    channel.onmessage = (e) => {
      switch (e.event) {
        case 'message':
          return this.handleMessage(e.data);
        case 'stderr':
          return console.debug(`[lsp:${this.config.id}]`, e.data);
        case 'exit':
          return this.handleExit(e.data);
      }
    };

    this.serverId = await invoke<string>('lsp_start', {
      command: resolveCommand(this.config),
      args: this.config.args,
      cwd: this.rootPath,
      onEvent: channel,
    });
    this.mon.initializing();
    const rootUri = this.rootPath ? this.monaco.Uri.file(this.rootPath).toString() : null;
    const name = this.rootPath ? this.rootPath.split(/[\\/]/).pop() || 'workspace' : 'workspace';
    this.workspaceFolders = rootUri ? [{ uri: rootUri, name }] : null;

    const result = await this.request<{ capabilities: any }>(
      'initialize',
      {
        processId: null,
        clientInfo: { name: 'cairn' },
        rootUri,
        workspaceFolders: this.workspaceFolders,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            semanticTokens: { refreshSupport: true },
          },
          window: { workDoneProgress: false },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            completion: {
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                insertReplaceSupport: true,
                deprecatedSupport: true,
                tagSupport: { valueSet: [1] },
                labelDetailsSupport: true,
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            publishDiagnostics: { tagSupport: { valueSet: [1, 2] } },
            semanticTokens: {
              dynamicRegistration: false,
              requests: { full: true },
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: false,
            },
          },
        },
      },
      undefined,
      60_000,
    );

    this.caps = result?.capabilities ?? {};
    this.notify('initialized', {});
    this.initialized = true;
    this.mon.ready(this.caps);
    this.registerProviders();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.mon.stopping();
    if (this.initialized) {
      try {
        await this.request('shutdown', null, undefined, 3000);
        this.notify('exit', null);
      } catch {
        /* server unresponsive: fall through to kill */
      }
    }
    this.stopped = true;
    this.cleanup();
    if (this.serverId) {
      await invoke('lsp_stop', { id: this.serverId }).catch(() => {});
    }
    this.mon.stopping();
  }

  private handleExit(code: number | null): void {
    if (this.stopped) return;
    console.warn(`[lsp:${this.config.id}] server exited (code ${code})`);
    this.stopped = true;
    this.mon.exited(code);
    this.cleanup();
    this.onExit(this);
  }

  private cleanup(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    for (const { model, listener } of this.docs.values()) {
      listener.dispose();
      if (!model.isDisposed()) this.monaco.editor.setModelMarkers(model, this.owner, []);
    }
    this.docs.clear();
    this.pending.forEach((p) => p.reject(new Error('language server stopped')));
    this.pending.clear();
  }

  private get owner(): string {
    return `lsp-${this.config.id}`;
  }

  // ───────────────────────── documents ─────────────────────────

  openDocument(model: Monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    if (this.docs.has(uri) || this.stopped) return;

    const listener = model.onDidChangeContent((e) => this.onChange(model, e));
    this.docs.set(uri, { model, listener });

    this.mon.documents(this.docs.size);

    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  }

  closeDocument(model: Monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    const doc = this.docs.get(uri);
    this.mon.documents(this.docs.size);
    if (!doc) return;
    doc.listener.dispose();
    this.docs.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
    this.monaco.editor.setModelMarkers(model, this.owner, []);
  }

  private onChange(
    model: Monaco.editor.ITextModel,
    e: Monaco.editor.IModelContentChangedEvent,
  ): void {
    const sync = this.caps.textDocumentSync;
    const kind: number = typeof sync === 'number' ? sync : (sync?.change ?? 0);
    if (kind === 0) return;

    const contentChanges =
      kind === 1 || e.isFlush || LspClient.forceFullSync
        ? [{ text: model.getValue() }]
        : // Apply from the end of the document backwards so each range stays valid.
          [...e.changes]
            .sort((a, b) => b.rangeOffset - a.rangeOffset)
            .map((c) => ({
              range: conv.toLspRange(c.range),
              rangeLength: c.rangeLength,
              text: c.text,
            }));

    this.notify('textDocument/didChange', {
      textDocument: { uri: model.uri.toString(), version: model.getVersionId() },
      contentChanges,
    });
  }

  private findDoc(uri: string): DocState | undefined {
    const direct = this.docs.get(uri);
    if (direct) return direct;
    // Servers may differ in drive-letter case / percent-encoding on Windows.
    const norm = (u: string) => decodeURIComponent(u).toLowerCase();
    const target = norm(uri);
    for (const [key, doc] of this.docs) if (norm(key) === target) return doc;
    return undefined;
  }

  // ───────────────────────── providers ─────────────────────────

  private registerProviders(): void {
    const m = this.monaco;
    const caps = this.caps;

    // Fired when the server says "my token data changed" (e.g. rust-analyzer after indexing).
    this.semanticRefresh = new m.Emitter<void>();
    this.disposables.push(this.semanticRefresh);

    for (const lang of this.config.languages) {
      if (caps.completionProvider) {
        this.disposables.push(
          m.languages.registerCompletionItemProvider(lang, {
            triggerCharacters: caps.completionProvider.triggerCharacters,
            provideCompletionItems: async (model, position, context, token) => {
              const uri = model.uri.toString();
              if (!this.docs.has(uri)) return undefined;

              const res = await this.requestSafe<lsp.CompletionItem[] | lsp.CompletionList>(
                'textDocument/completion',
                {
                  textDocument: { uri },
                  position: conv.toLspPosition(position),
                  context: {
                    triggerKind: context.triggerKind + 1, // Monaco 0-based, LSP 1-based
                    triggerCharacter: context.triggerCharacter,
                  },
                },
                token,
              );
              if (!res) return undefined;

              const items = Array.isArray(res) ? res : res.items;
              const word = model.getWordUntilPosition(position);
              const defaultRange: Monaco.IRange = {
                startLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: word.endColumn,
              };
              return {
                incomplete: !Array.isArray(res) && res.isIncomplete,
                suggestions: items.map((i) => conv.toCompletionItem(m, i, defaultRange)),
              };
            },
          }),
        );
      }

      if (caps.hoverProvider) {
        this.disposables.push(
          m.languages.registerHoverProvider(lang, {
            provideHover: async (model, position, token) => {
              const uri = model.uri.toString();
              if (!this.docs.has(uri)) return undefined;
              const res = await this.requestSafe<lsp.Hover>(
                'textDocument/hover',
                { textDocument: { uri }, position: conv.toLspPosition(position) },
                token,
              );
              if (!res?.contents) return undefined;
              const contents = conv.toMarkdownStrings(res.contents);
              if (!contents.length) return undefined;
              return { contents, range: res.range ? conv.toMonacoRange(res.range) : undefined };
            },
          }),
        );
      }

      if (caps.definitionProvider) {
        this.disposables.push(
          m.languages.registerDefinitionProvider(lang, {
            provideDefinition: async (model, position, token) => {
              const uri = model.uri.toString();
              if (!this.docs.has(uri)) return undefined;
              const res = await this.requestSafe<
                lsp.Location | lsp.Location[] | lsp.LocationLink[]
              >(
                'textDocument/definition',
                { textDocument: { uri }, position: conv.toLspPosition(position) },
                token,
              );
              if (!res) return undefined;
              const list = Array.isArray(res) ? res : [res];
              return (list as (lsp.Location | lsp.LocationLink)[]).map((l) =>
                'targetUri' in l
                  ? {
                      uri: m.Uri.parse(l.targetUri),
                      range: conv.toMonacoRange(l.targetSelectionRange),
                    }
                  : { uri: m.Uri.parse(l.uri), range: conv.toMonacoRange(l.range) },
              );
            },
          }),
        );
      }

      if (caps.semanticTokensProvider?.full) {
        const legend = caps.semanticTokensProvider.legend as Monaco.languages.SemanticTokensLegend;
        this.disposables.push(
          m.languages.registerDocumentSemanticTokensProvider(lang, {
            onDidChange: this.semanticRefresh.event,
            getLegend: () => legend,
            provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
              const uri = model.uri.toString();
              if (!this.docs.has(uri)) return null;
              const res = await this.requestSafe<{ data: number[]; resultId?: string }>(
                'textDocument/semanticTokens/full',
                { textDocument: { uri } },
                token,
              );
              // LSP's relative encoding is identical to Monaco's, so the data passes straight through.
              return res ? { data: new Uint32Array(res.data), resultId: res.resultId } : null;
            },
            releaseDocumentSemanticTokens: () => {},
          }),
        );
      }
    }
  }

  // ───────────────────────── JSON-RPC ─────────────────────────

  request<T = any>(
    method: string,
    params: unknown,
    token?: Monaco.CancellationToken,
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      token?.onCancellationRequested(() => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          this.notify('$/cancelRequest', { id });
          resolve(null as T);
        }
      });

      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private async requestSafe<T>(
    method: string,
    params: unknown,
    token?: Monaco.CancellationToken,
  ): Promise<T | null> {
    try {
      return await this.request<T>(method, params, token);
    } catch (e) {
      console.debug(`[lsp:${this.config.id}] ${method} failed`, e);
      return null;
    }
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: object): void {
    const id = this.serverId;
    if (!id || this.stopped) return;
    const message = JSON.stringify(msg);
    if (LspClient.trace) console.debug(`[lsp:${this.config.id}] →`, msg);
    this.sendChain = this.sendChain
      .then(() => invoke('lsp_send', { id, message }))
      .catch((e) => console.error(`[lsp:${this.config.id}] send failed`, e));
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (LspClient.trace) console.debug(`[lsp:${this.config.id}] ←`, msg);
    if (msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? null);
    } else if (msg.id !== undefined) {
      this.handleServerRequest(msg);
    } else {
      this.handleNotification(msg);
    }
  }

  /** Requests FROM the server. Unanswered ones can stall a server, so always reply. */
  private handleServerRequest(msg: { id: number | string; method: string; params?: any }): void {
    let result: unknown = null;
    switch (msg.method) {
      case 'workspace/configuration':
        result = (msg.params?.items ?? []).map(() => null); // null = "use your defaults"
        break;
      case 'workspace/workspaceFolders':
        result = this.workspaceFolders;
        break;
      case 'workspace/semanticTokens/refresh':
        this.semanticRefresh?.fire();
        break;
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        result = null;
        break;
      default:
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
        return;
    }
    this.send({ jsonrpc: '2.0', id: msg.id, result });
  }

  private handleNotification(msg: { method: string; params?: any }): void {
    switch (msg.method) {
      case 'textDocument/publishDiagnostics': {
        const p = msg.params as PublishDiagnosticsParams;
        this.mon.diagnostics(p.uri, this.monaco.Uri.parse(p.uri).fsPath, p.diagnostics);
        const doc = this.findDoc(p.uri);
        if (!doc || doc.model.isDisposed()) return;
        this.monaco.editor.setModelMarkers(
          doc.model,
          this.owner,
          p.diagnostics.map((d) => conv.toMarker(this.monaco, d)),
        );
        break;
      }
      case 'window/logMessage':
      case 'window/showMessage': {
        const level = (['log', 'error', 'warning', 'info', 'log'] as const)[msg.params?.type ?? 4];
        this.mon.log(level, msg.params?.message);
        console.debug(`[lsp:${this.config.id}]`, msg.params?.message);
        break;
      }
    }
  }
}
