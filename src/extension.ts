import { spawn as nodeSpawn } from "node:child_process";

import { discoverSocketPath, type HitlRequest, NimbusClient } from "@nimbus-dev/client";
import * as vscode from "vscode";
import { type ChatController, createChatController } from "./chat/chat-controller.js";
import type { ChatPanel, ChatPanelFactory } from "./chat/chat-panel.js";
import { createRealChatPanelFactory } from "./chat/real-chat-panel.js";
import { createSessionStore } from "./chat/session-store.js";
import type {
  ParticipantClientLike,
  ParticipantDeps,
} from "./chat-participant/participant-types.js";
import { registerNimbusChatParticipant } from "./chat-participant/real-participant.js";
import { type AutoStarter, createAutoStarter } from "./connection/auto-start.js";
import { type ConnectionState, createConnectionManager } from "./connection/connection-manager.js";
import { pingSocket } from "./connection/ping-socket.js";
import { buildTroubleshooter, type PingOutcome } from "./connection/troubleshooter.js";
import { createModalSurface } from "./hitl/hitl-modal.js";
import { createHitlRouter, type HitlDecision } from "./hitl/hitl-router.js";
import { createToastSurface } from "./hitl/hitl-toast.js";
import type { LmToolsDeps } from "./lm-tools/lm-tools.js";
import { registerNimbusLmTools } from "./lm-tools/real-lm-tools.js";
import { createLogger, errMsg, type Logger } from "./logging.js";
import {
  buildQuickAskPrompt,
  clampContext,
  extractReply,
  QUICK_ASK_MAX_CONTEXT_CHARS,
  redactPath,
  validateQuestion,
} from "./quick-ask.js";
import { type QuickAskPreset, resolvePresets } from "./quick-ask-presets.js";
import { createScmCommands } from "./scm/commands.js";
import type { GitApiLike } from "./scm/git-types.js";
import { createRealGitApi } from "./scm/real-git.js";
import {
  buildPicks,
  normalizeInline,
  type RankedResult,
  type SearchPick,
  sameName,
  statusPick,
} from "./search.js";
import { createSettings } from "./settings.js";
import { type Agent, parseAgents } from "./sidebar/agents.js";
import { createAgentsView } from "./sidebar/agents-view.js";
import { formatAuditDetail } from "./sidebar/audit.js";
import { createAuditView } from "./sidebar/audit-view.js";
import { buildProofDocument, egressWindowPresets, formatEgressDetail } from "./sidebar/egress.js";
import { createEgressView } from "./sidebar/egress-view.js";
import { buildAskPrompt, type IndexItem, parseIndexRow } from "./sidebar/index.js";
import { createIndexView } from "./sidebar/index-view.js";
import { createQuickActions } from "./sidebar/quick-actions.js";
import type { SessionSummary } from "./sidebar/sessions.js";
import { createSessionsView } from "./sidebar/sessions-view.js";
import { applyThemeIcons, type SidebarView } from "./sidebar/tree-view.js";
import { summarizeConnectorHealth } from "./status-bar/connector-health.js";
import {
  createEgressStatusBarController,
  type EgressBadgeInputs,
} from "./status-bar/egress-status-bar-item.js";
import { createStatusBarController, type StatusBarInputs } from "./status-bar/status-bar-item.js";
import type {
  CommandsApi,
  DisposableLike,
  ExtensionContextLike,
  QuickPickItemLike,
  WindowApi,
  WorkspaceApi,
} from "./vscode-shim.js";
import { PROGRESS_LOCATION_NOTIFICATION } from "./vscode-shim.js";

// Newest-N indexed items pulled for the Index view. The Gateway returns them
// already ordered; we cap to keep the tree responsive (cf. the search handler).
const INDEX_LIMIT = 100;

// Type-to-search debounce.
const SEARCH_DEBOUNCE_MS = 200;
const SELECTION_PREFILL_MAX = 150;

// A quick-ask picker row: a preset action, or (no `preset`) the custom-question
// row. The handler keys off the presence of `preset`, not the label text, so a
// user-defined preset named "Custom question…" is never mistaken for the custom
// row.
type QuickAskPick = QuickPickItemLike & { preset?: QuickAskPreset };

export interface ActivateDeps {
  window: WindowApi;
  workspace: WorkspaceApi;
  commands: CommandsApi;
  openClient?: (socketPath: string) => Promise<NimbusClient>;
  discoverSocket?: typeof discoverSocketPath;
  chatPanelFactory?: (deps: { log: Logger }) => ChatPanelFactory;
  registerChatParticipant?: (opts: { deps: ParticipantDeps; log: Logger }) => { dispose(): void };
  registerLmTools?: (opts: { deps: LmToolsDeps }) => DisposableLike;
  autoStarter?: AutoStarter;
  openReadonlyJson?: (title: string, content: string) => Promise<void>;
  openSource?: (item: { url?: string }) => Promise<void>;
  saveJson?: (defaultName: string, content: string) => Promise<{ fsPath: string } | undefined>;
  searchDebounceMs?: number;
  git?: () => Promise<GitApiLike | undefined>;
  openUntitled?: (opts: { fileName: string; content: string }) => Promise<void>;
  openDiff?: (opts: {
    title: string;
    left: string;
    right: string;
    fileName: string;
  }) => Promise<void>;
  selectionOffsets?: () => { start: number; end: number } | undefined;
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

  // The connection manager is typed to the minimal NimbusClientLike; every real
  // call site needs the full NimbusClient. Narrow it in one place.
  const nimbus = (): NimbusClient | undefined => connection.client() as NimbusClient | undefined;

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

  const egressStatusItem = deps.window.createStatusBarItem(2, 99);
  ctx.subscriptions.push(egressStatusItem);
  const egressBadge = createEgressStatusBarController(egressStatusItem);
  ctx.subscriptions.push(egressBadge);
  let egressLastKnownCount: number | undefined;
  let egressPollSeq = 0;

  const pollEgressBadge = async (): Promise<void> => {
    const mine = ++egressPollSeq;
    const connected = connection.current().kind === "connected";
    const showBadge = settings.showEgressStatusBarBadge();
    const base: EgressBadgeInputs = {
      head: undefined,
      lastKnownCount: egressLastKnownCount,
      error: undefined,
      connected,
      showBadge,
    };
    if (!connected || !showBadge) {
      egressBadge.update(base);
      return;
    }
    const client = nimbus();
    if (client === undefined) {
      egressBadge.update({ ...base, connected: false });
      return;
    }
    try {
      const head = await client.egressHead();
      if (mine !== egressPollSeq) return; // a newer poll superseded this one
      egressLastKnownCount = head.count;
      egressBadge.update({ ...base, head, lastKnownCount: head.count });
    } catch (e) {
      if (mine !== egressPollSeq) return;
      log.warn(`egressHead poll failed: ${errMsg(e)}`);
      egressBadge.update({ ...base, error: errMsg(e) });
    }
  };

  let pendingHitlCount = 0;
  let connectorHealth: { count: number; names: string[] } = { count: 0, names: [] };
  let connectorPollSeq = 0;
  const statusInputs = (s: ConnectionState): StatusBarInputs => ({
    connection: s,
    profile: "",
    degradedConnectorCount: connectorHealth.count,
    degradedConnectorNames: connectorHealth.names,
    pendingHitlCount,
    autoStartGateway: settings.autoStartGateway(),
  });
  // The status bar can be rendered from an externally supplied state (see
  // fireConnectionState), so the async poll re-renders from the last state the
  // bar actually showed — never from connection.current(), which may disagree.
  let lastRenderedConnection: ConnectionState = connection.current();
  const pollConnectorHealth = async (): Promise<void> => {
    const mine = ++connectorPollSeq;
    const client = nimbus();
    if (lastRenderedConnection.kind !== "connected" || client === undefined) {
      connectorHealth = { count: 0, names: [] };
      return;
    }
    try {
      const statuses = await client.connectorListStatus();
      if (mine !== connectorPollSeq) return; // a newer poll superseded this one
      connectorHealth = summarizeConnectorHealth(statuses);
    } catch (e) {
      if (mine !== connectorPollSeq) return;
      log.warn(`connectorListStatus poll failed: ${errMsg(e)}`);
      connectorHealth = { count: 0, names: [] };
    }
    statusBar.update(statusInputs(lastRenderedConnection));
  };

  const pollStatusBar = (): void => {
    void pollEgressBadge();
    void pollConnectorHealth();
  };
  let egressTimer = setInterval(pollStatusBar, settings.statusBarPollMs());
  ctx.subscriptions.push({ dispose: () => clearInterval(egressTimer) });
  pollStatusBar();

  const renderStatusBar = (s: ConnectionState): void => {
    lastRenderedConnection = s;
    statusBar.update(statusInputs(s));
    pollStatusBar();
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
      log.error(`submitAsk failed: ${errMsg(e)}`);
    }
  };

  const onStopStream = async (): Promise<void> => {
    try {
      await chatController?.stop();
    } catch (e) {
      log.warn(`stopStream failed: ${errMsg(e)}`);
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
      log.warn(`openExternal failed: ${errMsg(e)}`);
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
      const c = nimbus();
      if (c === undefined) {
        log.warn("HITL response dropped: no Gateway connection");
        return;
      }
      try {
        await sendConsentResponse(c, requestId, decision);
      } catch (e) {
        log.error(`HITL sendResponse failed: ${errMsg(e)}`);
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
    void deps.commands.executeCommand("setContext", "nimbus.connected", s.kind === "connected");
    if (s.kind === "connected") {
      const c = nimbus();
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
    if (e.affectsConfiguration("nimbus")) {
      renderStatusBar(connection.current());
    }
    if (e.affectsConfiguration("nimbus.agents")) agentsView.refresh();
    if (e.affectsConfiguration("nimbus.statusBarPollMs")) {
      clearInterval(egressTimer);
      egressTimer = setInterval(pollStatusBar, settings.statusBarPollMs());
    }
  });
  ctx.subscriptions.push(cfgSub);

  // Sidebar tree views (design surfaces #1/#3/#5/#6). All four are live (Audit,
  // Agents, Index, Sessions). Each refreshes off connection state and degrades
  // gracefully when the Gateway is unreachable.
  const auditView = createAuditView({
    connection,
    getClient: () => nimbus(),
  });
  const egressView = createEgressView({
    connection,
    getClient: () => nimbus(),
  });
  const refreshEgress = (): void => {
    egressView.refresh();
    void pollEgressBadge();
  };
  const loadSessions = async (): Promise<SessionSummary[]> => {
    const client = nimbus();
    if (client === undefined) return [];
    try {
      const { sessions } = await client.sessionList();
      return sessions;
    } catch (e) {
      // e.g. an older Gateway without session.list. Log a trail, then rethrow
      // so the view renders its "Failed to load sessions" row.
      log.warn(`loadSessions sessionList failed: ${errMsg(e)}`);
      throw e;
    }
  };
  const sessionsView = createSessionsView({ connection, loadSessions });
  // Indexed items come from the Gateway via the public queryItems IPC. The
  // schema coupling (field names) is isolated here so the view stays pure; swap
  // for a typed client method once one exists.
  const loadIndex = async (): Promise<IndexItem[]> => {
    const client = nimbus();
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
      log.warn(`loadIndex queryItems failed: ${errMsg(e)}`);
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
    ["nimbus.egressView", egressView],
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
      { dispose: () => view.dispose() },
    );
  }

  const openReadonlyJson = deps.openReadonlyJson ?? createReadonlyJsonOpener(ctx);
  const openSource = deps.openSource ?? createSourceOpener();
  const saveJson = deps.saveJson ?? createProofSaver();
  const openUntitled = deps.openUntitled ?? createUntitledOpener();
  const openDiff = deps.openDiff ?? createDiffOpener(ctx);
  // Computed here because it needs the real editor's Position→offset mapping;
  // the shim's TextEditorLike deliberately stays narrow.
  const selectionOffsets =
    deps.selectionOffsets ??
    ((): { start: number; end: number } | undefined => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || editor.selection.isEmpty) return undefined;
      return {
        start: editor.document.offsetAt(editor.selection.start),
        end: editor.document.offsetAt(editor.selection.end),
      };
    });

  const scm = createScmCommands({
    git: deps.git ?? createRealGitApi(log),
    client: () => {
      const client = nimbus();
      return client === undefined ? undefined : { agentInvoke: (i, o) => client.agentInvoke(i, o) };
    },
    window: deps.window,
    agent: () => settings.askAgent(),
    skipSecretFiles: () => settings.scmSkipSecretFiles(),
    selectionOffsets,
    openReadonly: openReadonlyJson,
    openUntitled,
    openDiff,
    log,
  });

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
    // Clamp and redact on the same terms as quick-ask and the chat participant:
    // an unbounded selection (a minified bundle, a pasted log) must not go to the
    // Gateway verbatim, and the absolute path would leak the OS username and
    // directory layout into the agent context and the egress ledger.
    const { code, truncated } = clampContext(trimmed, QUICK_ASK_MAX_CONTEXT_CHARS);
    if (truncated) {
      void deps.window.showWarningMessage(
        `Nimbus: context truncated to ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`,
      );
    }
    await ctl.start(
      buildQuickAskPrompt({
        question: prefix,
        code,
        filePath: redactPath(editor.document.fileName),
        languageId: editor.document.languageId,
        truncated,
      }),
    );
  });

  const runSearch = (
    initialValue?: string,
    opts?: { placeholder?: string; exclude?: (r: RankedResult) => boolean },
  ): void => {
    const client = nimbus();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
      return;
    }
    const qp = deps.window.createQuickPick<SearchPick>();
    qp.placeholder = opts?.placeholder ?? "Search the local Nimbus index";
    // alwaysShow on every result makes these largely moot (VS Code can't filter
    // out our rows), but set both for parity with the intended UX.
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const debounceMs = deps.searchDebounceMs ?? SEARCH_DEBOUNCE_MS;
    let seq = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const runQuery = async (value: string): Promise<void> => {
      const mine = ++seq;
      const q = value.trim();
      if (q.length === 0) {
        qp.items = [];
        qp.busy = false;
        return;
      }
      qp.busy = true;
      try {
        const rows = await client.searchRanked({ name: q, limit: settings.searchLimit() });
        if (disposed || mine !== seq) return; // pick closed, or a newer keystroke won
        const picks = buildPicks(rows, opts?.exclude);
        qp.items = picks.length > 0 ? picks : [statusPick("No matching index records")];
      } catch (e) {
        if (disposed || mine !== seq) return;
        log.error(`nimbus.search failed: ${errMsg(e)}`);
        qp.items = [];
        void deps.window.showErrorMessage(`Nimbus search failed: ${errMsg(e)}`);
      } finally {
        if (!disposed && mine === seq) qp.busy = false;
      }
    };

    qp.onDidChangeValue((value) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void runQuery(value), debounceMs);
    });

    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0];
      if (pick === undefined || pick.isStatus === true) return;
      if (pick.canOpen && pick.url !== undefined) {
        const url = pick.url;
        void openSource({ url }).catch((e) => {
          void deps.window.showWarningMessage(`Couldn't open "${pick.label}": ${errMsg(e)}`);
        });
      } else {
        void deps.window.showInformationMessage(`No source to open for "${pick.label}".`, {});
      }
      qp.hide();
    });

    qp.onDidHide(() => {
      disposed = true; // guard in-flight runQuery from writing to a disposed pick
      if (timer !== undefined) clearTimeout(timer);
      qp.dispose();
    });

    if (initialValue !== undefined) {
      const seed = normalizeInline(initialValue, SELECTION_PREFILL_MAX);
      qp.value = seed;
      // Query directly rather than relying on onDidChangeValue: in real VS Code,
      // setting .value may or may not fire an onDidChangeValue echo, so we can't
      // depend on it to kick off the search. If it does fire, the resulting
      // duplicate runQuery("...") is harmless — the latest-wins `seq` guard
      // dedupes it against this call.
      void runQuery(seed);
    }
    qp.show();
  };

  register("nimbus.search", () => {
    runSearch();
  });

  register("nimbus.searchSelection", () => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) {
      void deps.window.showErrorMessage("Nimbus: select text first.");
      return;
    }
    runSearch(editor.document.getText(editor.selection));
  });

  register("nimbus.findRelated", () => {
    const editor = deps.window.activeTextEditor;
    const selection =
      editor !== undefined && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : "";
    if (selection.trim().length === 0) {
      void deps.window.showErrorMessage("Nimbus: select text to find related items.");
      return;
    }
    runSearch(selection, { placeholder: "Related to selection…", exclude: sameName(selection) });
  });

  register("nimbus.findRelatedFromIndex", (...args) => {
    // view/item/context command: args[0] is the tree NODE; the IndexItem rides
    // on node.payload (see itemToRow), mirroring nimbus.askAboutIndexItem.
    const node = args[0];
    const payload =
      typeof node === "object" && node !== null
        ? (node as { payload?: unknown }).payload
        : undefined;
    const item = parseIndexRow(payload);
    if (item === undefined) return;
    const byName = sameName(item.name);
    const exclude = (r: RankedResult): boolean =>
      (item.url !== undefined && r.url === item.url) || byName(r);
    runSearch(item.name, { placeholder: `Related to "${item.name}"…`, exclude });
  });

  register("nimbus.quickAsk", async () => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined) {
      void deps.window.showErrorMessage("Nimbus: open a file first.");
      return;
    }
    // A whitespace-only selection is treated as no selection → whole-file context.
    const selectionText = editor.selection.isEmpty ? "" : editor.document.getText(editor.selection);
    const hasSelection = selectionText.trim().length > 0;
    const rawContext = hasSelection ? selectionText : editor.document.getText();
    const scope = hasSelection ? "selected code" : "active file";
    const { code, truncated } = clampContext(rawContext, QUICK_ASK_MAX_CONTEXT_CHARS);
    const client = nimbus();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
      return;
    }
    const presets = resolvePresets(settings.quickAskPresets());
    const items: QuickAskPick[] = [
      ...presets.map(
        (preset): QuickAskPick => ({
          label: preset.label,
          ...(preset.description !== undefined ? { detail: preset.description } : {}),
          preset,
        }),
      ),
      { label: "Custom question…" },
    ];
    const pick = await deps.window.showQuickPick(items, {
      placeHolder: `Pick a quick-ask action for the ${scope}`,
      matchOnDetail: true,
    });
    if (pick === undefined) return;
    const question = await deps.window.showInputBox({
      prompt: `Ask a question about the ${scope}`,
      placeHolder: "e.g. What does this do? How can I simplify it?",
      value: pick.preset?.prompt ?? "",
      validateInput: validateQuestion,
    });
    if (question === undefined || validateQuestion(question) !== undefined) return;
    if (truncated) {
      void deps.window.showWarningMessage(
        `Nimbus: context truncated to ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`,
      );
    }
    const prompt = buildQuickAskPrompt({
      question,
      code,
      filePath: redactPath(editor.document.fileName),
      languageId: editor.document.languageId,
      truncated,
    });
    const agent = settings.askAgent();
    const options: { stream: boolean; agent?: string } = { stream: false };
    if (agent.length > 0) options.agent = agent;
    try {
      const result = await deps.window.withProgress(
        { location: PROGRESS_LOCATION_NOTIFICATION, title: "Nimbus: asking…" },
        () => client.agentInvoke(prompt, options),
      );
      const reply = extractReply(result);
      if (reply === undefined) {
        void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
        return;
      }
      await openReadonlyJson("Nimbus reply.md", reply);
    } catch (e) {
      log.error(`nimbus.quickAsk failed: ${errMsg(e)}`);
      void deps.window.showErrorMessage(`Nimbus quick ask failed: ${errMsg(e)}`);
    }
  });

  register("nimbus.newConversation", async () => {
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    activeAgent = undefined;
    await ctl.newConversation();
    agentsView.refresh();
  });

  register("nimbus.openAgentChat", async (...args) => {
    // Primary-click command: args[0] is the Agent we put in the row's
    // command.arguments (see agentsToRows). Re-validate defensively via
    // parseAgents (single-element array), mirroring openIndexItem.
    const [agent] = parseAgents([args[0]]);
    if (agent === undefined) return;
    const ctl = ensureChatController();
    if (ctl === undefined) return;
    // Set the override only once we know a chat will actually start, so a
    // disconnected click can't silently pin activeAgent for the next chat.
    activeAgent = agent.id;
    // ensureChatController() creates+reveals the panel on first use; for an
    // already-open panel it returns early, so current()?.reveal() reveals it.
    await ctl.newConversation();
    chatPanelFactory.current()?.reveal();
    agentsView.refresh();
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

  register("nimbus.troubleshootConnection", async () => {
    const state = connection.current();
    let ping: PingOutcome | undefined;
    const pingClient = nimbus();
    if (state.kind === "connected" && pingClient !== undefined) {
      try {
        const p = await pingClient.gatewayPing();
        ping = { ok: true, version: p.version, uptime: p.uptime };
      } catch (e) {
        ping = { ok: false, error: errMsg(e) };
      }
    }
    const report = buildTroubleshooter(state, {
      autoStartGateway: settings.autoStartGateway(),
      platform: process.platform,
      ...(ping !== undefined ? { ping } : {}),
    });
    const labels = report.actions.map((a) => a.label);
    const opts = { modal: true };
    let choice: string | undefined;
    if (report.level === "error") {
      choice = await deps.window.showErrorMessage(report.message, opts, ...labels);
    } else if (report.level === "warn") {
      choice = await deps.window.showWarningMessage(report.message, opts, ...labels);
    } else {
      choice = await deps.window.showInformationMessage(report.message, opts, ...labels);
    }
    const action = report.actions.find((a) => a.label === choice);
    if (action === undefined) return;
    await deps.commands.executeCommand(action.command, ...(action.args ?? []));
  });

  register("nimbus.openLogs", () => {
    out.show(true);
  });

  register("nimbus.openWalkthrough", async () => {
    await deps.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "nimbus-agent.nimbus-vscode#nimbusGettingStarted",
    );
  });

  register("nimbus.quickActions", async () => {
    await quickActions.show();
  });

  register("nimbus.refreshAudit", () => {
    auditView.refresh();
  });

  register("nimbus.refreshEgress", () => {
    refreshEgress();
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
    if (item?.url === undefined) return;
    try {
      await openSource(item);
    } catch (e) {
      void deps.window.showWarningMessage(`Couldn't open ${item.name}: ${errMsg(e)}`);
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

  register("nimbus.openEgressEntry", async (...args) => {
    const detail = formatEgressDetail(args[0]);
    if (detail === undefined) return;
    await openReadonlyJson(detail.title, detail.content);
  });

  register("nimbus.verifyEgress", async () => {
    const client = nimbus();
    if (client === undefined) {
      void deps.window.showWarningMessage("Nimbus: not connected to the Gateway.");
      return;
    }
    try {
      const result = await client.egressVerify();
      if (result.ok) {
        void deps.window.showInformationMessage(
          `Egress ledger intact — ${result.verifiedRows} rows verified.`,
          {},
        );
      } else {
        const at = result.brokenAt ?? "?";
        const reason = result.reason !== undefined ? `: ${result.reason}` : "";
        void deps.window.showErrorMessage(`Egress chain broke at row ${at}${reason}.`);
      }
    } catch (e) {
      const msg = errMsg(e);
      log.warn(`egress verify failed: ${msg}`);
      void deps.window.showErrorMessage(`Nimbus: egress verify failed: ${msg}`);
    }
  });

  register("nimbus.proveEgressWindow", async () => {
    const client = nimbus();
    if (client === undefined) {
      void deps.window.showWarningMessage("Nimbus: not connected to the Gateway.");
      return;
    }
    const presets = egressWindowPresets(Date.now());
    const pick = await deps.window.showQuickPick(
      presets.map((p) => ({ label: p.label })),
      { placeHolder: "Prove egress for which window?" },
    );
    if (pick === undefined) return;
    const preset = presets.find((p) => p.label === pick.label);
    if (preset === undefined) return;
    try {
      const params: { since?: number; until?: number; sign: boolean } = { sign: true };
      if (preset.since !== undefined) params.since = preset.since;
      if (preset.until !== undefined) params.until = preset.until;
      const result = await client.egressProveWindow(params);
      const doc = buildProofDocument(result, Date.now());
      const saved = await saveJson(doc.filename, doc.content);
      if (saved === undefined) return;
      const action = await deps.window.showInformationMessage(
        "Egress proof saved.",
        {},
        "Open File",
      );
      if (action === "Open File") {
        await deps.commands.executeCommand("vscode.open", vscode.Uri.file(saved.fsPath));
      }
    } catch (e) {
      const msg = errMsg(e);
      log.warn(`egress prove failed: ${msg}`);
      void deps.window.showErrorMessage(`Nimbus: egress prove failed: ${msg}`);
    }
  });

  const participantDeps: ParticipantDeps = {
    client: () => nimbus() as unknown as ParticipantClientLike | undefined,
    registerStreamWithHitl: (id) => registeredHitlStreams.add(id),
    unregisterStreamWithHitl: (id) => {
      registeredHitlStreams.delete(id);
    },
    agent: () => settings.askAgent(),
    citationLimit: 5,
    reconnectCommand: "nimbus.troubleshootConnection",
    log,
  };
  const registerParticipant = deps.registerChatParticipant ?? registerNimbusChatParticipant;
  ctx.subscriptions.push(registerParticipant({ deps: participantDeps, log }));

  const registerLm = deps.registerLmTools ?? registerNimbusLmTools;
  ctx.subscriptions.push(
    registerLm({
      deps: { client: () => nimbus(), askAgent: () => settings.askAgent(), log },
    }),
  );

  register("nimbus.showPendingHitl", () => {
    if (hitlRouter.snapshot().length === 0) return;
    chatPanelFactory.current()?.reveal();
  });

  register("nimbus.generateCommitMessage", () => scm.generateCommitMessage());
  register("nimbus.reviewChanges", () => scm.reviewChanges());
  register("nimbus.generateTests", () => scm.generateTests());
  register("nimbus.generateDocstrings", () => scm.generateDocstrings());

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

// Opens an untitled document with the given name, beside the active editor. The
// `untitled:` URI carries the file name (so the tab is named and syntax-
// highlighted); the buffer is unsaved, so nothing touches disk until the user
// saves and picks a location. Injectable as deps.openUntitled for tests.
//
// `deriveTestFileName` is deterministic, so running this command twice on the
// same source file would otherwise reuse the exact same `untitled:` URI — VS
// Code identifies untitled documents by URI, so the second call would resolve
// to the SAME document and prepend onto whatever is already there (the first
// output, or the user's own edits) instead of opening a fresh tab. A per-
// invocation counter (mirroring createReadonlyJsonOpener/createDiffOpener
// below) keeps every call's URI unique; the trailing basename is still exactly
// `fileName`, so the tab's displayed name and syntax highlighting are unaffected.
function createUntitledOpener(): (opts: { fileName: string; content: string }) => Promise<void> {
  let seq = 0;
  return async ({ fileName, content }) => {
    seq += 1;
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(`untitled:${seq}/${fileName}`),
    );
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    await editor.edit((edit) => {
      edit.insert(new vscode.Position(0, 0), content);
    });
  };
}

// Opens a side-by-side diff between two in-memory texts via a virtual
// read-only scheme, so the extension never applies an edit itself — any merge
// is the user's own action in the diff editor. Injectable as deps.openDiff.
//
// Both virtual URIs end in the source's basename, so VS Code infers the
// language from the extension natively — no setTextDocumentLanguage call, and
// no language-change events fired at other extensions.
function createDiffOpener(
  ctx: ExtensionContextLike,
): (opts: { title: string; left: string; right: string; fileName: string }) => Promise<void> {
  const scheme = "nimbus-diff";
  const MAX_DOCS = 20;
  const docs = new Map<string, string>();
  let seq = 0;
  let registered = false;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => docs.get(uri.path) ?? "",
  };
  return async ({ title, left, right, fileName }) => {
    if (!registered) {
      ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(scheme, provider),
      );
      registered = true;
    }
    seq += 1;
    // The trailing basename is what drives syntax highlighting.
    const leftPath = `/${seq}/original/${fileName}`;
    const rightPath = `/${seq}/nimbus/${fileName}`;
    docs.set(leftPath, left);
    docs.set(rightPath, right);
    while (docs.size > MAX_DOCS) {
      const oldest = docs.keys().next().value;
      if (oldest === undefined) break;
      docs.delete(oldest);
    }
    const leftUri = vscode.Uri.parse(`${scheme}:${leftPath}`);
    const rightUri = vscode.Uri.parse(`${scheme}:${rightPath}`);
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
  };
}

export function createSourceOpener(): (item: { url?: string }) => Promise<void> {
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

// Save a JSON document to disk via a native Save dialog; returns the chosen Uri
// (with fsPath) or undefined when cancelled. Injectable as deps.saveJson so
// tests don't touch vscode.
function createProofSaver(): (
  defaultName: string,
  content: string,
) => Promise<{ fsPath: string } | undefined> {
  return async (defaultName, content) => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    // showSaveDialog wants an absolute defaultUri; with no workspace folder we
    // have no absolute base, so omit it and let the dialog pick its own default
    // rather than passing a relative path.
    const options: { filters: Record<string, string[]>; defaultUri?: vscode.Uri } = {
      filters: { JSON: ["json"] },
    };
    if (folder !== undefined) options.defaultUri = vscode.Uri.joinPath(folder, defaultName);
    const target = await vscode.window.showSaveDialog(options);
    if (target === undefined) return undefined;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    return target;
  };
}
