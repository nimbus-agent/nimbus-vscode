import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";

import { discoverSocketPath, type HitlRequest, NimbusClient } from "@nimbus-dev/client";
import * as vscode from "vscode";
import { type ChatController, createChatController } from "./chat/chat-controller.js";
import type { ChatPanel, ChatPanelFactory, WebviewPanelLike } from "./chat/chat-panel.js";
import { createSessionStore } from "./chat/session-store.js";
import { type AutoStarter, createAutoStarter } from "./connection/auto-start.js";
import { type ConnectionState, createConnectionManager } from "./connection/connection-manager.js";
import { createModalSurface } from "./hitl/hitl-modal.js";
import { createHitlRouter, type HitlDecision } from "./hitl/hitl-router.js";
import { createToastSurface } from "./hitl/hitl-toast.js";
import { createLogger, type Logger } from "./logging.js";
import { createSettings } from "./settings.js";
import { type Agent, parseAgents } from "./sidebar/agents.js";
import { createAgentsView } from "./sidebar/agents-view.js";
import { formatAuditDetail } from "./sidebar/audit.js";
import { createAuditView } from "./sidebar/audit-view.js";
import { buildAskPrompt, type IndexItem, parseIndexRow } from "./sidebar/index.js";
import { createIndexView } from "./sidebar/index-view.js";
import { createQuickActions } from "./sidebar/quick-actions.js";
import { parseSessionRow, type SessionSummary } from "./sidebar/sessions.js";
import { createSessionsView } from "./sidebar/sessions-view.js";
import { applyThemeIcons, type SidebarView } from "./sidebar/tree-view.js";
import { createStatusBarController } from "./status-bar/status-bar-item.js";
import type {
  CommandsApi,
  DisposableLike,
  ExtensionContextLike,
  WindowApi,
  WorkspaceApi,
} from "./vscode-shim.js";

// Mirrors the Gateway's session.list query against the local session_memory
// table (reachable through the public read-only querySql).
const SESSIONS_SQL =
  "SELECT session_id AS sessionId, MAX(created_at) AS lastWriteAt, COUNT(*) AS chunkCount " +
  "FROM session_memory GROUP BY session_id ORDER BY lastWriteAt DESC LIMIT 200";

// Newest-N indexed items pulled for the Index view. The Gateway returns them
// already ordered; we cap to keep the tree responsive (cf. the search handler).
const INDEX_LIMIT = 100;

export interface ActivateDeps {
  window: WindowApi;
  workspace: WorkspaceApi;
  commands: CommandsApi;
  openClient?: (socketPath: string) => Promise<NimbusClient>;
  discoverSocket?: typeof discoverSocketPath;
  chatPanelFactory?: (deps: { log: Logger }) => ChatPanelFactory;
  autoStarter?: AutoStarter;
  openReadonlyJson?: (title: string, content: string) => Promise<void>;
  openSource?: (item: IndexItem) => Promise<void>;
}

export function activateWithDeps(
  ctx: ExtensionContextLike,
  deps: ActivateDeps,
): {
  fireConnectionState: (s: ConnectionState) => void;
  fireHitl: (req: HitlRequest) => void;
} {
  const out = deps.window.createOutputChannel("Nimbus");
  ctx.subscriptions.push(out);

  const settings = createSettings(deps.workspace);
  const log = createLogger(out, () => settings.logLevel());
  log.info("Nimbus VS Code extension activating");

  const sessionStore = createSessionStore(ctx.workspaceState);

  const openClient =
    deps.openClient ?? (async (socketPath: string) => await NimbusClient.open({ socketPath }));
  const discoverSocket = deps.discoverSocket ?? discoverSocketPath;

  const connection = createConnectionManager({
    open: openClient,
    discoverSocket: async () => {
      const override = settings.socketPath();
      if (override.length > 0) return { socketPath: override, source: "settings" };
      return await discoverSocket();
    },
    log,
  });
  ctx.subscriptions.push({ dispose: () => void connection.dispose() });

  const autoStart =
    deps.autoStarter ??
    createAutoStarter({
      spawn: (cmd, args) => nodeSpawn(cmd, args, { detached: true, stdio: "ignore" }),
      pingSocket,
      log,
    });
  let autoStartInFlight = false;

  const statusItem = deps.window.createStatusBarItem(2, 100);
  ctx.subscriptions.push(statusItem);
  const statusBar = createStatusBarController(statusItem);
  ctx.subscriptions.push(statusBar);

  let pendingHitlCount = 0;
  const renderStatusBar = (s: ConnectionState): void => {
    statusBar.update({
      connection: s,
      profile: "",
      degradedConnectorCount: 0,
      degradedConnectorNames: [],
      pendingHitlCount,
      autoStartGateway: settings.autoStartGateway(),
    });
  };

  const chatPanelFactory = deps.chatPanelFactory?.({ log }) ?? createRealChatPanelFactory(log);

  let chatController: ChatController | undefined;
  let activeAgent: string | undefined;
  const registeredHitlStreams = new Set<string>();

  const ensureChatController = (): ChatController | undefined => {
    if (chatController !== undefined) return chatController;
    const c = connection.client();
    if (c === undefined) {
      void deps.window.showErrorMessage(
        'Nimbus is not connected to the Gateway yet. Try again in a moment, or run "Nimbus: Reconnect to Gateway".',
      );
      return undefined;
    }
    const panel = chatPanelFactory.createOrReveal();
    chatController = createChatController({
      client: c as unknown as Parameters<typeof createChatController>[0]["client"],
      panel,
      sessionStore,
      registerStreamWithHitl: (id) => registeredHitlStreams.add(id),
      unregisterStreamWithHitl: (id) => {
        registeredHitlStreams.delete(id);
      },
      log,
      agent: () => activeAgent ?? settings.askAgent(),
    });
    panel.onMessage((msg) => {
      if (msg === null || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      const t = m["type"];
      if (typeof t !== "string") return;
      void handleWebviewMessage(t, m);
    });
    panel.onDispose(() => {
      chatController = undefined;
      for (const [, resolve] of pendingInlineHitl) resolve(undefined);
      pendingInlineHitl.clear();
    });
    return chatController;
  };

  const onReady = (): void => {
    void chatController?.rehydrateIfNeeded(settings.transcriptHistoryLimit());
  };

  const onSubmitAsk = async (msg: Record<string, unknown>): Promise<void> => {
    const text = m_str(msg, "text").trim();
    if (text.length === 0) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    try {
      await ctl.start(text);
    } catch (e) {
      log.error(`submitAsk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onStopStream = async (): Promise<void> => {
    try {
      await chatController?.stop();
    } catch (e) {
      log.warn(`stopStream failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onHitlResponse = (msg: Record<string, unknown>): void => {
    const requestId = m_str(msg, "requestId");
    const decision = m_str(msg, "decision");
    if (requestId.length === 0) return;
    const resolver = pendingInlineHitl.get(requestId);
    if (resolver === undefined) return;
    pendingInlineHitl.delete(requestId);
    const valid = decision === "approve" || decision === "reject";
    resolver(valid ? decision : undefined);
  };

  const onOpenExternal = async (msg: Record<string, unknown>): Promise<void> => {
    const url = m_str(msg, "url");
    if (url.length === 0) return;
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (e) {
      log.warn(`openExternal failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const messageHandlers: Record<string, (msg: Record<string, unknown>) => unknown> = {
    ready: onReady,
    requestRehydrate: onReady,
    submitAsk: onSubmitAsk,
    stopStream: onStopStream,
    hitlResponse: onHitlResponse,
    openLogs: () => out.show(true),
    startGateway: () => deps.commands.executeCommand("nimbus.startGateway"),
    openExternal: onOpenExternal,
  };

  const handleWebviewMessage = async (
    type: string,
    msg: Record<string, unknown>,
  ): Promise<void> => {
    const handler = messageHandlers[type];
    if (handler === undefined) return;
    await handler(msg);
  };

  const pendingInlineHitl = new Map<string, (d: HitlDecision | undefined) => void>();
  const showInlineInWebview = createInlineHitlSurface({
    getPanel: () => chatPanelFactory.current(),
    pending: pendingInlineHitl,
    fallback: createToastSurface(deps.window),
  });

  const hitlRouter = createHitlRouter({
    chatPanelVisibleAndFocused: () => {
      const p = chatPanelFactory.current();
      return p?.isVisible() === true && p.isActive();
    },
    streamRegistered: (streamId) => registeredHitlStreams.has(streamId),
    showInline: showInlineInWebview,
    showToast: createToastSurface(deps.window),
    showModal: createModalSurface(deps.window),
    sendResponse: async (requestId, decision) => {
      const c = connection.client() as NimbusClient | undefined;
      if (c === undefined) {
        log.warn("HITL response dropped: no Gateway connection");
        return;
      }
      try {
        await sendConsentResponse(c, requestId, decision);
      } catch (e) {
        log.error(`HITL sendResponse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    onCountChange: (count) => {
      pendingHitlCount = count;
      renderStatusBar(connection.current());
    },
    alwaysModal: () => settings.hitlAlwaysModal(),
  });

  let hitlSubscription: DisposableLike | undefined;
  const stateSub = connection.onState((s) => {
    renderStatusBar(s);
    if (s.kind === "connected") {
      const c = connection.client() as NimbusClient | undefined;
      if (c !== undefined) {
        if (hitlSubscription !== undefined) {
          try {
            hitlSubscription.dispose();
          } catch {
            /* ignore */
          }
        }
        hitlSubscription = c.subscribeHitl((req) => {
          void hitlRouter.handle(req);
        });
      }
      log.info(`Nimbus connected to Gateway at ${s.socketPath}`);
      return;
    }
    if (s.kind === "disconnected" && settings.autoStartGateway() && !autoStartInFlight) {
      autoStartInFlight = true;
      void (async (): Promise<void> => {
        try {
          const r = await autoStart.spawn(s.socketPath);
          if (r.kind === "ok") {
            await connection.reconnectNow();
          } else if (r.kind === "spawn-error") {
            log.error(`Auto-start failed: ${r.message}`);
          } else {
            log.warn(`Auto-start timeout waiting for ${r.socketPath}`);
          }
        } finally {
          autoStartInFlight = false;
        }
      })();
    }
  });
  ctx.subscriptions.push(
    { dispose: () => stateSub.dispose() },
    {
      dispose: () => {
        if (hitlSubscription !== undefined) hitlSubscription.dispose();
      },
    },
  );

  const cfgSub = deps.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("nimbus")) renderStatusBar(connection.current());
    if (e.affectsConfiguration("nimbus.agents")) agentsView.refresh();
  });
  ctx.subscriptions.push(cfgSub);

  // Sidebar tree views (design surfaces #1/#3/#5/#6). All four are live (Audit,
  // Agents, Index, Sessions). Each refreshes off connection state and degrades
  // gracefully when the Gateway is unreachable.
  const auditView = createAuditView({
    connection,
    getClient: () => connection.client() as NimbusClient | undefined,
  });
  const loadSessions = async (): Promise<SessionSummary[]> => {
    const client = connection.client() as NimbusClient | undefined;
    if (client === undefined) return [];
    try {
      const result = await client.querySql(SESSIONS_SQL);
      const sessions: SessionSummary[] = [];
      for (const row of result.rows) {
        const parsed = parseSessionRow(row);
        if (parsed !== undefined) sessions.push(parsed);
      }
      return sessions;
    } catch (e) {
      // e.g. an older Gateway without the session_memory table. Log a trail,
      // then rethrow so the view renders its "Failed to load sessions" row.
      log.warn(`loadSessions querySql failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  // Session list comes from the Gateway's session_memory table via the public
  // querySql (mirrors the Gateway's own session.list query). This schema
  // coupling is isolated here so the view stays pure; swap for a typed
  // client.listSessions() once the client exposes one.
  const sessionsView = createSessionsView({ connection, loadSessions });
  // Indexed items come from the Gateway via the public queryItems IPC. The
  // schema coupling (field names) is isolated here so the view stays pure; swap
  // for a typed client method once one exists.
  const loadIndex = async (): Promise<IndexItem[]> => {
    const client = connection.client() as NimbusClient | undefined;
    if (client === undefined) return [];
    try {
      const { items } = await client.queryItems({ limit: INDEX_LIMIT });
      const result: IndexItem[] = [];
      for (const row of items) {
        const parsed = parseIndexRow(row);
        if (parsed !== undefined) result.push(parsed);
      }
      return result;
    } catch (e) {
      log.warn(`loadIndex queryItems failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  const indexView = createIndexView({ connection, loadIndex });
  const loadAgents = (): Agent[] => parseAgents(settings.agents());
  const agentsView = createAgentsView({
    connection,
    loadAgents,
    activeAgentId: () => activeAgent,
  });
  const sidebarViews: ReadonlyArray<[string, SidebarView]> = [
    ["nimbus.auditView", auditView],
    ["nimbus.agentsView", agentsView],
    ["nimbus.indexView", indexView],
    ["nimbus.sessionsView", sessionsView],
  ];
  for (const [viewId, view] of sidebarViews) {
    ctx.subscriptions.push(
      deps.window.registerTreeDataProvider(
        viewId,
        applyThemeIcons(view, (id) => new vscode.ThemeIcon(id)),
      ),
    );
    ctx.subscriptions.push({ dispose: () => view.dispose() });
  }

  const openReadonlyJson = deps.openReadonlyJson ?? createReadonlyJsonOpener(ctx);
  const openSource = deps.openSource ?? createSourceOpener();

  const quickActions = createQuickActions({ window: deps.window, commands: deps.commands });

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    ctx.subscriptions.push(deps.commands.registerCommand(id, handler));
  };

  register("nimbus.ask", async () => {
    const input = await deps.window.showInputBox({ prompt: "Ask Nimbus" });
    if (input === undefined || input.trim().length === 0) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.start(input.trim());
  });

  register("nimbus.askAboutSelection", async () => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) {
      void deps.window.showErrorMessage("Nimbus: select text first.");
      return;
    }
    const selection = editor.document.getText(editor.selection);
    const trimmed = typeof selection === "string" ? selection.trim() : "";
    if (trimmed.length === 0) return;
    const prefix = await deps.window.showInputBox({
      prompt: "Ask about the selected code",
      value: "Explain this:",
    });
    if (prefix === undefined) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.start(`${prefix.trim()}\n\n${trimmed}`);
  });

  register("nimbus.search", async () => {
    const c = connection.client() as NimbusClient | undefined;
    if (c === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
      return;
    }
    const q = await deps.window.showInputBox({ prompt: "Search local index" });
    if (q === undefined || q.trim().length === 0) return;
    try {
      const r = await c.queryItems({ limit: 50 });
      const items = r.items.map((it) => ({
        // NimbusItem fields: name (not title) and url (there is no path).
        label: displayText(it["name"]) ?? displayText(it["id"]) ?? "(untitled)",
        description: displayText(it["service"]) ?? "",
        detail: displayText(it["url"]) ?? "",
      }));
      await deps.window.showQuickPick(items, {
        placeHolder: `${items.length} results for "${q.trim()}"`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } catch (e) {
      log.error(`nimbus.search failed: ${e instanceof Error ? e.message : String(e)}`);
      void deps.window.showErrorMessage(
        `Nimbus search failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  register("nimbus.searchSelection", async () => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) {
      void deps.window.showErrorMessage("Nimbus: select text first.");
      return;
    }
    await deps.commands.executeCommand("nimbus.search");
  });

  register("nimbus.newConversation", async () => {
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.newConversation();
  });

  register("nimbus.startGateway", async () => {
    const cur = connection.current();
    const target = cur.kind === "idle" ? "" : ((cur as { socketPath?: string }).socketPath ?? "");
    const r = await autoStart.spawn(target);
    if (r.kind === "ok") {
      await connection.reconnectNow();
    } else if (r.kind === "spawn-error") {
      void deps.window.showErrorMessage(`Could not start Nimbus Gateway: ${r.message}`);
    } else {
      void deps.window.showErrorMessage(
        `Timed out waiting for Nimbus Gateway socket at ${r.socketPath}.`,
      );
    }
  });

  register("nimbus.reconnect", async () => {
    await connection.reconnectNow();
  });

  register("nimbus.openLogs", () => {
    out.show(true);
  });

  register("nimbus.quickActions", async () => {
    await quickActions.show();
  });

  register("nimbus.refreshAudit", () => {
    auditView.refresh();
  });

  register("nimbus.refreshSessions", () => {
    sessionsView.refresh();
  });

  register("nimbus.refreshIndex", () => {
    indexView.refresh();
  });

  register("nimbus.openIndexItem", async (...args) => {
    // Primary-click command: args[0] is the IndexItem we put in the row's
    // command.arguments. Re-validate it defensively through parseIndexRow.
    const item = parseIndexRow(args[0]);
    if (item === undefined || item.url === undefined) return;
    try {
      await openSource(item);
    } catch (e) {
      void deps.window.showWarningMessage(
        `Couldn't open ${item.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  register("nimbus.askAboutIndexItem", async (...args) => {
    // A view/item/context command receives the tree NODE element (a SidebarItem),
    // NOT the row's command.arguments. The IndexItem rides along on node.payload
    // (see itemToRow). openIndexItem differs: it's the row's primary command, so
    // it gets command.arguments[0] (the IndexItem) directly.
    const node = args[0];
    const payload =
      typeof node === "object" && node !== null
        ? (node as { payload?: unknown }).payload
        : undefined;
    const item = parseIndexRow(payload);
    if (item === undefined) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.start(buildAskPrompt(item));
  });

  register("nimbus.openSession", async (...args) => {
    const sessionId = typeof args[0] === "string" ? args[0] : "";
    if (sessionId.length === 0) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    await ctl.resume(sessionId, settings.transcriptHistoryLimit());
  });

  register("nimbus.openAuditEntry", async (...args) => {
    const detail = formatAuditDetail(args[0]);
    if (detail === undefined) return;
    await openReadonlyJson(detail.title, detail.content);
  });

  register("nimbus.showPendingHitl", () => {
    if (hitlRouter.snapshot().length === 0) return;
    chatPanelFactory.current()?.reveal();
  });

  void connection.start();

  log.info(`Nimbus extension activated; ${ctx.subscriptions.length} disposable(s) registered`);

  return {
    fireConnectionState: (s) => renderStatusBar(s),
    fireHitl: (req) => void hitlRouter.handle(req),
  };
}

export function activate(ctx: vscode.ExtensionContext): void {
  activateWithDeps(ctx, {
    window: vscode.window as unknown as WindowApi, // NOSONAR S4325: vscode.window is structurally wider than WindowApi; bridge required
    workspace: vscode.workspace,
    commands: vscode.commands,
  });
}

export function deactivate(): void {
  // VS Code disposes ctx.subscriptions automatically; nothing extra to do.
}

export { renderDetailsHtml } from "./hitl/hitl-details-webview.js";

async function sendConsentResponse(
  client: NimbusClient,
  requestId: string,
  decision: HitlDecision,
): Promise<void> {
  const ipc = (
    client as unknown as {
      ipc: { call: (m: string, p: unknown) => Promise<unknown> };
    }
  ).ipc;
  await ipc.call("consent.respond", { requestId, decision });
}

function m_str(msg: Record<string, unknown>, key: string): string {
  const v = msg[key];
  return typeof v === "string" ? v : "";
}

export interface InlineHitlReq {
  requestId: string;
  prompt: string;
  details?: unknown;
}

export function createInlineHitlSurface(args: {
  getPanel: () => ChatPanel | undefined;
  pending: Map<string, (d: HitlDecision | undefined) => void>;
  fallback: (req: InlineHitlReq) => Promise<HitlDecision | undefined>;
}): (req: InlineHitlReq) => Promise<HitlDecision | undefined> {
  return async (req) => {
    const panel = args.getPanel();
    if (panel === undefined) return await args.fallback(req);
    return await new Promise<HitlDecision | undefined>((resolve) => {
      args.pending.set(req.requestId, resolve);
      const payload: Record<string, unknown> = {
        type: "hitlInline",
        requestId: req.requestId,
        prompt: req.prompt,
      };
      if (req.details !== undefined) payload["details"] = req.details;
      void panel.postMessage(payload);
    });
  };
}

// Coerce an unknown index field to a display string, ignoring non-primitives so
// search results never render Object's "[object Object]" default (Sonar S6551).
function displayText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

// Opens read-only JSON in an editor tab via a custom-scheme content provider.
// The provider is registered lazily on first use; each call gets a unique URI
// so VS Code re-resolves the content. The `.json` path extension drives syntax
// highlighting. Injectable as deps.openReadonlyJson so tests don't touch vscode.
function createReadonlyJsonOpener(
  ctx: ExtensionContextLike,
): (title: string, content: string) => Promise<void> {
  const scheme = "nimbus-audit";
  // Bound retained content so a long session of opening entries can't grow the
  // map without limit (Map preserves insertion order → oldest evicts first).
  const MAX_DOCS = 50;
  const docs = new Map<string, string>();
  let seq = 0;
  let registered = false;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => docs.get(uri.path) ?? "",
  };
  return async (title, content) => {
    if (!registered) {
      ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(scheme, provider),
      );
      registered = true;
    }
    seq += 1;
    const path = `/${seq}/${title}`;
    docs.set(path, content);
    while (docs.size > MAX_DOCS) {
      const oldest = docs.keys().next().value;
      if (oldest === undefined) break;
      docs.delete(oldest);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${scheme}:${path}`));
    await vscode.window.showTextDocument(doc, { preview: true });
  };
}

function createSourceOpener(): (item: IndexItem) => Promise<void> {
  return async (item) => {
    const url = item.url;
    if (url === undefined || url.length === 0) return;
    // A Windows drive path (C:\...) is NOT a URI scheme — `C:` would otherwise
    // parse as scheme "c". Treat it, and any bare path, as a file Uri; only a
    // real >=2-char scheme (http/https/file/mailto/...) goes through Uri.parse.
    const isWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(url);
    const uri =
      !isWindowsDrivePath && /^[a-z][a-z0-9+.-]+:/i.test(url)
        ? vscode.Uri.parse(url)
        : vscode.Uri.file(url);
    if (uri.scheme === "file") {
      await vscode.commands.executeCommand("vscode.open", uri);
    } else {
      // openExternal resolves `false` (it does not throw) when the OS handler
      // declines; surface that through the command's catch -> warning path.
      const ok = await vscode.env.openExternal(uri);
      if (!ok) throw new Error("the system declined to open this URL");
    }
  };
}

async function pingSocket(socketPath: string): Promise<boolean> {
  if (socketPath.length === 0) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const sock = netConnect(socketPath);
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
    setTimeout(() => settle(false), 500);
  });
}

function createRealChatPanelFactory(log: Logger): ChatPanelFactory {
  let current: ChatPanel | undefined;
  const mediaRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), "..", "media");

  return {
    createOrReveal(): ChatPanel {
      if (current !== undefined) {
        current.reveal();
        return current;
      }
      const panel = vscode.window.createWebviewPanel(
        "nimbus.chat",
        "Nimbus",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [mediaRoot],
        },
      );
      panel.webview.html = renderChatHtml(panel.webview, mediaRoot);
      const wrapper = wrapWebviewPanel(panel, log, () => {
        current = undefined;
      });
      current = wrapper;
      return wrapper;
    },
    current(): ChatPanel | undefined {
      return current;
    },
  };
}

function wrapWebviewPanel(
  panel: vscode.WebviewPanel,
  log: Logger,
  onDisposed: () => void,
): ChatPanel {
  const disposeListeners: Array<() => void> = [];
  panel.onDidDispose(() => {
    onDisposed();
    for (const l of disposeListeners) {
      try {
        l();
      } catch (e) {
        log.warn(
          `chatPanel onDispose handler threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  });
  const webviewLike = {
    cspSource: panel.webview.cspSource,
    asWebviewUri: (p: string) => panel.webview.asWebviewUri(vscode.Uri.parse(p)).toString(),
    get html(): string {
      return panel.webview.html;
    },
    set html(v: string) {
      panel.webview.html = v;
    },
    postMessage: (m: unknown) => panel.webview.postMessage(m),
    onDidReceiveMessage: (h: (msg: unknown) => void) => panel.webview.onDidReceiveMessage(h),
  };
  const panelLike: WebviewPanelLike = {
    get visible(): boolean {
      return panel.visible;
    },
    get active(): boolean {
      return panel.active;
    },
    webview: webviewLike,
    reveal: () => panel.reveal(),
    dispose: () => panel.dispose(),
    onDidDispose: (h) => panel.onDidDispose(h),
    onDidChangeViewState: (h) => panel.onDidChangeViewState(h),
  };
  return {
    reveal: () => panel.reveal(),
    dispose: () => panel.dispose(),
    panel: () => panelLike,
    onDispose: (h) => disposeListeners.push(h),
    onMessage: (h) => panel.webview.onDidReceiveMessage(h),
    postMessage: (m) => panel.webview.postMessage(m),
    isVisible: () => panel.visible,
    isActive: () => panel.active,
  };
}

function renderChatHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview.css"));
  const nonce = randomUUID().replaceAll("-", "");
  const csp =
    `default-src 'none'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource}; ` +
    `script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Nimbus</title>
<link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
<main id="root">
  <section id="empty-mount" aria-live="polite"></section>
  <section id="transcript" aria-live="polite" aria-relevant="additions"></section>
  <section id="hitl-mount" aria-live="assertive"></section>
  <footer id="footer">
    <div id="status-row">
      <ul id="subtask-list"></ul>
      <span id="status"></span>
    </div>
    <form id="input-form">
      <textarea id="input-text" rows="2" placeholder="Ask Nimbus… (Cmd/Ctrl+Enter to send)"></textarea>
      <button type="submit" id="input-send">Send</button>
      <button type="button" id="input-stop" disabled>Stop</button>
    </form>
  </footer>
</main>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
