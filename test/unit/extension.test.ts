import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { commands, env, Uri, workspace as vscodeWorkspace } from "vscode";

import type { ChatPanel } from "../../src/chat/chat-panel.js";
import type { ParticipantDeps } from "../../src/chat-participant/participant-types.js";
import type { AutoStarter, AutoStartResult } from "../../src/connection/auto-start.js";
import {
  activateWithDeps,
  createDiffOpener,
  createReadonlyJsonOpener,
  createSourceOpener,
} from "../../src/extension.js";
import type { LmToolsDeps } from "../../src/lm-tools/lm-tools.js";
import type { IndexItem } from "../../src/sidebar/index.js";
import type {
  CancellationTokenLike,
  CommandsApi,
  ConfigurationChangeEventLike,
  ExtensionContextLike,
  MementoLike,
  ProgressLike,
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
    gatewayPing: async () => ({
      version: "0.0.0-test",
      uptime: 60_000,
      agentLimits: { maxAgentDepth: 1, maxToolCallsPerSession: 1 },
    }),
  } as unknown as ClientLike;
  const merged = { ...base, ...overrides } as ClientLike;
  return async () => merged;
}

// Regression guard for the own-vs-prototype spread bug: the real NimbusClient
// is a CLASS, so every method (searchRanked, metricsDora, egressHead,
// getSessionTranscript, askStream, agents*, …) lives on its PROTOTYPE, not as
// an own enumerable property — only `ipc` is. `{ ...client }` copies own
// properties only, so it silently drops every method. `makeFakeClient` above
// builds a PLAIN OBJECT, whose methods ARE own properties, so it cannot
// reproduce that failure — every test using it passes whether or not a spread
// site actually forwards anything. This class reproduces the real shape so a
// wrapper that merely spreads (rather than naming and forwarding each member)
// fails loudly here.
class FakeClassClient {
  readonly calls: Record<string, unknown[]> = {};
  private record(name: string, args: unknown[]): void {
    this.calls[name] = args;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  subscribeHitl(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  connectorListStatus(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
  askStream(input: string, opts?: unknown): unknown {
    this.record("askStream", [input, opts]);
    return {
      streamId: "s1",
      cancel: async () => undefined,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: { type: "done", reply: "", sessionId: "" }, done: false }),
      }),
    };
  }
  cancelStream(streamId: string): Promise<{ ok: boolean }> {
    this.record("cancelStream", [streamId]);
    return Promise.resolve({ ok: true });
  }
  getSessionTranscript(
    params: { sessionId: string; limit?: number } = { sessionId: "" },
  ): Promise<{ sessionId: string; turns: never[]; hasMore: boolean }> {
    this.record("getSessionTranscript", [params]);
    return Promise.resolve({ sessionId: params.sessionId, turns: [], hasMore: false });
  }
  gatewayPing(): Promise<{
    version: string;
    uptime: number;
    agentLimits: { maxAgentDepth: number; maxToolCallsPerSession: number };
  }> {
    return Promise.resolve({
      version: "0.0.0-test",
      uptime: 1,
      agentLimits: { maxAgentDepth: 1, maxToolCallsPerSession: 1 },
    });
  }
  searchRanked(params?: unknown): Promise<unknown[]> {
    this.record("searchRanked", [params]);
    return Promise.resolve([{ name: "found.ts" }]);
  }
  metricsDora(params: unknown): Promise<unknown> {
    this.record("metricsDora", [params]);
    return Promise.resolve({ service: "checkout" });
  }
  egressHead(): Promise<{ head: string; count: number }> {
    return Promise.resolve({ head: "h", count: 3 });
  }
  agentsImpact(params: unknown): Promise<unknown> {
    this.record("agentsImpact", [params]);
    return Promise.resolve({ kind: "impact" });
  }
  agentsExpert(params: unknown): Promise<unknown> {
    this.record("agentsExpert", [params]);
    return Promise.resolve({ kind: "expert" });
  }
  agentsCatchup(params?: unknown): Promise<unknown> {
    this.record("agentsCatchup", [params]);
    return Promise.resolve({ kind: "catchup" });
  }
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
  // Lets a test invoke the chat panel's onDispose listeners directly (the same
  // way a real webview panel firing onDidDispose would), without exposing the
  // panel object itself.
  disposeChatPanel: () => void;
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
  activeEditor?: {
    text: string;
    empty?: boolean;
    selectionText?: string;
    fileName?: string;
    languageId?: string;
    /** Zero-based cursor line, as VS Code reports it. Defaults to 0. */
    line?: number;
    /** document.uri.scheme. Defaults to "file"; set to e.g. "untitled" or a
     *  virtual scheme to exercise the brief commands' real-file filter. */
    scheme?: string;
  };
  panelVisible?: boolean;
  panelActive?: boolean;
  realChatPanel?: boolean;
  realAuditDetail?: boolean;
  realProofSave?: boolean;
  quickPickAnswers?: Array<
    { label: string; preset?: { label: string; prompt: string } } | undefined
  >;
  infoMessageClicks?: Array<string | undefined>;
  warnMessageClicks?: Array<string | undefined>;
  saveJsonResult?: { fsPath: string } | undefined;
  openSource?: (item: { url?: string }) => Promise<void>;
  searchDebounceMs?: number;
  /** False simulates Restricted Mode, where no pre-flight skip is honoured. */
  isTrusted?: boolean;
  /**
   * Filled with every callback a cancellable withProgress body registers on the
   * cancellation token. A test fires them to stand in for the user clicking
   * Cancel on the progress notification — and their mere presence proves the
   * body was handed the token rather than the progress reporter.
   */
  cancelSubscribers?: Array<() => void>;
  workspaceFolders?: readonly { uri: { fsPath: string } }[];
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
  // Answers for the pre-flight gate's modal. Defaults to "Send" so tests about
  // Quick Ask / SCM behaviour are not all rewritten to click through a gate
  // they are not testing. Pass [undefined] to exercise a dismissal — see
  // "pre-flight gate blocks a send" below, which covers that path directly.
  const warnClicks = [...(opts.warnMessageClicks ?? [])];
  const nextWarnClick = (): string | undefined =>
    warnClicks.length > 0 ? warnClicks.shift() : "Send";
  const saveJsonCalls: Array<{ defaultName: string; content: string }> = [];
  const quickPicks: FakeQuickPick[] = [];
  const cancelSubscribers = opts.cancelSubscribers ?? [];

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
      return nextWarnClick();
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
            selection: {
              isEmpty: opts.activeEditor.empty ?? false,
              active: { line: opts.activeEditor.line ?? 0 },
            },
            document: {
              getText: (range?: unknown) =>
                range === undefined
                  ? (opts.activeEditor?.text ?? "")
                  : (opts.activeEditor?.selectionText ?? opts.activeEditor?.text ?? ""),
              fileName: opts.activeEditor?.fileName ?? "untitled",
              languageId: opts.activeEditor?.languageId ?? "plaintext",
              uri: { scheme: opts.activeEditor?.scheme ?? "file" },
            },
          },
    // Invoked exactly as real VS Code invokes it: `task(progress, token)`,
    // progress FIRST. The progress double deliberately has no
    // onCancellationRequested — so a call site that forwards the wrong argument
    // fails here rather than in a real window.
    withProgress: (async (
      _opts: unknown,
      task: (progress: ProgressLike, token: CancellationTokenLike) => Promise<unknown>,
    ) =>
      task(
        { report: () => undefined },
        {
          // Subscribers are captured, so a test can fire the token the way the
          // Cancel button on the notification does. Nothing fires by default.
          onCancellationRequested: (cb: () => void) => {
            cancelSubscribers.push(cb);
            return { dispose: () => undefined };
          },
        },
      )) as WindowApi["withProgress"],
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
    isTrusted: opts.isTrusted ?? true,
    workspaceFolders: opts.workspaceFolders,
    textDocuments: [],
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
    disposeChatPanel: () => chatPanel.dispose(),
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

// An askStream handle that never completes (its cancel() resolves the same
// gate its iterator awaits), so a test can observe a genuinely in-progress
// stream — e.g. to drive a second submitAsk into the "Stream in progress"
// rejection, or a stopStream whose cancel() rejects.
function neverEndingAskStream(opts: {
  streamId?: string;
  cancel?: () => Promise<void>;
}): ReturnType<typeof vi.fn> {
  const streamId = opts.streamId ?? "s1";
  return vi.fn(() => ({
    streamId,
    cancel: opts.cancel ?? (async () => undefined),
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<never>(() => undefined), // never resolves
    }),
  }));
}

// A fixture whose chat stream yields one "token" event (enough for the chat
// controller to register the stream for HITL) and then hangs forever — so a
// HITL request naming that streamId routes inline (chatPanelVisibleAndFocused
// + streamRegistered both true), and the request stays pending until the test
// resolves it (via a webview hitlResponse, or by disposing the panel).
function makeInlineHitlFixture(streamId = "s-inline"): {
  f: Captured & { deps: ActivateDeps };
  askStream: ReturnType<typeof vi.fn>;
} {
  let sentFirst = false;
  const askStream = vi.fn(() => ({
    streamId,
    cancel: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (!sentFirst) {
          sentFirst = true;
          return { value: { type: "token", text: "…" }, done: false };
        }
        return await new Promise<never>(() => undefined); // hang after the first event
      },
    }),
  }));
  const f = makeFixture({
    inputBoxAnswers: ["hi"],
    panelVisible: true,
    panelActive: true,
    openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
  });
  return { f, askStream };
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

  test("registers the four SCM commands", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    for (const id of [
      "nimbus.generateCommitMessage",
      "nimbus.reviewChanges",
      "nimbus.generateTests",
      "nimbus.generateDocstrings",
    ]) {
      expect(f.commandHandlers.has(id)).toBe(true);
    }
  });

  test("registers the six brief commands", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    for (const id of [
      "nimbus.brief.why",
      "nimbus.brief.ghost",
      "nimbus.brief.conflicts",
      "nimbus.brief.huddle",
      "nimbus.brief.janitor",
      "nimbus.brief.preflight",
    ]) {
      expect(f.commandHandlers.has(id), `command ${id} missing`).toBe(true);
    }
  });

  test("a non-file editor is not offered to the brief commands", async () => {
    // Same rule real-hover.ts already applies to the hover: an untitled
    // buffer has no path to blame, and a virtual document — our own
    // read-only brief tabs included — is not in any repo.
    const f = makeFixture({
      activeEditor: {
        text: "",
        fileName: "Nimbus — Why is this here?.md",
        languageId: "markdown",
        scheme: "nimbus-readonly",
      },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.brief.why")();
    expect(f.infoMessages).toContain('Nimbus: Open a file to run "Why is this here?".');
  });

  test("nimbus.generateTests opens a fresh untitled document on each invocation", async () => {
    // Regression guard: deriveTestFileName is deterministic, so running
    // Generate Tests twice on the same source used to reuse the exact same
    // `untitled:` URI — VS Code identifies untitled documents by URI, so the
    // second call resolved to the SAME document and editor.edit() prepended
    // onto whatever was already there. Exercises the REAL createUntitledOpener
    // (deps.openUntitled is left uninjected by makeFixture), spying on the
    // vscode stub's workspace.openTextDocument the same way other tests spy on
    // `commands`/`env` to observe real glue.
    const f = makeFixture({
      activeEditor: {
        text: "export const x = 1;",
        empty: true,
        fileName: "a.ts",
        languageId: "typescript",
      },
      openClient: makeFakeClient({
        agentInvoke: async () => ({ reply: "```ts\nexpect(1).toBe(1);\n```" }),
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const openTextDocument = vi.spyOn(vscodeWorkspace, "openTextDocument");
    await cmd(f, "nimbus.generateTests")();
    await cmd(f, "nimbus.generateTests")();
    const untitledUris = openTextDocument.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.startsWith("untitled:"));
    expect(untitledUris).toHaveLength(2);
    expect(untitledUris[0]).not.toBe(untitledUris[1]);
    // The tab's displayed name (and hence its syntax highlighting) still comes
    // from the derived test filename, unaffected by the per-call qualifier.
    for (const uri of untitledUris) expect(uri.endsWith("/a.test.ts")).toBe(true);
    openTextDocument.mockRestore();
  });

  test("registers the six sidebar tree views in the nimbus container", async () => {
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
      "nimbus.workflowsView",
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

  test("the registered sessions provider lists sessions via sessionList", async () => {
    const sessionList = vi.fn(async () => ({
      sessions: [{ sessionId: "s1", lastWriteAt: 1, chunkCount: 2 }],
    }));
    const f = makeFixture({
      openClient: makeFakeClient({ sessionList } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.sessionsView");
    if (provider === undefined) throw new Error("sessions provider not registered");
    const rows = await provider.getChildren(undefined);
    expect(sessionList).toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ label: "Session s1" });
  });

  test("the sessions provider shows an error row when sessionList fails", async () => {
    const sessionList = vi.fn(async () => {
      throw new Error("Method not found: session.list");
    });
    const f = makeFixture({
      openClient: makeFakeClient({ sessionList } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.sessionsView");
    if (provider === undefined) throw new Error("sessions provider not registered");
    const rows = (await provider.getChildren(undefined)) as Array<{ label: string }>;
    expect(sessionList).toHaveBeenCalled();
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
    expect((askStream.mock.calls[0] as unknown[])[0]).toBe(
      "Explain this:\n\nFile: untitled (plaintext)\n```plaintext\nconst x = 1;\n```",
    );
  });

  test("nimbus.askAboutSelection redacts the absolute file path", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      activeEditor: {
        text: "const x = 1",
        selectionText: "const x = 1",
        fileName: "C:\\Users\\alice\\proj\\src\\a.ts",
        languageId: "typescript",
      },
      inputBoxAnswers: ["Explain this:"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutSelection")();
    const prompt = (askStream.mock.calls[0] as unknown[])[0] as string;
    expect(prompt).toContain("File: a.ts (typescript)");
    expect(prompt).not.toContain("alice");
  });

  test("nimbus.askAboutSelection clamps an oversized selection and warns", async () => {
    const askStream = doneAskStream();
    const huge = "x".repeat(60_000); // exceeds QUICK_ASK_MAX_CONTEXT_CHARS (50_000)
    const f = makeFixture({
      activeEditor: {
        text: huge,
        selectionText: huge,
        fileName: "/p/big.ts",
        languageId: "typescript",
      },
      inputBoxAnswers: ["Explain this:"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.askAboutSelection")();
    const prompt = (askStream.mock.calls[0] as unknown[])[0] as string;
    expect(prompt).toContain("(truncated)");
    expect(prompt).not.toContain("x".repeat(50_001));
    expect(f.deps.window.showWarningMessage).toHaveBeenCalled();
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
      activeEditor: {
        text: "whole",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "line1\nline2",
        empty: true,
        fileName: "/p/b.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "whole file body",
        selectionText: "   \n  ",
        fileName: "/p/e.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "x",
        selectionText: "x",
        fileName: "/p/d.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "x",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "x",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "x",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
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
      activeEditor: {
        text: "x",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
      quickPickAnswers: [
        {
          label: "Explain",
          preset: { label: "Explain", prompt: "Explain what this code does, step by step." },
        },
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
      activeEditor: {
        text: "x",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
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

  test("quick ask builds picker items from configured presets plus the custom row", async () => {
    const configuredPreset = {
      label: "Explain",
      prompt: "Explain this.",
      description: "step-by-step",
    };
    const f = makeFixture({
      cfg: { "quickAsk.presets": [configuredPreset] },
      activeEditor: {
        text: "x",
        selectionText: "const x = 1",
        fileName: "/p/a.ts",
        languageId: "typescript",
      },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["q"],
      openClient: makeFakeClient({
        agentInvoke: async () => ({ reply: "ok" }),
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    const showQuickPick = f.deps.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
    const items = showQuickPick.mock.calls[0]?.[0] as Array<{
      label: string;
      detail?: string;
      preset?: unknown;
    }>;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      label: "Explain",
      detail: "step-by-step",
      preset: configuredPreset,
    });
    expect(items.at(-1)).toEqual({ label: "Custom question…" });
    expect(items.at(-1)?.preset).toBeUndefined();
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
    // The view is two groups now: built-in briefs first, configured agents
    // second. getChildren returns the raw SidebarItem rows (carrying iconId);
    // applyThemeIcons maps iconId -> iconPath only inside getTreeItem (mirrors
    // the audit provider test).
    const groups = (await provider.getChildren(undefined)) as Array<{ label: string }>;
    expect(groups.map((g) => g.label)).toEqual(["Built-in briefs", "Configured agents"]);
    const rows = await provider.getChildren(groups[1]);
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
    expect(f.saveJsonCalls[0]?.defaultName).toMatch(/^egress-proof-\d+\.html$/);
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

  test("nimbus.troubleshootConnection runs the chosen action's command", async () => {
    const f = makeFixture({ infoMessageClicks: ["Open Logs"] });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.troubleshootConnection")();
    expect(f.deps.commands.executeCommand).toHaveBeenCalledWith("nimbus.openLogs");
  });

  test("nimbus.troubleshootConnection shows an error modal when disconnected (autoStart off)", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.troubleshootConnection")();
    expect(f.deps.window.showErrorMessage).toHaveBeenCalled();
    expect(f.deps.window.showWarningMessage).not.toHaveBeenCalled();
    expect(f.deps.window.showInformationMessage).not.toHaveBeenCalled();
    expect(f.errorMessages.some((m) => m.includes("can't reach the Gateway"))).toBe(true);
  });

  test("nimbus.troubleshootConnection shows a warning modal when disconnected (autoStart on)", async () => {
    const f = makeFixture({ openClient: disconnectedClient(), cfg: { autoStartGateway: true } });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.troubleshootConnection")();
    expect(f.deps.window.showWarningMessage).toHaveBeenCalled();
    expect(f.deps.window.showErrorMessage).not.toHaveBeenCalled();
    expect(f.deps.window.showInformationMessage).not.toHaveBeenCalled();
    expect(f.warnMessages.some((m) => m.includes("Waiting for the Gateway to start"))).toBe(true);
  });

  test("nimbus.findRelated warns and shows no picker when there is no selection", async () => {
    const f = makeFixture({ activeEditor: { text: "", empty: true } });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.findRelated")();
    expect(f.errorMessages).toContain("Nimbus: select text to find related items.");
    expect(f.quickPicks).toHaveLength(0);
  });

  test("nimbus.findRelated runs a search seeded from the selection", async () => {
    const f = makeFixture({
      activeEditor: { text: "auth service", selectionText: "auth service", empty: false },
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.findRelated")();
    expect(f.quickPicks).toHaveLength(1);
    expect(f.quickPicks[0]?.placeholder).toBe("Related to selection…");
  });

  test("nimbus.findRelatedFromIndex runs a search seeded from the node payload", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(
      f,
      "nimbus.findRelatedFromIndex",
    )({
      payload: { id: "1", name: "billing", service: "gdrive" },
    });
    expect(f.quickPicks).toHaveLength(1);
    expect(f.quickPicks[0]?.placeholder).toBe('Related to "billing"…');
  });

  test("nimbus.refreshEgress re-polls the egress badge alongside the view refresh", async () => {
    const egressHead = vi.fn(async () => ({ head: "abc123def", count: 7 }));
    const f = makeFixture({ openClient: makeFakeClient({ egressHead } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    egressHead.mockClear();
    cmd(f, "nimbus.refreshEgress")();
    await flush();
    expect(egressHead).toHaveBeenCalled();
  });

  test("a superseded egress poll's late result does not clobber a newer poll's render", async () => {
    // First poll stays pending until we resolve it manually; the second poll
    // (triggered before the first settles) resolves immediately. If the race
    // guard were missing, the first poll's stale count would win because it
    // resolves chronologically last.
    const first = deferred<{ head: string; count: number }>();
    let call = 0;
    const egressHead = vi.fn(async () => {
      call += 1;
      if (call === 1) return first.promise;
      return { head: "freshhead00", count: 99 };
    });
    const f = makeFixture({ openClient: makeFakeClient({ egressHead } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    egressHead.mockClear();
    call = 0;

    cmd(f, "nimbus.refreshEgress")(); // poll #1: stays pending
    await Promise.resolve();
    cmd(f, "nimbus.refreshEgress")(); // poll #2: resolves immediately, supersedes #1
    await flush();

    first.resolve({ head: "stalehead00", count: 1 }); // #1's late result arrives last
    await flush();

    expect(egressHead).toHaveBeenCalledTimes(2);
    expect(f.statusItem.text).toContain("99");
    expect(f.statusItem.text).not.toContain("$(shield) 1 ");
  });

  test("the egress poll error path hides the badge without throwing", async () => {
    const egressHead = vi.fn(async () => {
      throw new Error("boom");
    });
    const f = makeFixture({ openClient: makeFakeClient({ egressHead } as never) });
    expect(() => activateWithDeps(f.ctx, f.deps)).not.toThrow();
    await waitForConnect();
    await flush();
    expect(egressHead).toHaveBeenCalled();
  });

  test("degraded connectors reach the status bar text", async () => {
    const connectorListStatus = vi.fn(async () => [
      {
        serviceId: "slack",
        status: "error" as const,
        lastSyncAt: null,
        nextSyncAt: null,
        intervalMs: 60000,
        itemCount: 0,
        lastError: "401",
        consecutiveFailures: 3,
        depth: "summary" as const,
        enabled: true,
      },
    ]);
    const f = makeFixture({
      openClient: makeFakeClient({ connectorListStatus } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    expect(connectorListStatus).toHaveBeenCalled();
    expect(f.statusItem.text).toContain("1 degraded");
    expect(f.statusItem.tooltip).toContain("slack");
  });

  test("a connector-health poll failure renders as zero degraded, not a crash", async () => {
    const connectorListStatus = vi.fn(async () => {
      throw new Error("boom");
    });
    const f = makeFixture({
      openClient: makeFakeClient({ connectorListStatus } as unknown as Partial<ClientLike>),
    });
    expect(() => activateWithDeps(f.ctx, f.deps)).not.toThrow();
    await waitForConnect();
    await flush();
    expect(connectorListStatus).toHaveBeenCalled();
    expect(f.statusItem.text).not.toContain("degraded");
  });

  test("nimbus.openWalkthrough opens the Get Started walkthrough", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await flush();
    await f.commandHandlers.get("nimbus.openWalkthrough")?.();
    expect(f.deps.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openWalkthrough",
      "nimbus-agent.nimbus-vscode#nimbusGettingStarted",
    );
  });

  test("sets nimbus.connected=true once the Gateway connects", async () => {
    const f = makeFixture({}); // default openClient resolves → connected
    activateWithDeps(f.ctx, f.deps);
    await flush();
    expect(f.deps.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "nimbus.connected",
      true,
    );
  });

  test("sets nimbus.connected=false when the Gateway is unreachable", async () => {
    const f = makeFixture({
      openClient: async () => {
        throw new Error("no gateway");
      },
    });
    activateWithDeps(f.ctx, f.deps);
    await flush();
    expect(f.deps.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "nimbus.connected",
      false,
    );
    expect(f.deps.commands.executeCommand).not.toHaveBeenCalledWith(
      "setContext",
      "nimbus.connected",
      true,
    );
  });

  test("fireConnectionState re-renders the status bar from an externally supplied state", async () => {
    const f = makeFixture({});
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    handle.fireConnectionState({
      kind: "disconnected",
      socketPath: "/tmp/x.sock",
      reason: "manual",
    });
    expect(f.statusItem.text).toMatch(/Gateway not running/);
  });

  test("the egress badge falls back to disconnected if the client drops while state stays connected", async () => {
    // connection.dispose() clears the client but does not itself transition
    // the manager's reported state away from "connected" — a real race if a
    // poll is in flight when the extension deactivates. Capture the command
    // handler before tearing down (disposing removes it from the registry),
    // then dispose everything and invoke the captured handler directly.
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const refreshEgress = cmd(f, "nimbus.refreshEgress");
    const hideSpy = vi.fn();
    f.statusItem.hide = hideSpy;
    for (const s of f.ctx.subscriptions) s.dispose();
    refreshEgress();
    await flush();
    expect(hideSpy).toHaveBeenCalled();
  });

  test("the registered egress provider lists ledger rows via egressList", async () => {
    const egressList = vi.fn(async () => ({
      rows: [
        {
          id: 1,
          timestamp: 0,
          destination: "gmail",
          method: "send",
          resultStatus: "authorized",
          hitlStatus: "approved",
        },
      ],
    }));
    const f = makeFixture({
      openClient: makeFakeClient({ egressList } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = f.treeProviders.get("nimbus.egressView");
    if (provider === undefined) throw new Error("egress provider not registered");
    const rows = await provider.getChildren(undefined);
    expect(egressList).toHaveBeenCalled();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("a second submitAsk while a stream is active logs the rejection instead of throwing", async () => {
    const askStream = neverEndingAskStream({});
    const f = makeFixture({
      inputBoxAnswers: ["first"],
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.ask")(); // starts the (never-completing) stream; don't await
    await flush();
    const fire = f.webviewMessageHandlers[0];
    if (fire === undefined) throw new Error("no webview message handler registered");
    fire({ type: "submitAsk", text: "second" });
    await flush();
    expect(
      f.outputAppendLines.some((l) => l.includes("submitAsk failed") && l.includes("in progress")),
    ).toBe(true);
    expect(askStream).toHaveBeenCalledTimes(1); // the second start() never called askStream
  });

  test("stopStream logs a warning (not a throw) when cancel() rejects", async () => {
    const askStream = neverEndingAskStream({
      cancel: async () => {
        throw new Error("cancel boom");
      },
    });
    const f = makeFixture({
      inputBoxAnswers: ["hi"],
      openClient: makeFakeClient({ askStream } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.ask")(); // never resolves; don't await
    await flush();
    const fire = f.webviewMessageHandlers[0];
    if (fire === undefined) throw new Error("no webview message handler registered");
    fire({ type: "stopStream" });
    await flush();
    expect(
      f.outputAppendLines.some((l) => l.includes("stopStream failed") && l.includes("cancel boom")),
    ).toBe(true);
  });

  test("a webview hitlResponse resolves the matching pending inline HITL prompt and sends the decision", async () => {
    const { f, askStream } = makeInlineHitlFixture();
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.ask")(); // starts+registers the stream for HITL; never resolves
    await flush();
    expect(askStream).toHaveBeenCalledTimes(1);

    handle.fireHitl({
      requestId: "req-x",
      prompt: "Allow?",
      streamId: "s-inline",
    } as Parameters<typeof handle.fireHitl>[0]);
    await flush();
    // Routed inline (the panel is visible+focused and the stream is
    // registered) rather than as a toast/modal.
    expect(f.deps.window.showInformationMessage).not.toHaveBeenCalled();

    const fire = f.webviewMessageHandlers.at(-1);
    if (fire === undefined) throw new Error("no webview message handler registered");
    fire({ type: "hitlResponse", requestId: "req-x", decision: "approve" });
    await flush();

    // Approving routes the decision to the Gateway; the fake client has no
    // `.ipc`, so sendConsentResponse throws and the failure is logged rather
    // than silently dropped — proving sendResponse actually ran.
    expect(f.outputAppendLines.some((l) => l.includes("HITL sendResponse failed"))).toBe(true);
  });

  test("an approved HITL request while disconnected is dropped with a warning, not sent", async () => {
    const f = makeFixture({ openClient: disconnectedClient(), infoMessageClicks: ["Approve"] });
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    handle.fireHitl({
      requestId: "req-disc",
      prompt: "Allow?",
    } as Parameters<typeof handle.fireHitl>[0]);
    await flush();
    expect(f.deps.window.showInformationMessage).toHaveBeenCalled(); // routed via toast
    expect(
      f.outputAppendLines.some((l) => l.includes("HITL response dropped: no Gateway connection")),
    ).toBe(true);
  });

  test("disposing the chat panel resolves a pending inline HITL prompt and drops the stale controller", async () => {
    const { f, askStream } = makeInlineHitlFixture();
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.ask")();
    await flush();

    handle.fireHitl({
      requestId: "req-y",
      prompt: "Allow?",
      streamId: "s-inline",
    } as Parameters<typeof handle.fireHitl>[0]);
    await flush();
    expect(f.deps.window.showInformationMessage).not.toHaveBeenCalled();

    f.disposeChatPanel();
    await flush();

    // The pending prompt resolved with "no decision" (dispose, not a user
    // choice), so nothing was ever sent to the Gateway.
    expect(f.outputAppendLines.some((l) => l.includes("HITL sendResponse failed"))).toBe(false);

    // The stale controller must have been dropped so the next Ask builds a
    // fresh one — proven by a second, distinct askStream call rather than an
    // immediate "Stream in progress" rejection from the old controller.
    (f.deps.window.showInputBox as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "second ask",
    );
    cmd(f, "nimbus.ask")();
    await flush();
    expect(askStream).toHaveBeenCalledTimes(2);
  });

  test("nimbus.showPendingHitl reveals the panel while a request is pending", async () => {
    const { f } = makeInlineHitlFixture();
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.ask")(); // creates+reveals the panel
    await flush();
    const revealedBefore = f.panelRevealedCount;

    // Fire, then check synchronously — handleOne's pending.set()/emitCount()
    // run before its first await, so the request is already "pending" here.
    handle.fireHitl({ requestId: "req-z", prompt: "Allow?" } as Parameters<
      typeof handle.fireHitl
    >[0]);
    cmd(f, "nimbus.showPendingHitl")();
    expect(f.panelRevealedCount).toBeGreaterThan(revealedBefore);
  });

  test("subscribeHitl's callback routes a pushed request through the HITL router", async () => {
    let hitlCallback: ((req: { requestId: string; prompt: string }) => void) | undefined;
    const f = makeFixture({
      openClient: makeFakeClient({
        subscribeHitl: (cb: (req: { requestId: string; prompt: string }) => void) => {
          hitlCallback = cb;
          return { dispose: () => undefined };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(hitlCallback).toBeDefined();
    hitlCallback?.({ requestId: "req-live", prompt: "Allow live push?" });
    await flush();
    expect(f.infoMessages.some((m) => m.includes("Allow live push?"))).toBe(true);
  });

  test("nimbus.findRelatedFromIndex excludes the source item (by url and by name) from ranked results", async () => {
    const f = makeFixture({
      searchDebounceMs: 0,
      openClient: makeFakeClient({
        searchRanked: async () => [
          { name: "billing", service: "gdrive", score: 1, url: "https://x/billing" }, // same url -> excluded
          { name: "Billing", service: "gdrive", score: 0.9 }, // same name, no url -> excluded
          { name: "invoices", service: "gdrive", score: 0.5, url: "https://x/invoices" }, // kept
        ],
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(
      f,
      "nimbus.findRelatedFromIndex",
    )({
      payload: { id: "1", name: "billing", service: "gdrive", url: "https://x/billing" },
    });
    await flush();
    const qp = f.quickPicks[0] as FakeQuickPick;
    const labels = (qp.items as Array<{ label: string }>).map((i) => i.label);
    expect(labels).toEqual(["invoices"]);
  });

  test("quick ask warns when the file content is truncated to the context cap", async () => {
    const bigText = "x".repeat(60_000); // exceeds QUICK_ASK_MAX_CONTEXT_CHARS (50_000)
    const calls: Array<{ input: string }> = [];
    const f = makeFixture({
      activeEditor: { text: bigText, empty: true, fileName: "/p/big.ts", languageId: "typescript" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["q"],
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
    expect(f.warnMessages.some((m) => m.includes("context truncated"))).toBe(true);
    expect(calls[0]?.input).toContain("(truncated)");
  });

  test("proveEgressWindow warns when disconnected", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.proveEgressWindow")();
    expect(f.warnMessages.some((m) => /not connected/i.test(m))).toBe(true);
  });

  test("participant deps proxy the Gateway client, HITL stream registry, and active agent", async () => {
    let captured: ParticipantDeps | undefined;
    const f = makeFixture({ cfg: { askAgent: "researcher" } });
    f.deps.registerChatParticipant = ({ deps }) => {
      captured = deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(captured).toBeDefined();
    expect(captured?.client()).toBeDefined();
    expect(() => captured?.registerStreamWithHitl("stream-x")).not.toThrow();
    expect(() => captured?.unregisterStreamWithHitl("stream-x")).not.toThrow();
    expect(captured?.agent()).toBe("researcher");
  });

  test("LM tools are registered once with a lazy client and the configured agent", async () => {
    let captured: LmToolsDeps | undefined;
    let registrations = 0;
    const f = makeFixture({ cfg: { askAgent: "ops" } });
    f.deps.registerLmTools = ({ deps }) => {
      registrations += 1;
      captured = deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(registrations).toBe(1);
    expect(captured?.client()).toBeDefined();
    expect(captured?.askAgent()).toBe("ops");
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

describe("createReadonlyJsonOpener", () => {
  test("evicts oldest documents beyond the requested bound", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
    // The egress preview passes a small bound: a full outbound prompt is among
    // the largest strings this extension builds, and the shared opener keeps 50.
    const open = createReadonlyJsonOpener(ctx, 2);
    await open("a.md", "AAA");
    await open("b.md", "BBB");
    await open("c.md", "CCC");
    const provider = spy.mock.calls[0]?.[1] as {
      provideTextDocumentContent(uri: { path: string }): string;
    };
    expect(provider.provideTextDocumentContent({ path: "/1/a.md" })).toBe("");
    expect(provider.provideTextDocumentContent({ path: "/2/b.md" })).toBe("BBB");
    expect(provider.provideTextDocumentContent({ path: "/3/c.md" })).toBe("CCC");
    spy.mockRestore();
  });

  // Found in a real Extension Development Host, not here: the brief titles end
  // in "?" ("Nimbus — Why is this here?.md"), and a real `vscode.Uri.parse`
  // treats everything from "?" onward as the QUERY — so the provider is handed
  // a truncated path, the lookup misses, and the tab opens silently EMPTY.
  // This stub's Uri.parse does not split the query, which is exactly why unit
  // tests could not catch it. So the assertion feeds the provider the truncated
  // path a real Uri would produce.
  test("a title containing '?' still resolves, though Uri.parse truncates the path", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
    const open = createReadonlyJsonOpener(ctx);
    await open("Nimbus — Why is this here?.md", "WHY BODY");
    const provider = spy.mock.calls[0]?.[1] as {
      provideTextDocumentContent(uri: { path: string }): string;
    };
    // What a real Uri.parse hands back: "?.md" became the query.
    expect(provider.provideTextDocumentContent({ path: "/1/Nimbus — Why is this here" })).toBe(
      "WHY BODY",
    );
    // "#" is the fragment delimiter and truncates the same way.
    await open("Nimbus — issue #42.md", "HASH BODY");
    expect(provider.provideTextDocumentContent({ path: "/2/Nimbus — issue " })).toBe("HASH BODY");
    spy.mockRestore();
  });

  // activate() builds TWO of these — the shared one (50) and the pre-flight
  // preview's own (5) — each with its own document map and its own sequence
  // counter. A scheme, though, resolves through ONE provider: register a second
  // for the same scheme and it shadows the first, so documents opened by the
  // other opener resolve to "" and the tab opens SILENTLY EMPTY.
  //
  // Found in a real window, behind the withProgress defect: once any "Show full
  // text" had registered the preview's opener, every later shared-opener tab —
  // the workflow run report among them — came up blank. Both maps also key on a
  // bare sequence number, so a collision could serve one surface's text under
  // another's tab: in an extension whose whole point is showing what leaves,
  // that is worse than blank.
  test("two openers get their own scheme, so neither shadows the other", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    const opened = vi.spyOn(vscodeWorkspace, "openTextDocument");
    const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
    const preview = createReadonlyJsonOpener(ctx, 5);
    const shared = createReadonlyJsonOpener(ctx);
    await preview("Nimbus outbound.md", "PREVIEW BODY");
    await shared("workflow-run-run-1.md", "REPORT BODY");

    const [previewScheme, previewProvider] = spy.mock.calls[0] as unknown as [
      string,
      { provideTextDocumentContent(uri: { path: string }): string },
    ];
    const [sharedScheme, sharedProvider] = spy.mock.calls[1] as unknown as [
      string,
      { provideTextDocumentContent(uri: { path: string }): string },
    ];
    expect(sharedScheme).not.toBe(previewScheme);
    // Each provider still serves its own document — the sequence numbers are
    // per-opener, so both documents are "/1/…" and only the scheme tells them
    // apart.
    expect(previewProvider.provideTextDocumentContent({ path: "/1/Nimbus outbound.md" })).toBe(
      "PREVIEW BODY",
    );
    expect(sharedProvider.provideTextDocumentContent({ path: "/1/workflow-run-run-1.md" })).toBe(
      "REPORT BODY",
    );
    // And the document each opener OPENS carries its own scheme: renaming the
    // registration alone would fix nothing.
    const uris = opened.mock.calls.map((c) => String(c[0]));
    expect(uris[0]?.startsWith(`${previewScheme}:`)).toBe(true);
    expect(uris[1]?.startsWith(`${sharedScheme}:`)).toBe(true);
    spy.mockRestore();
    opened.mockRestore();
  });
});

// Same defect class as the read-only opener above, fixed before it could bite:
// this one's path segment is a redacted basename, and "?" is illegal in a
// Windows filename, so it was latent rather than live. Issue #83.
describe("createDiffOpener", () => {
  test("resolves both sides even when the file name truncates the path", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
    const openDiff = createDiffOpener(ctx);
    await openDiff({ title: "T", left: "LEFT", right: "RIGHT", fileName: "we?ird.ts" });
    const provider = spy.mock.calls[0]?.[1] as {
      provideTextDocumentContent(uri: { path: string }): string;
    };
    // Derived through the stub's Uri.parse rather than hand-written, so this
    // asserts against the same truncation a real Uri performs.
    const left = Uri.parse("nimbus-diff:/1/original/we?ird.ts");
    const right = Uri.parse("nimbus-diff:/1/nimbus/we?ird.ts");
    expect(left.path).toBe("/1/original/we"); // proves the stub truncates
    expect(provider.provideTextDocumentContent(left)).toBe("LEFT");
    expect(provider.provideTextDocumentContent(right)).toBe("RIGHT");
    spy.mockRestore();
  });

  test("keeps the two sides distinct within one sequence", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
    const openDiff = createDiffOpener(ctx);
    await openDiff({ title: "T", left: "L1", right: "R1", fileName: "a.ts" });
    await openDiff({ title: "T", left: "L2", right: "R2", fileName: "a.ts" });
    const provider = spy.mock.calls[0]?.[1] as {
      provideTextDocumentContent(uri: { path: string }): string;
    };
    expect(provider.provideTextDocumentContent({ path: "/1/original/a.ts" })).toBe("L1");
    expect(provider.provideTextDocumentContent({ path: "/1/nimbus/a.ts" })).toBe("R1");
    expect(provider.provideTextDocumentContent({ path: "/2/original/a.ts" })).toBe("L2");
    expect(provider.provideTextDocumentContent({ path: "/2/nimbus/a.ts" })).toBe("R2");
    spy.mockRestore();
  });
});

describe("pre-flight commands", () => {
  test("registers both", () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    expect(f.commandHandlers.has("nimbus.showLastOutbound")).toBe(true);
    expect(f.commandHandlers.has("nimbus.resetPreflightPrompts")).toBe(true);
  });

  test("showLastOutbound says so plainly when nothing has been sent", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await cmd(f, "nimbus.showLastOutbound")();
    expect(f.infoMessages.join(" ")).toContain("nothing has been sent");
    expect(f.openedDocs).toEqual([]);
  });

  test("resetPreflightPrompts clears the skips and says so", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await cmd(f, "nimbus.resetPreflightPrompts")();
    expect(f.infoMessages.join(" ")).toContain("shown again");
  });
});

describe("pre-flight gate blocks a send", () => {
  const editor = {
    text: "const secret = 1;",
    empty: true,
    fileName: "/p/a.ts",
    languageId: "typescript",
  };

  test("quick ask sends nothing and reports no error when the modal is dismissed", async () => {
    let invoked = 0;
    const f = makeFixture({
      activeEditor: editor,
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["what is this?"],
      // Dismissed — the gate fails closed.
      warnMessageClicks: [undefined],
      openClient: makeFakeClient({
        agentInvoke: async () => {
          invoked += 1;
          return { reply: "should never be produced" };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(invoked).toBe(0);
    expect(f.openedDocs).toEqual([]);
    // Cancelling is a normal outcome, not a failure.
    expect(f.errorMessages).toEqual([]);
  });

  test("the modal names the file and its scope before anything leaves", async () => {
    const f = makeFixture({
      activeEditor: editor,
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["what is this?"],
      warnMessageClicks: [undefined],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    const detail = vi.mocked(f.deps.window.showWarningMessage).mock.calls.at(-1)?.[1] as
      | { detail?: string }
      | undefined;
    expect(detail?.detail).toContain("Quick Ask");
    // The path is redacted to a basename even in the local preview.
    expect(detail?.detail).toContain("a.ts — whole file");
    expect(detail?.detail).not.toContain("/p/a.ts");
  });

  test("showLastOutbound reveals what the last send actually carried", async () => {
    const f = makeFixture({
      activeEditor: editor,
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: ["what is this?"],
      openClient: makeFakeClient({
        agentInvoke: async () => ({ reply: "ok" }),
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    await cmd(f, "nimbus.showLastOutbound")();
    const doc = f.openedDocs.at(-1);
    expect(doc?.title).toBe("Nimbus outbound.md");
    expect(doc?.content).toContain("what is this?");
    expect(doc?.content).toContain("const secret = 1;");
  });
});

describe("pass-through surfaces route through the seam", () => {
  test("an Ask-panel send is recorded but never prompts", async () => {
    const f = makeFixture({
      inputBoxAnswers: ["why is p99 up?"],
      openClient: makeFakeClient({ askStream: doneAskStream() } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.ask")();
    // The user typed it, so nothing is asked — but it still routed through the
    // seam, which is what "no call site bypasses the gate" means.
    expect(f.warnMessages).toEqual([]);
    await cmd(f, "nimbus.showLastOutbound")();
    const doc = f.openedDocs.at(-1);
    expect(doc?.title).toBe("Nimbus outbound.md");
    expect(doc?.content).toContain("Ask panel");
    expect(doc?.content).toContain("why is p99 up?");
  });
});

describe("client wrappers forward to the real NimbusClient prototype (own-vs-prototype regression)", () => {
  test("the participant client wrapper forwards searchRanked/metricsDora/egressHead/briefs, not just askStream", async () => {
    const fake = new FakeClassClient();
    let captured: ParticipantDeps | undefined;
    const f = makeFixture({ openClient: async () => fake as unknown as ClientLike });
    f.deps.registerChatParticipant = (opts) => {
      captured = opts.deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const client = captured?.client();
    if (client === undefined) throw new Error("participant client did not connect");

    // Each of these would throw "... is not a function" under a bare
    // `{ ...client }` spread, because none of them are own properties of a
    // real NimbusClient instance.
    await expect(client.searchRanked({ name: "q" })).resolves.toEqual([{ name: "found.ts" }]);
    await expect(client.metricsDora({ service: "s", since: "7d" })).resolves.toEqual({
      service: "checkout",
    });
    await expect(client.egressHead()).resolves.toEqual({ head: "h", count: 3 });
    await expect(
      client.briefs.impact({ fileOrPrUrl: "a.ts" }, { action: "a", files: [], omissions: [] }),
    ).resolves.toEqual({ kind: "impact" });

    // And each call actually reached the real instance with its real params —
    // not a stand-in that merely resolved without throwing.
    expect(fake.calls["searchRanked"]?.[0]).toEqual({ name: "q" });
    expect(fake.calls["metricsDora"]?.[0]).toEqual({ service: "s", since: "7d" });
    expect(fake.calls["agentsImpact"]?.[0]).toEqual({ fileOrPrUrl: "a.ts" });
  });

  test("the Ask-panel client wrapper forwards askStream and getSessionTranscript to the real instance", async () => {
    const fake = new FakeClassClient();
    const f = makeFixture({
      inputBoxAnswers: ["hi there"],
      openClient: async () => fake as unknown as ClientLike,
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    // Creates the chat controller with the gated wrapper and drives askStream.
    await cmd(f, "nimbus.ask")();
    expect(fake.calls["askStream"]?.[0]).toBe("hi there");

    // Reuses the same controller/wrapper — proves getSessionTranscript, a
    // member the old spread silently dropped, is forwarded too.
    await cmd(f, "nimbus.openSession")("s9");
    const call = fake.calls["getSessionTranscript"]?.[0] as { sessionId: string } | undefined;
    expect(call?.sessionId).toBe("s9");
  });
});

describe("workflow run wiring", () => {
  const WF_ROW = {
    id: "wf-1",
    name: "nightly-sync",
    description: "Sync everything overnight",
    steps_json: JSON.stringify([{ label: "collect", run: "gather" }]),
    created_at: 1,
    updated_at: 2,
  };

  const RUN_RESULT = {
    runId: "run-1",
    status: "done",
    dryRun: false,
    stepResults: [{ label: "collect", status: "done", output: "ok" }],
  };

  // The fixture's showQuickPick returns a canned answer rather than echoing an
  // item, so the answer must carry the `row` the command reads back off it.
  function pickWorkflow(): Array<{ label: string }> {
    return [{ label: "nightly-sync", row: WF_ROW }] as unknown as Array<{ label: string }>;
  }

  function runHandle(): Record<string, unknown> {
    return {
      streamId: "sid-1",
      result: Promise.resolve(RUN_RESULT),
      cancel: async () => ({ cancelled: true }),
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: async () => {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: { type: "done", result: RUN_RESULT }, done: false };
          },
        };
      },
    };
  }

  test("nimbus.runWorkflow lists workflows and streams the chosen one", async () => {
    const workflowList = vi.fn(async () => ({ workflows: [WF_ROW] }));
    const workflowRunStream = vi.fn(() => runHandle());
    const f = makeFixture({
      quickPickAnswers: pickWorkflow(),
      // Approve the pre-flight — the run is a gated, prompting surface.
      warnMessageClicks: ["Send"],
      openClient: makeFakeClient({
        workflowList,
        workflowRunStream,
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")();
    expect(workflowList).toHaveBeenCalled();
    expect(workflowRunStream).toHaveBeenCalledWith(
      expect.objectContaining({ name: "nightly-sync", dryRun: false }),
    );
    expect(f.openedDocs[0]?.title).toContain("run-1");
  });

  // Regression: activate() bridges vscode.window to WindowApi with an `unknown`
  // cast, so nothing but the seam's own types stands between the run surface and
  // the wrong argument. Real withProgress calls `task(progress, token)`;
  // runWithCancellableProgress must forward the SECOND. It forwarded the first
  // for four releases — every run died on
  // "o.onCancellationRequested is not a function", so no report, no outcome, and
  // a Cancel button that sent nothing. This pins the WIRING, not the seam: the
  // suite was green (1119 tests) throughout.
  test("a cancellable run hands its body the token, not the progress reporter", async () => {
    const cancelSubscribers: Array<() => void> = [];
    const handleCancel = vi.fn(async () => ({ cancelled: true }));
    const workflowRunStream = vi.fn(() => ({
      streamId: "sid-1",
      result: Promise.resolve({ ...RUN_RESULT, status: "cancelled" }),
      cancel: handleCancel,
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: async () => {
            if (sent) return { value: undefined, done: true };
            sent = true;
            // Mid-run, the user hits Cancel on the progress notification.
            for (const cb of cancelSubscribers) cb();
            return { value: { type: "chunk", text: "collect: ok" }, done: false };
          },
        };
      },
    }));
    const f = makeFixture({
      quickPickAnswers: pickWorkflow(),
      warnMessageClicks: ["Send"],
      cancelSubscribers,
      openClient: makeFakeClient({
        workflowList: async () => ({ workflows: [WF_ROW] }),
        workflowRunStream,
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")();

    // The body subscribed on the object that HAS onCancellationRequested — the
    // token. Handed the progress reporter instead, the run throws before this.
    expect(cancelSubscribers.length).toBe(1);
    // And the subscription is live: firing it reaches workflow.cancel.
    expect(handleCancel).toHaveBeenCalled();
    expect(f.errorMessages).toEqual([]);
    // The run still settles: report tab and outcome, not a dead notification.
    expect(f.openedDocs[0]?.title).toContain("run-1");
  });

  test("nimbus.dryRunWorkflow asks the Gateway for a dry run", async () => {
    const workflowRunStream = vi.fn(() => runHandle());
    const f = makeFixture({
      quickPickAnswers: pickWorkflow(),
      warnMessageClicks: ["Send"],
      openClient: makeFakeClient({
        workflowList: async () => ({ workflows: [WF_ROW] }),
        workflowRunStream,
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.dryRunWorkflow")();
    expect(workflowRunStream).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  test("a run invoked from a tree row uses that row's workflow, skipping the picker", async () => {
    const workflowRunStream = vi.fn(() => runHandle());
    const f = makeFixture({
      // Deliberately empty: if the picker were consulted this would run nothing.
      quickPickAnswers: [],
      warnMessageClicks: ["Send"],
      openClient: makeFakeClient({
        workflowList: async () => ({ workflows: [WF_ROW] }),
        workflowRunStream,
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")({ payload: { workflowName: "nightly-sync" } });
    expect(workflowRunStream).toHaveBeenCalledWith(
      expect.objectContaining({ name: "nightly-sync" }),
    );
  });

  test("a tree argument with no usable payload falls back to the picker", async () => {
    // VS Code hands the node itself; a malformed or foreign one must not be
    // trusted into a run.
    const workflowRunStream = vi.fn(() => runHandle());
    const f = makeFixture({
      quickPickAnswers: pickWorkflow(),
      warnMessageClicks: ["Send"],
      openClient: makeFakeClient({
        workflowList: async () => ({ workflows: [WF_ROW] }),
        workflowRunStream,
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")({ payload: { workflowName: 42 } });
    expect(workflowRunStream).toHaveBeenCalled();
    expect(
      (f.deps.window.showQuickPick as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(0);
  });

  test("declining the pre-flight starts no run", async () => {
    const workflowRunStream = vi.fn(() => runHandle());
    const f = makeFixture({
      quickPickAnswers: pickWorkflow(),
      // Dismissed — the gate fails closed.
      warnMessageClicks: [undefined],
      openClient: makeFakeClient({
        workflowList: async () => ({ workflows: [WF_ROW] }),
        workflowRunStream,
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")();
    expect(workflowRunStream).not.toHaveBeenCalled();
    expect(f.openedDocs).toEqual([]);
    expect(f.errorMessages).toEqual([]);
  });

  test("running while disconnected reports it instead of throwing", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")();
    expect(f.errorMessages.join(" ")).toMatch(/not connected/i);
  });
});
