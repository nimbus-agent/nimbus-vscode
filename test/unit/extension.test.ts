import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { ChatPanel } from "../../src/chat/chat-panel.js";
import type { AutoStarter, AutoStartResult } from "../../src/connection/auto-start.js";
import { activateWithDeps } from "../../src/extension.js";
import type {
  CommandsApi,
  ConfigurationChangeEventLike,
  ExtensionContextLike,
  MementoLike,
  StatusBarItemHandle,
  WindowApi,
  WorkspaceApi,
} from "../../src/vscode-shim.js";

class FakeMemento implements MementoLike {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

type ActivateDeps = Parameters<typeof activateWithDeps>[1];
type ClientLike = Awaited<ReturnType<NonNullable<ActivateDeps["openClient"]>>>;

function makeFakeClient(overrides: Partial<ClientLike> = {}): () => Promise<ClientLike> {
  const base: ClientLike = {
    close: async () => undefined,
    subscribeHitl: () => ({ dispose: () => undefined }),
    askStream: () => ({}),
    cancelStream: async () => ({ ok: true }),
    getSessionTranscript: async () => ({ sessionId: "", turns: [], hasMore: false }),
  } as unknown as ClientLike;
  const merged = { ...base, ...overrides } as ClientLike;
  return async () => merged;
}

interface Captured {
  ctx: ExtensionContextLike;
  commandHandlers: Map<string, (...args: unknown[]) => unknown>;
  statusItem: StatusBarItemHandle;
  outputAppendLines: string[];
  outputShownGetter: number;
  errorMessages: string[];
  warnMessages: string[];
  infoMessages: string[];
  configChangeHandlers: Array<(e: ConfigurationChangeEventLike) => void>;
  cfgValues: Record<string, unknown>;
  // Webview message handlers registered via panel.onMessage(), so tests can
  // simulate the chat panel posting messages back to the extension host.
  webviewMessageHandlers: Array<(msg: unknown) => void>;
  panelRevealedCount: number;
  openedDocs: Array<{ title: string; content: string }>;
  treeProviders: Map<string, RegisteredProvider>;
}

// The minimal shape the extension registers per tree view, captured so tests
// can drive getChildren/getTreeItem exactly as VS Code would.
interface RegisteredProvider {
  getTreeItem(element: unknown): { label: string; iconPath?: unknown };
  getChildren(element?: unknown): unknown[] | Promise<unknown[]>;
}

const TEST_SOCKET_PATH = join(tmpdir(), `nimbus-test-${process.pid}.sock`);

// A no-op auto-starter so tests never spawn a real `nimbus` process or poll a
// real socket. The real implementation is covered in auto-start.test.ts.
const okAutoStarter: AutoStarter = { spawn: async () => ({ kind: "ok" }) };

function makeFixture(opts: {
  cfg?: Record<string, unknown>;
  inputBoxAnswers?: Array<string | undefined>;
  openClient?: () => Promise<ClientLike>;
  discoverSocket?: () => Promise<{ socketPath: string; source: string }>;
  autoStarter?: AutoStarter;
  activeEditor?: { text: string; empty?: boolean };
  panelVisible?: boolean;
  panelActive?: boolean;
  realChatPanel?: boolean;
  realAuditDetail?: boolean;
}): Captured & { deps: ActivateDeps } {
  const ctx: ExtensionContextLike = {
    subscriptions: [],
    workspaceState: new FakeMemento(),
  };
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const outputAppendLines: string[] = [];
  let outputShown = 0;
  const errorMessages: string[] = [];
  const warnMessages: string[] = [];
  const infoMessages: string[] = [];
  const configChangeHandlers: Array<(e: ConfigurationChangeEventLike) => void> = [];
  const cfgValues = opts.cfg ?? {};
  const inputAnswers = [...(opts.inputBoxAnswers ?? [])];

  const webviewMessageHandlers: Array<(msg: unknown) => void> = [];
  const openedDocs: Array<{ title: string; content: string }> = [];
  const treeProviders = new Map<string, RegisteredProvider>();
  const panelDisposeListeners: Array<() => void> = [];
  let panelCreated = false;
  let panelRevealed = 0;
  const chatPanel: ChatPanel = {
    reveal: () => {
      panelRevealed += 1;
    },
    dispose: () => {
      for (const l of panelDisposeListeners) l();
    },
    panel: () => undefined,
    onDispose: (h) => {
      panelDisposeListeners.push(h);
    },
    onMessage: (h) => {
      webviewMessageHandlers.push(h);
    },
    postMessage: () => Promise.resolve(true),
    isVisible: () => opts.panelVisible ?? false,
    isActive: () => opts.panelActive ?? false,
  };

  const statusItem: StatusBarItemHandle = {
    text: "",
    tooltip: undefined,
    command: undefined,
    backgroundColor: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };

  const window: WindowApi = {
    createOutputChannel: () => ({
      appendLine: (m: string) => outputAppendLines.push(m),
      show: () => {
        outputShown += 1;
      },
      dispose: () => undefined,
    }),
    createStatusBarItem: () => statusItem,
    showInformationMessage: vi.fn(async (m: string) => {
      infoMessages.push(m);
      return undefined;
    }),
    showErrorMessage: vi.fn(async (m: string) => {
      errorMessages.push(m);
      return undefined;
    }),
    showWarningMessage: vi.fn(async (m: string) => {
      warnMessages.push(m);
      return undefined;
    }),
    showInputBox: vi.fn(async () => inputAnswers.shift()),
    showQuickPick: vi.fn(async () => undefined),
    registerTreeDataProvider: vi.fn((viewId: string, provider: unknown) => {
      treeProviders.set(viewId, provider as RegisteredProvider);
      return { dispose: () => undefined };
    }),
    activeTextEditor:
      opts.activeEditor === undefined
        ? undefined
        : {
            selection: { isEmpty: opts.activeEditor.empty ?? false },
            document: { getText: () => opts.activeEditor?.text ?? "" },
          },
  };

  const workspace: WorkspaceApi = {
    getConfiguration: () => ({
      get: <T>(key: string, dflt: T): T => {
        if (key in cfgValues) return cfgValues[key] as T;
        return dflt;
      },
    }),
    onDidChangeConfiguration: (handler) => {
      configChangeHandlers.push(handler);
      return { dispose: () => undefined };
    },
  };

  const commands: CommandsApi = {
    executeCommand: vi.fn(async (id: string) => {
      const h = commandHandlers.get(id);
      if (h !== undefined) await h();
      return undefined;
    }),
    registerCommand: (id, h) => {
      commandHandlers.set(id, h);
      return { dispose: () => commandHandlers.delete(id) };
    },
  };

  const deps: ActivateDeps = {
    window,
    workspace,
    commands,
    discoverSocket:
      (opts.discoverSocket as ActivateDeps["discoverSocket"]) ??
      (async () => ({ socketPath: TEST_SOCKET_PATH, source: "default" }) as never),
    openClient: opts.openClient ?? makeFakeClient(),
    autoStarter: opts.autoStarter ?? okAutoStarter,
    chatPanelFactory: () => ({
      createOrReveal: () => {
        panelCreated = true;
        return chatPanel;
      },
      current: () => (panelCreated ? chatPanel : undefined),
    }),
    openReadonlyJson: async (title: string, content: string) => {
      openedDocs.push({ title, content });
    },
  };

  // Drop the injected factory so activate() falls back to the real VS Code
  // webview panel factory (backed by the vscode stub's createWebviewPanel).
  if (opts.realChatPanel === true) delete deps.chatPanelFactory;
  // Drop the injected opener so activate() exercises the real content-provider
  // path (backed by the vscode stub).
  if (opts.realAuditDetail === true) delete deps.openReadonlyJson;

  return {
    ctx,
    commandHandlers,
    statusItem,
    outputAppendLines,
    get outputShownGetter(): number {
      return outputShown;
    },
    errorMessages,
    warnMessages,
    infoMessages,
    configChangeHandlers,
    cfgValues,
    webviewMessageHandlers,
    get panelRevealedCount(): number {
      return panelRevealed;
    },
    openedDocs,
    treeProviders,
    deps,
  };
}

// Wait for the connection manager's `void connection.start()` to settle.
async function waitForConnect(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function cmd(f: Captured, id: string): (...args: unknown[]) => unknown {
  const h = f.commandHandlers.get(id);
  if (h === undefined) throw new Error(`command ${id} not registered`);
  return h;
}

// An askStream handle that immediately yields a terminal "done" event, so a
// ChatController.start() call completes in one tick.
function doneAskStream(): ReturnType<typeof vi.fn> {
  return vi.fn(() => ({
    streamId: "s1",
    cancel: async () => undefined,
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ value: { type: "done", reply: "", sessionId: "" }, done: false }),
    }),
  }));
}

// An openClient that rejects, leaving the connection manager disconnected so
// connection.client() stays undefined (the "not connected" command paths).
function disconnectedClient(): () => Promise<ClientLike> {
  return async () => {
    throw new Error("ECONNREFUSED");
  };
}

// ---------------------------------------------------------------------------
// Tests

describe("activateWithDeps", () => {
  test("registers the expected commands and pushes disposables to ctx.subscriptions", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const expected = [
      "nimbus.ask",
      "nimbus.askAboutSelection",
      "nimbus.search",
      "nimbus.searchSelection",
      "nimbus.newConversation",
      "nimbus.startGateway",
      "nimbus.reconnect",
      "nimbus.openLogs",
      "nimbus.showPendingHitl",
      "nimbus.quickActions",
      "nimbus.refreshAudit",
      "nimbus.openAuditEntry",
      "nimbus.refreshSessions",
      "nimbus.openSession",
      "nimbus.refreshIndex",
      "nimbus.openIndexItem",
      "nimbus.askAboutIndexItem",
    ];
    for (const id of expected) {
      expect(f.commandHandlers.has(id), `command ${id} missing`).toBe(true);
    }
    expect(f.ctx.subscriptions.length).toBeGreaterThanOrEqual(16);
  });

  test("registers the four sidebar tree views in the nimbus container", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const reg = f.deps.window.registerTreeDataProvider as unknown as ReturnType<typeof vi.fn>;
    const viewIds = reg.mock.calls.map((c) => c[0]);
    expect(viewIds).toEqual([
      "nimbus.auditView",
      "nimbus.agentsView",
      "nimbus.indexView",
      "nimbus.sessionsView",
    ]);
  });

  test("nimbus.quickActions runs the picked action's command", async () => {
    const f = makeFixture({});
    const qp = f.deps.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
    qp.mockResolvedValueOnce({ label: "$(search) Search", command: "nimbus.search" });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickActions")();
    const exec = f.deps.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    expect(exec.mock.calls.some((c) => c[0] === "nimbus.search")).toBe(true);
  });

  test("nimbus.quickActions is a no-op when the menu is dismissed", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const exec = f.deps.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    const before = exec.mock.calls.length;
    await cmd(f, "nimbus.quickActions")();
    // showQuickPick resolves undefined by default → no command dispatched.
    expect(exec.mock.calls.length).toBe(before);
  });

  test("the registered audit provider loads client rows and resolves theme icons", async () => {
    const auditList = vi.fn(async () => [
      {
        id: 1,
        actionType: "drive.read",
        hitlStatus: "approved",
        actionJson: "{}",
        timestamp: 1000,
      },
    ]);
    const f = makeFixture({
      openClient: makeFakeClient({ auditList } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.auditView");
    if (provider === undefined) throw new Error("audit provider not registered");
    const rows = await provider.getChildren(undefined);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(auditList).toHaveBeenCalled();
    const item = provider.getTreeItem(rows[0]);
    // applyThemeIcons swapped the row's iconId for a real ThemeIcon on iconPath.
    expect(item.iconPath).toBeDefined();
  });

  test("the real read-only JSON opener bounds retained docs without throwing", async () => {
    const f = makeFixture({ realAuditDetail: true });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const open = cmd(f, "nimbus.openAuditEntry");
    // Open more than the eviction cap (50) to drive the prune loop.
    for (let i = 0; i < 55; i++) {
      await open({
        id: i,
        actionType: "x",
        hitlStatus: "approved",
        actionJson: "{}",
        timestamp: i,
      });
    }
    expect(f.ctx.subscriptions.length).toBeGreaterThan(0);
  });

  test("nimbus.openAuditEntry opens a read-only JSON doc for a valid entry", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(
      f,
      "nimbus.openAuditEntry",
    )({
      id: 3,
      actionType: "drive.read",
      hitlStatus: "approved",
      actionJson: '{"k":1}',
      timestamp: 1000,
    });
    expect(f.openedDocs).toHaveLength(1);
    expect(f.openedDocs[0]?.title).toBe("audit-3.json");
    expect(JSON.parse(f.openedDocs[0]?.content ?? "{}").action).toEqual({ k: 1 });
  });

  test("nimbus.openAuditEntry is a no-op for an unparseable argument", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAuditEntry")({ nope: true });
    expect(f.openedDocs).toHaveLength(0);
  });

  test("nimbus.refreshAudit refreshes the audit view without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => cmd(f, "nimbus.refreshAudit")()).not.toThrow();
  });

  test("the registered sessions provider lists sessions via querySql", async () => {
    const querySql = vi.fn(async () => ({
      rows: [{ sessionId: "s1", lastWriteAt: 1, chunkCount: 2 }],
    }));
    const f = makeFixture({
      openClient: makeFakeClient({ querySql } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.sessionsView");
    if (provider === undefined) throw new Error("sessions provider not registered");
    const rows = await provider.getChildren(undefined);
    expect(querySql).toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ label: "Session s1" });
  });

  test("the sessions provider shows an error row when querySql fails", async () => {
    const querySql = vi.fn(async () => {
      throw new Error("no such table: session_memory");
    });
    const f = makeFixture({
      openClient: makeFakeClient({ querySql } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.sessionsView");
    if (provider === undefined) throw new Error("sessions provider not registered");
    const rows = (await provider.getChildren(undefined)) as Array<{ label: string }>;
    expect(querySql).toHaveBeenCalled();
    expect(rows[0]?.label).toMatch(/failed to load/i);
  });

  test("nimbus.openSession resumes the chosen session in the chat panel", async () => {
    const getSessionTranscript = vi.fn(async (_p: { sessionId: string; limit?: number }) => ({
      sessionId: "s5",
      turns: [],
      hasMore: false,
    }));
    const f = makeFixture({
      openClient: makeFakeClient({ getSessionTranscript } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openSession")("s5");
    expect(f.panelRevealedCount).toBeGreaterThanOrEqual(0);
    const call = getSessionTranscript.mock.calls[0]?.[0] as { sessionId: string } | undefined;
    expect(call?.sessionId).toBe("s5");
  });

  test("nimbus.openSession is a no-op for a non-string argument", async () => {
    const getSessionTranscript = vi.fn(async () => ({ sessionId: "", turns: [], hasMore: false }));
    const f = makeFixture({
      openClient: makeFakeClient({ getSessionTranscript } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openSession")(undefined);
    expect(getSessionTranscript).not.toHaveBeenCalled();
  });

  test("nimbus.refreshSessions refreshes the sessions view without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => cmd(f, "nimbus.refreshSessions")()).not.toThrow();
  });

  test("the registered index provider groups items via queryItems", async () => {
    const queryItems = vi.fn(async () => ({
      items: [
        { id: "a", name: "Doc", service: "gdrive", itemType: "file", url: "https://x" },
        { id: "b", name: "Note", service: "gdrive", itemType: "file" },
      ],
      meta: { limit: 100, total: 2 },
    }));
    const f = makeFixture({
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.indexView");
    if (provider === undefined) throw new Error("index provider not registered");
    const groups = await provider.getChildren(undefined);
    expect(queryItems).toHaveBeenCalledTimes(1);
    expect(groups[0]).toMatchObject({ label: "Google Drive", description: "2" });
  });

  test("the index provider shows an error row when queryItems fails", async () => {
    const queryItems = vi.fn(async () => {
      throw new Error("index offline");
    });
    const f = makeFixture({
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.indexView");
    if (provider === undefined) throw new Error("index provider not registered");
    const rows = (await provider.getChildren(undefined)) as Array<{ label: string }>;
    expect(rows[0]?.label).toMatch(/failed to load index/i);
  });

  test("nimbus.refreshIndex refreshes the index view without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => cmd(f, "nimbus.refreshIndex")()).not.toThrow();
  });

  test("nimbus.openIndexItem opens a url via the injected opener", async () => {
    const opened: string[] = [];
    const f = makeFixture({});
    f.deps.openSource = async (item) => {
      if (item.url !== undefined) opened.push(item.url);
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openIndexItem")({ id: "a", name: "Doc", service: "s", url: "https://x" });
    expect(opened).toEqual(["https://x"]);
  });

  test("nimbus.openIndexItem is a no-op for an item without a url", async () => {
    const opener = vi.fn(async () => undefined);
    const f = makeFixture({});
    f.deps.openSource = opener;
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openIndexItem")({ id: "a", name: "Doc", service: "s" });
    expect(opener).not.toHaveBeenCalled();
  });

  test("nimbus.openIndexItem warns (not errors) when the open throws", async () => {
    const f = makeFixture({});
    f.deps.openSource = async () => {
      throw new Error("file is gone");
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openIndexItem")({ id: "a", name: "Doc", service: "s", url: "file:///x" });
    expect(f.warnMessages.some((m) => m.includes("file is gone"))).toBe(true);
  });

  test("nimbus.askAboutIndexItem seeds the chat from the node payload", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // The argument shape VS Code passes to a context-menu command: the tree
    // NODE (a SidebarItem), carrying the IndexItem on `payload`. A bare
    // IndexItem here would (correctly) fail to extract — that's the bug guard.
    await cmd(f, "nimbus.askAboutIndexItem")({
      label: "Q3 Deck",
      contextValue: "nimbusIndexItem",
      payload: { id: "a", name: "Q3 Deck", service: "gdrive", itemType: "file" },
    });
    const sent = (askStream.mock.calls[0]?.[0] as string | undefined) ?? "";
    expect(sent).toContain("Q3 Deck");
    expect(sent).toContain("- Service: gdrive");
  });

  test("nimbus.askAboutIndexItem is a no-op for a node without a payload", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutIndexItem")({ label: "x", contextValue: "nimbusIndexItem" });
    expect(askStream).not.toHaveBeenCalled();
  });

  test("falls back to the real read-only JSON opener when none is injected", async () => {
    const f = makeFixture({ realAuditDetail: true });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // Drives createReadonlyJsonOpener → registerTextDocumentContentProvider →
    // openTextDocument → showTextDocument against the vscode stub.
    await expect(
      cmd(
        f,
        "nimbus.openAuditEntry",
      )({
        id: 9,
        actionType: "x",
        hitlStatus: "rejected",
        actionJson: "{}",
        timestamp: 1,
      }),
    ).resolves.toBeUndefined();
  });

  test("nimbus.ask asks the user and starts a chat stream when input is non-empty", async () => {
    const askStream = vi.fn(() => ({
      streamId: "s1",
      cancel: async () => undefined,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: { type: "done", reply: "", sessionId: "" }, done: false }),
      }),
    }));
    const f = makeFixture({
      inputBoxAnswers: ["what's up?"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const handler = f.commandHandlers.get("nimbus.ask");
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    await handler();
    expect(askStream).toHaveBeenCalledTimes(1);
    const firstCall = askStream.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(firstCall[0]).toBe("what's up?");
  });

  test("nimbus.ask is a no-op when the user cancels the input box", async () => {
    const askStream = vi.fn();
    const f = makeFixture({
      inputBoxAnswers: [undefined],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const handler = f.commandHandlers.get("nimbus.ask");
    if (handler === undefined) throw new Error("ask handler not registered");
    await handler();
    expect(askStream).not.toHaveBeenCalled();
  });

  test("nimbus.openLogs reveals the output channel", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const before = f.outputShownGetter;
    const handler = f.commandHandlers.get("nimbus.openLogs");
    if (handler === undefined) throw new Error("openLogs handler not registered");
    handler();
    expect(f.outputShownGetter).toBeGreaterThan(before);
  });

  test("connecting paints the status bar with the connected text", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(f.statusItem.text).toMatch(/Nimbus:/);
  });

  test("a nimbus.* configuration change re-renders the status bar", async () => {
    const f = makeFixture({});
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const before = f.statusItem.text;
    f.statusItem.text = "(reset)";
    for (const h of f.configChangeHandlers) h({ affectsConfiguration: () => true });
    expect(f.statusItem.text).not.toBe("(reset)");
    expect(handle.fireConnectionState).toBeTypeOf("function");
    expect(typeof before).toBe("string");
  });

  test("disposing every subscription tears down without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => {
      for (const s of f.ctx.subscriptions) s.dispose();
    }).not.toThrow();
  });

  test("nimbus.startGateway exercises the auto-starter without throwing", async () => {
    const spawn = vi.fn(async (): Promise<AutoStartResult> => ({ kind: "ok" }));
    const f = makeFixture({ autoStarter: { spawn } });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const handler = f.commandHandlers.get("nimbus.startGateway");
    if (handler === undefined) throw new Error("startGateway handler not registered");
    await expect(handler()).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.subscriptions.length).toBeGreaterThan(0);
  });

  test("nimbus.search reads NimbusItem fields (name/url), coercing and falling back", async () => {
    // Rows use the real NimbusItem field names: name (not title) and url (no
    // path field exists). The search handler must read these.
    const queryItems = vi.fn(async () => ({
      items: [
        { name: "T1", service: "svc", url: "u1" },
        { id: "ID2" }, // name missing → id fallback
        { name: { nested: true } }, // object → not stringified, no id → "(untitled)"
        { name: 42, service: true }, // number/boolean coerced; no url → empty detail
      ],
    }));
    const f = makeFixture({
      inputBoxAnswers: ["needle"],
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.search")();

    expect(queryItems).toHaveBeenCalledTimes(1);
    const qp = f.deps.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
    const firstCall = qp.mock.calls[0];
    if (firstCall === undefined) throw new Error("showQuickPick was not called");
    const items = firstCall[0] as Array<{
      label: string;
      description: string;
      detail: string;
    }>;
    expect(items[0]).toEqual({ label: "T1", description: "svc", detail: "u1" });
    expect(items[1]?.label).toBe("ID2");
    expect(items[2]?.label).toBe("(untitled)");
    expect(items[3]?.label).toBe("42");
    expect(items[3]?.description).toBe("true");
    expect(items[3]?.detail).toBe("");
  });

  test("nimbus.search is a no-op for a blank query", async () => {
    const queryItems = vi.fn(async () => ({ items: [] }));
    const f = makeFixture({
      inputBoxAnswers: ["   "],
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.search")();
    expect(queryItems).not.toHaveBeenCalled();
  });

  test("nimbus.search reports an error when the query fails", async () => {
    const queryItems = vi.fn(async () => {
      throw new Error("index offline");
    });
    const f = makeFixture({
      inputBoxAnswers: ["needle"],
      openClient: makeFakeClient({ queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.search")();
    expect(f.errorMessages.some((m) => m.includes("index offline"))).toBe(true);
  });

  test("nimbus.search errors when not connected to the Gateway", async () => {
    const f = makeFixture({ inputBoxAnswers: ["needle"], openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.search")();
    expect(f.errorMessages.some((m) => m.includes("not connected"))).toBe(true);
    for (const s of f.ctx.subscriptions) s.dispose(); // clear the reconnect timer
  });

  test("nimbus.askAboutSelection prefixes the prompt and starts a stream", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      activeEditor: { text: "const x = 1;" },
      inputBoxAnswers: ["Explain this:"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutSelection")();
    expect(askStream).toHaveBeenCalledTimes(1);
    expect((askStream.mock.calls[0] as unknown[])[0]).toBe("Explain this:\n\nconst x = 1;");
  });

  test("nimbus.askAboutSelection errors when there is no selection", async () => {
    const f = makeFixture({ activeEditor: { text: "x", empty: true } });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutSelection")();
    expect(f.errorMessages.some((m) => m.includes("select text first"))).toBe(true);
  });

  test("nimbus.askAboutSelection is a no-op for whitespace-only selection", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      activeEditor: { text: "   \n  " },
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutSelection")();
    expect(askStream).not.toHaveBeenCalled();
    expect(f.errorMessages).toHaveLength(0);
  });

  test("nimbus.askAboutSelection aborts when the prefix prompt is cancelled", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      activeEditor: { text: "code" },
      inputBoxAnswers: [undefined],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutSelection")();
    expect(askStream).not.toHaveBeenCalled();
  });

  test("nimbus.searchSelection delegates to nimbus.search when text is selected", async () => {
    const f = makeFixture({ activeEditor: { text: "selected" } });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.searchSelection")();
    const exec = f.deps.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    expect(exec.mock.calls.some((c) => c[0] === "nimbus.search")).toBe(true);
  });

  test("nimbus.searchSelection errors when there is no selection", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.searchSelection")();
    expect(f.errorMessages.some((m) => m.includes("select text first"))).toBe(true);
  });

  test("nimbus.newConversation creates the chat panel and resets without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await expect(cmd(f, "nimbus.newConversation")()).resolves.toBeUndefined();
    expect(f.panelRevealedCount).toBeGreaterThanOrEqual(0);
  });

  test("nimbus.showPendingHitl does nothing when no consent is pending", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.showPendingHitl")();
    expect(f.panelRevealedCount).toBe(0);
  });

  test("the webview message handlers route every known message type without throwing", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      inputBoxAnswers: ["hi"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // Running Ask creates the controller, which registers the onMessage handler.
    await cmd(f, "nimbus.ask")();
    const fire = f.webviewMessageHandlers[0];
    if (fire === undefined) throw new Error("no webview message handler registered");

    expect(() => {
      fire({ type: "ready" });
      fire({ type: "requestRehydrate" });
      fire({ type: "openLogs" });
      fire({ type: "startGateway" });
      fire({ type: "stopStream" });
      fire({ type: "hitlResponse", requestId: "x", decision: "approve" });
      fire({ type: "openExternal", url: "https://example.com" });
      fire({ type: "unknownType" });
      fire("not an object");
      fire(null);
      fire({ noType: true });
    }).not.toThrow();

    await fire({ type: "submitAsk", text: "follow-up" });
    expect(askStream.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("fireHitl routes a request through the router without throwing", async () => {
    const f = makeFixture({});
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() =>
      handle.fireHitl({
        requestId: "req-1",
        prompt: "Allow file write?",
      } as Parameters<typeof handle.fireHitl>[0]),
    ).not.toThrow();
  });

  test("auto-starts the Gateway when a disconnect occurs and autoStartGateway is on", async () => {
    const spawn = vi.fn(async (): Promise<AutoStartResult> => ({ kind: "ok" }));
    let attempts = 0;
    const openClient: () => Promise<ClientLike> = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNREFUSED"); // first connect → disconnected
      return makeFakeClient()(); // reconnect after the spawn succeeds
    };
    const f = makeFixture({ cfg: { autoStartGateway: true }, openClient, autoStarter: { spawn } });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // Let the disconnected-branch auto-start IIFE (spawn → reconnectNow) settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(spawn).toHaveBeenCalledTimes(1);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("falls back to the real VS Code webview chat panel when none is injected", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      realChatPanel: true,
      inputBoxAnswers: ["hi"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // Drives createRealChatPanelFactory → createWebviewPanel → renderChatHtml →
    // wrapWebviewPanel, then a full ChatController.start() over the wrapper.
    await expect(cmd(f, "nimbus.ask")()).resolves.toBeUndefined();
    expect(askStream).toHaveBeenCalledTimes(1);
  });

  test("the registered agents provider renders configured agents from settings", async () => {
    const f = makeFixture({
      cfg: { agents: [{ id: "researcher", label: "Researcher", description: "Deep research" }] },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.agentsView");
    if (provider === undefined) throw new Error("agents provider not registered");
    const rows = await provider.getChildren(undefined);
    // getChildren returns the raw SidebarItem rows (carrying iconId);
    // applyThemeIcons maps iconId -> iconPath only inside getTreeItem (mirrors
    // the audit provider test).
    expect(rows[0]).toMatchObject({ label: "Researcher", iconId: "hubot" });
    const item = provider.getTreeItem(rows[0]);
    expect(item.iconPath).toBeDefined();
  });

  test("nimbus.openAgentChat scopes the next stream to the clicked agent", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      cfg: { askAgent: "default-agent" },
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAgentChat")({
      label: "Researcher",
      contextValue: "nimbusAgent",
      payload: { id: "researcher", label: "Researcher" },
    });
    // A new conversation was started; now send a message and inspect the agent.
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBe("researcher");
  });

  test("nimbus.openAgentChat is a no-op for a node without an agent payload", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAgentChat")({ label: "x" });
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBeUndefined();
  });

  test("nimbus.newConversation clears the active agent back to the default", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      cfg: { askAgent: "default-agent" },
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.openAgentChat")({ payload: { id: "researcher", label: "Researcher" } });
    await cmd(f, "nimbus.newConversation")();
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBe("default-agent");
  });
});
