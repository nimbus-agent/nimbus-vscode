import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { commands, env } from "vscode";

import type { ChatPanel } from "../../src/chat/chat-panel.js";
import type { AutoStarter, AutoStartResult } from "../../src/connection/auto-start.js";
import { activateWithDeps, createSourceOpener } from "../../src/extension.js";
import type { IndexItem } from "../../src/sidebar/index.js";
import type {
  CommandsApi,
  ConfigurationChangeEventLike,
  ExtensionContextLike,
  MementoLike,
  QuickPickLike,
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
  saveJsonCalls: Array<{ defaultName: string; content: string }>;
  quickPicks: FakeQuickPick[];
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

interface FakeQuickPick {
  value: string;
  placeholder: string | undefined;
  items: readonly unknown[];
  busy: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  selectedItems: readonly unknown[];
  onDidChangeValue(cb: (v: string) => void): { dispose(): void };
  onDidAccept(cb: () => void): { dispose(): void };
  onDidHide(cb: () => void): { dispose(): void };
  show(): void;
  hide(): void;
  dispose(): void;
  shown: boolean;
  disposed: boolean;
  setValueAndFire(v: string): void;
  accept(sel: readonly unknown[]): void;
}

function makeFakeQuickPick(): FakeQuickPick {
  const changeCbs: Array<(v: string) => void> = [];
  const acceptCbs: Array<() => void> = [];
  const hideCbs: Array<() => void> = [];
  const qp: FakeQuickPick = {
    value: "",
    placeholder: undefined,
    items: [],
    busy: false,
    matchOnDescription: false,
    matchOnDetail: false,
    selectedItems: [],
    onDidChangeValue: (cb) => {
      changeCbs.push(cb);
      return { dispose: () => undefined };
    },
    onDidAccept: (cb) => {
      acceptCbs.push(cb);
      return { dispose: () => undefined };
    },
    onDidHide: (cb) => {
      hideCbs.push(cb);
      return { dispose: () => undefined };
    },
    show: () => {
      qp.shown = true;
    },
    hide: () => {
      for (const cb of hideCbs) cb();
    },
    dispose: () => {
      qp.disposed = true;
    },
    shown: false,
    disposed: false,
    setValueAndFire: (v) => {
      qp.value = v;
      for (const cb of changeCbs) cb(v);
    },
    accept: (sel) => {
      qp.selectedItems = sel;
      for (const cb of acceptCbs) cb();
    },
  };
  return qp;
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeFixture(opts: {
  cfg?: Record<string, unknown>;
  inputBoxAnswers?: Array<string | undefined>;
  openClient?: () => Promise<ClientLike>;
  discoverSocket?: () => Promise<{ socketPath: string; source: string }>;
  autoStarter?: AutoStarter;
  activeEditor?: { text: string; empty?: boolean; selectionText?: string; fileName?: string; languageId?: string };
  panelVisible?: boolean;
  panelActive?: boolean;
  realChatPanel?: boolean;
  realAuditDetail?: boolean;
  realProofSave?: boolean;
  quickPickAnswers?: Array<{ label: string; preset?: { label: string; prompt: string } } | undefined>;
  infoMessageClicks?: Array<string | undefined>;
  saveJsonResult?: { fsPath: string } | undefined;
  openSource?: (item: { url?: string }) => Promise<void>;
  searchDebounceMs?: number;
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
  const quickPickAnswers = [...(opts.quickPickAnswers ?? [])];
  const infoClicks = [...(opts.infoMessageClicks ?? [])];
  const saveJsonCalls: Array<{ defaultName: string; content: string }> = [];
  const quickPicks: FakeQuickPick[] = [];

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
      return infoClicks.shift();
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
    // vi.fn() collapses the generic <T> of showQuickPick, so cast to the exact
    // slot type; other tests recover the mock interface via their own casts.
    showQuickPick: vi.fn(async () =>
      quickPickAnswers.shift(),
    ) as unknown as WindowApi["showQuickPick"],
    createQuickPick: (<T>() => {
      const qp = makeFakeQuickPick();
      quickPicks.push(qp);
      return qp as unknown as QuickPickLike<T>;
    }) as WindowApi["createQuickPick"],
    registerTreeDataProvider: vi.fn((viewId: string, provider: unknown) => {
      treeProviders.set(viewId, provider as RegisteredProvider);
      return { dispose: () => undefined };
    }),
    activeTextEditor:
      opts.activeEditor === undefined
        ? undefined
        : {
            selection: { isEmpty: opts.activeEditor.empty ?? false },
            document: {
              getText: (range?: unknown) =>
                range === undefined
                  ? (opts.activeEditor?.text ?? "")
                  : (opts.activeEditor?.selectionText ?? opts.activeEditor?.text ?? ""),
              fileName: opts.activeEditor?.fileName ?? "untitled",
              languageId: opts.activeEditor?.languageId ?? "plaintext",
            },
          },
    withProgress: (async (_opts: unknown, task: () => Promise<unknown>) => task()) as WindowApi["withProgress"],
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
    saveJson: async (defaultName: string, content: string) => {
      saveJsonCalls.push({ defaultName, content });
      return opts.saveJsonResult;
    },
  };

  // Drop the injected factory so activate() falls back to the real VS Code
  // webview panel factory (backed by the vscode stub's createWebviewPanel).
  if (opts.realChatPanel === true) delete deps.chatPanelFactory;
  // Drop the injected opener so activate() exercises the real content-provider
  // path (backed by the vscode stub).
  if (opts.realAuditDetail === true) delete deps.openReadonlyJson;
  // Drop the injected saveJson so activate() falls back to createProofSaver(),
  // exercising the real vscode.window.showSaveDialog / workspace.fs path.
  if (opts.realProofSave === true) delete deps.saveJson;
  if (opts.openSource !== undefined) deps.openSource = opts.openSource;
  if (opts.searchDebounceMs !== undefined) deps.searchDebounceMs = opts.searchDebounceMs;

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
    saveJsonCalls,
    quickPicks,
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

  test("registers the five sidebar tree views in the nimbus container", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const reg = f.deps.window.registerTreeDataProvider as unknown as ReturnType<typeof vi.fn>;
    const viewIds = reg.mock.calls.map((c) => c[0]);
    expect(viewIds).toEqual([
      "nimbus.auditView",
      "nimbus.egressView",
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
    expect(exec.mock.calls).toHaveLength(before);
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

  test.each([
    ["nimbus.refreshAudit", "audit"],
    ["nimbus.refreshSessions", "sessions"],
    ["nimbus.refreshIndex", "index"],
  ])("%s refreshes the %s view without throwing", async (command) => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => cmd(f, command)()).not.toThrow();
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
    await cmd(
      f,
      "nimbus.askAboutIndexItem",
    )({
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

  test("typing runs a ranked search and lists results with alwaysShow", async () => {
    const calls: Array<{ name?: string; limit?: number }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async (p: { name?: string; limit?: number }) => {
          calls.push(p);
          return [
            {
              name: "Report.pdf",
              service: "gdrive",
              itemType: "file",
              score: 0.91,
              url: "https://x/r",
            },
          ];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("report");
    await flush();
    expect(calls).toEqual([{ name: "report", limit: 50 }]);
    expect(qp.items).toHaveLength(1);
    expect((qp.items[0] as { label: string; alwaysShow?: boolean }).label).toBe("Report.pdf");
    expect((qp.items[0] as { alwaysShow?: boolean }).alwaysShow).toBe(true);
    expect(qp.shown).toBe(true);
  });

  test("quick ask sends the selection and shows the reply", async () => {
    const calls: Array<{ input: string; options?: unknown }> = [];
    const f = makeFixture({
      activeEditor: { text: "whole", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["what is this?"],
      openClient: makeFakeClient({
        agentInvoke: async (input: string, options?: unknown) => {
          calls.push({ input, options });
          return { reply: "It declares x." };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toContain("what is this?");
    expect(calls[0]?.input).toContain("const x = 1");
    expect(f.openedDocs.at(-1)).toEqual({ title: "Nimbus reply.md", content: "It declares x." });
  });

  test("quick ask with no selection sends the whole file", async () => {
    const calls: Array<{ input: string }> = [];
    const f = makeFixture({
      activeEditor: { text: "line1\nline2", empty: true, fileName: "/p/b.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["summarize"],
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          calls.push({ input });
          return { reply: "ok" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(calls[0]?.input).toContain("line1\nline2");
  });

  test("quick ask falls back to the whole file when the selection is whitespace-only", async () => {
    const calls: Array<{ input: string }> = [];
    const f = makeFixture({
      // selection is non-empty (empty: false) but whitespace-only → fall back to whole file
      activeEditor: { text: "whole file body", selectionText: "   \n  ", fileName: "/p/e.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["explain"],
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          calls.push({ input });
          return { reply: "ok" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(calls[0]?.input).toContain("whole file body");
  });

  test("quick ask shows an error and opens no doc when disconnected", async () => {
    const f = makeFixture({
      activeEditor: { text: "x", fileName: "/p/c.ts", languageId: "typescript" },
      inputBoxAnswers: ["q"],
      openClient: disconnectedClient(),
    });
    activateWithDeps(f.ctx, f.deps);
    await flush();
    await cmd(f, "nimbus.quickAsk")();
    expect(f.errorMessages.some((m) => m.includes("not connected"))).toBe(true);
    expect(f.openedDocs).toHaveLength(0);
  });

  test("quick ask reports when the agent returns no reply", async () => {
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "x", fileName: "/p/d.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["q"],
      openClient: makeFakeClient({
        agentInvoke: async () => ({ reply: "   " }),
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(f.infoMessages.some((m) => m.includes("no reply"))).toBe(true);
    expect(f.openedDocs).toHaveLength(0);
  });

  test("quick ask forwards the configured agent in a stateless one-shot options object", async () => {
    const calls: Array<{ options?: unknown }> = [];
    const f = makeFixture({
      cfg: { askAgent: "myagent" },
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["q"],
      openClient: makeFakeClient({
        agentInvoke: async (_input: string, options?: unknown) => {
          calls.push({ options });
          return { reply: "ok" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(calls[0]?.options).toEqual({ stream: false, agent: "myagent" });
  });

  test("quick ask omits the agent when askAgent is unset and stays stateless", async () => {
    const calls: Array<{ options?: unknown }> = [];
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["q"],
      openClient: makeFakeClient({
        agentInvoke: async (_input: string, options?: unknown) => {
          calls.push({ options });
          return { reply: "ok" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(calls[0]?.options).toEqual({ stream: false });
  });

  test("quick ask surfaces an error and opens no doc when agentInvoke rejects", async () => {
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["q"],
      openClient: makeFakeClient({
        agentInvoke: async () => {
          throw new Error("boom");
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(f.errorMessages.some((m) => m.includes("quick ask failed"))).toBe(true);
    expect(f.openedDocs).toHaveLength(0);
  });

  test("quick ask seeds the input box with the chosen preset prompt", async () => {
    const inputs: string[] = [];
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [
        { label: "Explain", preset: { label: "Explain", prompt: "Explain what this code does, step by step." } },
      ],
      inputBoxAnswers: ["Explain what this code does, step by step."],
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          inputs.push(input);
          return { reply: "done" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    const inputBox = f.deps.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
    const opts = inputBox.mock.calls[0]?.[0] as { value?: string } | undefined;
    expect(opts?.value).toBe("Explain what this code does, step by step.");
    expect(inputs[0]).toContain("Explain what this code does, step by step.");
  });

  test("quick ask does nothing when the picker is cancelled", async () => {
    const inputs: string[] = [];
    const f = makeFixture({
      activeEditor: { text: "x", selectionText: "const x = 1", fileName: "/p/a.ts", languageId: "typescript" },
      quickPickAnswers: [undefined],
      inputBoxAnswers: ["should not be used"],
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          inputs.push(input);
          return { reply: "x" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(inputs).toHaveLength(0);
    expect(f.openedDocs).toHaveLength(0);
    const inputBox = f.deps.window.showInputBox as unknown as ReturnType<typeof vi.fn>;
    expect(inputBox).not.toHaveBeenCalled();
  });

  test("quick ask errors when there is no active editor", async () => {
    let invoked = 0;
    const f = makeFixture({
      inputBoxAnswers: ["q"],
      openClient: makeFakeClient({
        agentInvoke: async () => {
          invoked += 1;
          return { reply: "ok" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(f.errorMessages.some((m) => m.includes("open a file first"))).toBe(true);
    expect(invoked).toBe(0);
    expect(f.openedDocs).toHaveLength(0);
  });

  test("uses the configured search.limit setting", async () => {
    const calls: Array<{ name?: string; limit?: number }> = [];
    const f = makeFixture({
      cfg: { "search.limit": 200 },
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async (p: { name?: string; limit?: number }) => {
          calls.push(p);
          return [];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("report");
    await flush();
    expect(calls).toEqual([{ name: "report", limit: 200 }]);
  });

  test("clamps a malformed search.limit back to the default", async () => {
    const calls: Array<{ limit?: number }> = [];
    const f = makeFixture({
      cfg: { "search.limit": "lots" },
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async (p: { limit?: number }) => {
          calls.push(p);
          return [];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("report");
    await flush();
    expect(calls[0]?.limit).toBe(50);
  });

  test("an empty value never calls the Gateway", async () => {
    let searchCalls = 0;
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => {
          searchCalls += 1;
          return [];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    (f.quickPicks[0] as FakeQuickPick).setValueAndFire("   ");
    await flush();
    expect(searchCalls).toBe(0);
  });

  test("a slow earlier query does not overwrite a newer one (latest wins)", async () => {
    const d1 = deferred<unknown[]>();
    const d2 = deferred<unknown[]>();
    const queue = [d1, d2];
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => (queue.shift() as { promise: Promise<unknown[]> }).promise,
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("a");
    await flush();
    qp.setValueAndFire("ab");
    await flush();
    d2.resolve([{ name: "New", service: "s", score: 1, url: "u2" }]);
    await flush();
    d1.resolve([{ name: "Old", service: "s", score: 1, url: "u1" }]);
    await flush();
    expect((qp.items as Array<{ label: string }>).map((i) => i.label)).toEqual(["New"]);
  });

  test("zero results shows a non-selectable status row", async () => {
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("zzz");
    await flush();
    expect(qp.items).toHaveLength(1);
    expect((qp.items[0] as { isStatus?: boolean }).isStatus).toBe(true);
    qp.accept([qp.items[0]]);
    expect(f.infoMessages.some((m) => /No source to open/.test(m))).toBe(false);
  });

  test("accepting an openable result opens it via openSource", async () => {
    const opened: Array<{ url?: string }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      openSource: async (item) => {
        opened.push(item);
      },
      openClient: makeFakeClient({
        searchRanked: async () => [{ name: "R", service: "s", score: 1, url: "https://x" }],
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("r");
    await flush();
    qp.accept([qp.items[0]]);
    expect(opened).toEqual([{ url: "https://x" }]);
    expect(qp.disposed).toBe(true);
  });

  test("accepting a result with no source shows an info toast, not openSource", async () => {
    const opened: Array<{ url?: string }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      openSource: async (item) => {
        opened.push(item);
      },
      openClient: makeFakeClient({
        searchRanked: async () => [{ name: "NoUrl", service: "s", score: 1 }],
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("n");
    await flush();
    qp.accept([qp.items[0]]);
    expect(opened).toHaveLength(0);
    expect(f.infoMessages.some((m) => /No source to open/.test(m))).toBe(true);
  });

  test("accepting an openable result whose openSource rejects shows a warning toast", async () => {
    const f = makeFixture({
      searchDebounceMs: 0,
      openSource: async () => {
        throw new Error("declined");
      },
      openClient: makeFakeClient({
        searchRanked: async () => [{ name: "R", service: "s", score: 1, url: "https://x" }],
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("r");
    await flush();
    qp.accept([qp.items[0]]);
    await flush();
    expect(f.warnMessages.some((m) => /Couldn't open/.test(m))).toBe(true);
  });

  test("Search Selection prefills the box with the normalized selection and searches", async () => {
    const calls: Array<{ name?: string }> = [];
    const f = makeFixture({
      searchDebounceMs: 0,
      activeEditor: { empty: false, text: "  multi\nline   selection  " },
      openClient: makeFakeClient({
        searchRanked: async (p: { name?: string }) => {
          calls.push(p);
          return [];
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.searchSelection")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    expect(qp.value).toBe("multi line selection");
    await flush();
    expect(calls[0]?.name).toBe("multi line selection");
  });

  test("results arriving after the pick is hidden do not mutate it", async () => {
    const d = deferred<unknown[]>();
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({ searchRanked: async () => d.promise } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("r");
    await flush(); // search in-flight
    qp.hide(); // onDidHide → disposed = true, dispose()
    expect(qp.disposed).toBe(true);
    d.resolve([{ name: "Late", service: "s", score: 1, url: "u" }]);
    await flush();
    expect(qp.items).toHaveLength(0); // guard blocked the post-dispose write
  });

  test("clearing the box to empty drops a still-in-flight query's stale result", async () => {
    const d = deferred<unknown[]>();
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({ searchRanked: async () => d.promise } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("abc"); // in-flight (mine = 1)
    await flush();
    qp.setValueAndFire(""); // empty branch — must bump seq so the stale result is dropped
    await flush();
    d.resolve([{ name: "Stale", service: "s", score: 1, url: "u" }]);
    await flush();
    expect(qp.items).toHaveLength(0);
  });

  test("search warns and opens no QuickPick when disconnected", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    expect(f.errorMessages.some((m) => /not connected/i.test(m))).toBe(true);
    expect(f.quickPicks).toHaveLength(0);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("a searchRanked rejection shows an error toast and clears busy", async () => {
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => {
          throw new Error("idx down");
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0] as FakeQuickPick;
    qp.setValueAndFire("x");
    await flush();
    expect(f.errorMessages.some((m) => /search failed: idx down/i.test(m))).toBe(true);
    expect(qp.busy).toBe(false);
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
    // Primary-click shape: VS Code passes command.arguments[0] = the bare Agent
    // object (not a SidebarItem wrapper). The handler must read args[0] directly.
    await cmd(f, "nimbus.openAgentChat")({ id: "researcher", label: "Researcher" });
    // A new conversation was started; now send a message and inspect the agent.
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBe("researcher");
  });

  test("nimbus.openAgentChat is a no-op for an arg without a usable agent id", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // No id field → parseAgents drops the entry → handler returns early.
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
    // Primary-click shape: bare Agent object.
    await cmd(f, "nimbus.openAgentChat")({ id: "researcher", label: "Researcher" });
    await cmd(f, "nimbus.newConversation")();
    for (const h of f.webviewMessageHandlers) h({ type: "submitAsk", text: "hi" });
    await waitForConnect();
    const opts = askStream.mock.calls[0]?.[1] as { agent?: string } | undefined;
    expect(opts?.agent).toBe("default-agent");
  });

  test("a chat command errors when the Gateway is not connected", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.newConversation")();
    expect(f.errorMessages.some((m) => m.includes("not connected to the Gateway"))).toBe(true);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("nimbus.reconnect is a no-op while already connected", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await expect(cmd(f, "nimbus.reconnect")()).resolves.toBeUndefined();
  });

  test("nimbus.startGateway surfaces a spawn error", async () => {
    const f = makeFixture({
      autoStarter: { spawn: async () => ({ kind: "spawn-error", message: "no nimbus binary" }) },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.startGateway")();
    expect(f.errorMessages.some((m) => m.includes("no nimbus binary"))).toBe(true);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("nimbus.startGateway surfaces a socket timeout", async () => {
    const f = makeFixture({
      autoStarter: { spawn: async () => ({ kind: "timeout", socketPath: "/tmp/nimbus.sock" }) },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.startGateway")();
    expect(f.errorMessages.some((m) => m.includes("Timed out"))).toBe(true);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("auto-start logs a spawn error on a disconnect", async () => {
    const f = makeFixture({
      cfg: { autoStartGateway: true },
      openClient: disconnectedClient(),
      autoStarter: { spawn: async () => ({ kind: "spawn-error", message: "boom" }) },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(f.outputAppendLines.some((l) => l.includes("Auto-start failed"))).toBe(true);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("auto-start warns on a socket timeout during a disconnect", async () => {
    const f = makeFixture({
      cfg: { autoStartGateway: true },
      openClient: disconnectedClient(),
      autoStarter: { spawn: async () => ({ kind: "timeout", socketPath: "/tmp/y.sock" }) },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(f.outputAppendLines.some((l) => l.includes("Auto-start timeout"))).toBe(true);
    for (const s of f.ctx.subscriptions) s.dispose();
  });

  test("the openExternal webview message logs a warning when the OS declines", async () => {
    const spy = vi.spyOn(env, "openExternal").mockRejectedValue(new Error("nope"));
    const f = makeFixture({
      inputBoxAnswers: ["hi"],
      openClient: makeFakeClient({ askStream: doneAskStream() } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.ask")(); // creates the controller → registers the webview handler
    const fire = f.webviewMessageHandlers[0];
    if (fire === undefined) throw new Error("no webview message handler registered");
    fire({ type: "openExternal", url: "https://example.com" });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.outputAppendLines.some((l) => l.includes("openExternal failed"))).toBe(true);
    spy.mockRestore();
  });

  test("verifyEgress reports an intact ledger", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({
        egressVerify: async () => ({ ok: true, verifiedRows: 12 }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.infoMessages.some((m) => /intact — 12 rows/.test(m))).toBe(true);
  });

  test("verifyEgress reports a broken chain with the row and reason", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({
        egressVerify: async () => ({ ok: false, verifiedRows: 3, brokenAt: 4, reason: "hash" }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.errorMessages.some((m) => /broke at row 4: hash/.test(m))).toBe(true);
  });

  test("verifyEgress warns when disconnected", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.warnMessages.some((m) => /not connected/i.test(m))).toBe(true);
  });

  test("verifyEgress surfaces an error toast when the RPC rejects", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({
        egressVerify: async () => {
          throw new Error("ipc down");
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.errorMessages.some((m) => /egress verify failed: ipc down/.test(m))).toBe(true);
  });

  test("proveEgressWindow surfaces an error toast when the RPC rejects", async () => {
    const f = makeFixture({
      quickPickAnswers: [{ label: "All time" }],
      openClient: makeFakeClient({
        egressProveWindow: async () => {
          throw new Error("prove boom");
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(f.errorMessages.some((m) => /egress prove failed: prove boom/.test(m))).toBe(true);
    expect(f.saveJsonCalls).toHaveLength(0);
  });

  test("proveEgressWindow saves a proof and offers to open it", async () => {
    const savedUri = { fsPath: "/tmp/egress-proof.json" };
    const f = makeFixture({
      quickPickAnswers: [{ label: "Last hour" }],
      infoMessageClicks: ["Open File"],
      saveJsonResult: savedUri,
      openClient: makeFakeClient({
        egressProveWindow: async (params: unknown) => ({ params, rows: [], verify: { ok: true } }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(f.saveJsonCalls).toHaveLength(1);
    expect(f.saveJsonCalls[0]?.defaultName).toMatch(/^egress-proof-\d+\.json$/);
    expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(true);
    const exec = f.deps.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    expect(exec).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ scheme: "file", fsPath: savedUri.fsPath }),
    );
  });

  test("proveEgressWindow does nothing when the window picker is cancelled", async () => {
    let proveCalls = 0;
    const f = makeFixture({
      quickPickAnswers: [undefined],
      openClient: makeFakeClient({
        egressProveWindow: async () => {
          proveCalls += 1;
          return { rows: [] };
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(proveCalls).toBe(0);
    expect(f.saveJsonCalls).toHaveLength(0);
  });

  test("proveEgressWindow is silent when the save dialog is cancelled", async () => {
    const f = makeFixture({
      quickPickAnswers: [{ label: "All time" }],
      saveJsonResult: undefined,
      openClient: makeFakeClient({
        egressProveWindow: async () => ({ rows: [] }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(f.saveJsonCalls).toHaveLength(1);
    expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(false);
    const exec = f.deps.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    expect(exec).not.toHaveBeenCalledWith("vscode.open", expect.anything());
  });

  test("openEgressEntry opens the row detail as read-only JSON", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await cmd(
      f,
      "nimbus.openEgressEntry",
    )({
      id: 9,
      timestamp: 0,
      destination: "gmail",
      method: "send",
      resultStatus: "authorized",
      hitlStatus: "approved",
    });
    expect(f.openedDocs.some((d) => d.title === "egress-9.json")).toBe(true);
  });

  test("the default proof saver writes through the save dialog", async () => {
    const f = makeFixture({
      realProofSave: true,
      quickPickAnswers: [{ label: "Last 7 days" }],
      infoMessageClicks: [undefined],
      openClient: makeFakeClient({
        egressProveWindow: async () => ({ rows: [], verify: { ok: true } }),
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    // The stub's showSaveDialog returns a fsPath, so a success toast is shown.
    expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(true);
  });
});

describe("createSourceOpener", () => {
  const item = (url: string): IndexItem => ({ name: "x", url }) as unknown as IndexItem;

  test("opens a bare file path through the vscode.open command", async () => {
    const exec = vi.spyOn(commands, "executeCommand").mockResolvedValue(undefined);
    await createSourceOpener()(item("/abs/notes.txt"));
    expect(exec).toHaveBeenCalledWith("vscode.open", expect.objectContaining({ scheme: "file" }));
    exec.mockRestore();
  });

  test("treats a Windows drive path as a file, not a URI scheme", async () => {
    const exec = vi.spyOn(commands, "executeCommand").mockResolvedValue(undefined);
    await createSourceOpener()(item("C:\\proj\\file.ts"));
    expect(exec).toHaveBeenCalledWith("vscode.open", expect.objectContaining({ scheme: "file" }));
    exec.mockRestore();
  });

  test("opens an https url externally", async () => {
    const openExternal = vi.spyOn(env, "openExternal").mockResolvedValue(true);
    await createSourceOpener()(item("https://example.com/issue/1"));
    expect(openExternal).toHaveBeenCalledWith(expect.objectContaining({ scheme: "https" }));
    openExternal.mockRestore();
  });

  test("throws when the OS declines to open an external url", async () => {
    const openExternal = vi.spyOn(env, "openExternal").mockResolvedValue(false);
    await expect(createSourceOpener()(item("mailto:a@b.com"))).rejects.toThrow(/declined/);
    openExternal.mockRestore();
  });

  test("is a no-op for an item with an empty url", async () => {
    const exec = vi.spyOn(commands, "executeCommand").mockResolvedValue(undefined);
    const openExternal = vi.spyOn(env, "openExternal").mockResolvedValue(true);
    await createSourceOpener()(item(""));
    expect(exec).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    exec.mockRestore();
    openExternal.mockRestore();
  });
});
