import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import { commands, env, Uri, window as vscodeWindow, workspace as vscodeWorkspace } from "vscode";
import type { ChatPanel } from "../../src/chat/chat-panel.js";
import type { ParticipantDeps } from "../../src/chat-participant/participant-types.js";
import type { AutoStarter, AutoStartResult } from "../../src/connection/auto-start.js";
import { DIAGNOSTIC_COMMANDS } from "../../src/diagnostics/actions.js";
import {
  activateWithDeps,
  createDiffOpener,
  createReadonlyJsonOpener,
  createSourceOpener,
} from "../../src/extension.js";
import type { LmToolsDeps } from "../../src/lm-tools/lm-tools.js";
import type { GitApiLike, GitRepositoryLike } from "../../src/scm/git-types.js";
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
// The same module instance "vscode" resolves to, imported by path for the
// members the real API types do not declare (captured providers) or declare
// read-only (activeTextEditor, workspaceFolders), which a test seeds.
import {
  Hover,
  MarkdownString,
  languages as stubLanguages,
  window as stubWindow,
  workspace as stubWorkspace,
} from "./vscode-stub.js";

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
    subscribeConnectorConfigChanged: () => ({ dispose: () => undefined }),
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
  subscribeConnectorConfigChanged(): { dispose(): void } {
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
  // Every message the (fake) chat panel would have posted to the webview —
  // the only way these tests can see an attach command's effect, since
  // ChatController lives inside extension.ts's closure.
  postedToWebview: unknown[];
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
    /** Zero-based selection range endpoints. Default to `line` when omitted. */
    startLine?: number;
    endLine?: number;
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
    | { label: string; preset?: { label: string; prompt: string } }
    | { label: string; kind: "file"; path: string }
    | { label: string; description?: string; kind: "index"; item: IndexItem; snippet: string }
    | { label: string; kind: "status" }
    | undefined
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
  /** What `workspace.findFiles` resolves to — the attach picker's file half. */
  findFilesResult?: readonly { fsPath: string }[];
  /**
   * Absolute fsPath -> file text, backing `workspace.openTextDocument` — what
   * the attachment cache primes from. A path missing here rejects, matching
   * the "file deleted since indexed" case the cache already tolerates.
   */
  fileContents?: Record<string, string>;
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
  const postedToWebview: unknown[] = [];
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
    postMessage: (msg: unknown) => {
      postedToWebview.push(msg);
      return Promise.resolve(true);
    },
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
              start: { line: opts.activeEditor.startLine ?? opts.activeEditor.line ?? 0 },
              end: { line: opts.activeEditor.endLine ?? opts.activeEditor.line ?? 0 },
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
    openTextDocument: (fsPath: string) => {
      const text = opts.fileContents?.[fsPath];
      return text === undefined
        ? Promise.reject(new Error("not implemented in test double"))
        : Promise.resolve({ getText: () => text, uri: { fsPath } });
    },
    findFiles: vi.fn((_include: string, _exclude: string | undefined, _max: number) =>
      Promise.resolve([...(opts.findFilesResult ?? [])]),
    ),
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
    postedToWebview,
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

interface WireChip {
  id: string;
  label: string;
  detail: string;
  state: string;
  chars: number;
}

// The most recent "attachments" message posted to the (fake) chat panel — the
// only observable trace of an attach command's effect from outside
// extension.ts's closure, since ChatController itself is never exposed.
function lastAttachments(f: Captured): { chips: readonly WireChip[] } | undefined {
  const msgs = f.postedToWebview.filter(
    (m): m is { type: "attachments"; chips: readonly WireChip[] } =>
      typeof m === "object" && m !== null && (m as { type?: unknown }).type === "attachments",
  );
  return msgs.at(-1);
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

  test("registers the seven sidebar tree views in the nimbus container", async () => {
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
      "nimbus.connectorsView",
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

  test("nimbus.attachContext excludes node_modules and primes+attaches the chosen file", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      findFilesResult: [{ fsPath: "/home/dev/proj/src/a.ts" }],
      fileContents: { "/home/dev/proj/src/a.ts": "console.log('hi');\n" },
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
      quickPickAnswers: [{ label: "$(file) src/a.ts", kind: "file", path: "src/a.ts" }],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();

    const findFiles = f.deps.workspace.findFiles as ReturnType<typeof vi.fn>;
    expect(findFiles).toHaveBeenCalledWith(
      "**/*",
      "**/{node_modules,dist,out,build,.git,coverage}/**",
      200,
    );

    const posted = lastAttachments(f);
    expect(posted?.chips).toHaveLength(1);
    expect(posted?.chips[0]?.label).toBe("src/a.ts");
    // Primed BEFORE attach: had cacheFile never been awaited, this would read
    // "unreadable · not sent" even though the file is perfectly readable.
    expect(posted?.chips[0]?.state).toBe("sent");
  });

  test("nimbus.attachContext lists both files and index hits, each with its own icon", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      findFilesResult: [{ fsPath: "/home/dev/proj/src/a.ts" }],
      openClient: makeFakeClient({
        searchRanked: async () => [
          { name: "Q3 Deck", service: "gdrive", indexPrimaryKey: "gdrive:1", itemType: "file" },
        ],
      } as never),
      quickPickAnswers: [undefined],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();

    const showQuickPick = f.deps.window.showQuickPick as ReturnType<typeof vi.fn>;
    const items = showQuickPick.mock.calls[0]?.[0] as Array<{ label: string }>;
    expect(items.some((i) => i.label === "$(file) src/a.ts")).toBe(true);
    expect(items.some((i) => i.label === "$(database) Q3 Deck")).toBe(true);
  });

  // Degraded state the attach design requires: "searchRanked throws while
  // picking → the picker shows files only, with a row explaining the index
  // is unavailable." Before this fix, a thrown searchRanked only produced a
  // `log.warn` — a user with the Gateway down saw a files-only picker
  // indistinguishable from "your index is empty".
  test("nimbus.attachContext shows a status row (not silence) when searchRanked throws", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      findFilesResult: [{ fsPath: "/home/dev/proj/src/a.ts" }],
      openClient: makeFakeClient({
        searchRanked: async () => {
          throw new Error("index down");
        },
      } as never),
      quickPickAnswers: [undefined],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();

    const showQuickPick = f.deps.window.showQuickPick as ReturnType<typeof vi.fn>;
    const items = showQuickPick.mock.calls[0]?.[0] as Array<{
      label: string;
      kind?: string;
    }>;
    expect(items.some((i) => i.label === "$(file) src/a.ts")).toBe(true);
    const status = items.find((i) => i.kind === "status");
    expect(status?.label).toContain("Index unavailable");
  });

  // Selecting the status row must be a no-op — it exists to explain absence,
  // not to be attached.
  test("nimbus.attachContext's status row cannot itself be attached", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({
        searchRanked: async () => {
          throw new Error("index down");
        },
      } as never),
      quickPickAnswers: [{ label: "$(warning) Index unavailable", kind: "status" }],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();
    expect(lastAttachments(f)).toBeUndefined();
  });

  test("nimbus.attachContext refuses a secret-shaped index hit with a warning instead of attaching it", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
      quickPickAnswers: [
        {
          label: "$(database) .env",
          kind: "index",
          item: { id: "x", name: ".env", service: "gdrive" },
          snippet: "SECRET=1",
        },
      ],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();

    expect(f.warnMessages.some((m) => m.includes(".env") && m.includes("secret"))).toBe(true);
    expect(lastAttachments(f)).toBeUndefined();
  });

  // A row whose semanticSnippet already came back from the browse
  // (searchRanked({limit})) call must not trigger a SECOND, per-attach
  // lookup — attachIndexItem's fetch is a fallback for an absent snippet,
  // not an unconditional re-query.
  test("nimbus.attachContext's index rows skip the snippet lookup when one is already known", async () => {
    const askStream = doneAskStream();
    const searchRanked = vi.fn(async (_p: { name?: string; limit?: number }) => []);
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({ askStream, searchRanked } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["hi"],
      quickPickAnswers: [
        {
          label: "$(database) Report",
          kind: "index",
          item: { id: "x", name: "Report", service: "github" },
          snippet: "Already-known snippet content.",
        },
      ],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();

    // Exactly one call: the browse that built the picker's rows. A second
    // call (the named lookup) would mean the known snippet was ignored.
    expect(searchRanked).toHaveBeenCalledTimes(1);
    expect(searchRanked).toHaveBeenCalledWith({ limit: expect.any(Number) });

    await cmd(f, "nimbus.ask")();
    const sent = (askStream.mock.calls[0]?.[0] as string | undefined) ?? "";
    expect(sent).toContain("Already-known snippet content.");
  });

  test("nimbus.attachSelectionToAsk captures the selection text and 1-based line range", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      activeEditor: {
        text: "line0\nline1\nline2\nline3\n",
        selectionText: "line1\nline2",
        empty: false,
        startLine: 1,
        endLine: 2,
        fileName: "/home/dev/proj/src/a.ts",
      },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.attachSelectionToAsk")();
    await waitForConnect();

    const posted = lastAttachments(f);
    expect(posted?.chips[0]?.label).toBe("src/a.ts");
    expect(posted?.chips[0]?.detail).toContain("lines 2-3");
  });

  test("nimbus.attachSelectionToAsk errors when there is no selection", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.attachSelectionToAsk")();
    expect(f.errorMessages.some((m) => m.includes("select text first"))).toBe(true);
  });

  // The tree row never carries a snippet at all (NimbusItem has no such
  // field) — attachIndexItem must fetch one via a NAMED searchRanked lookup,
  // matched on indexPrimaryKey, before falling back to metadata. Proven at
  // the CONTENT level (not just chip state) by actually sending a turn and
  // reading what askStream received — the wire "attachments" message never
  // carries the raw block, only label/detail/state/chars.
  test("nimbus.attachIndexItemToAsk fetches a semantic snippet via a named searchRanked lookup", async () => {
    const askStream = doneAskStream();
    const searchRanked = vi.fn(async (p: { name?: string; limit?: number }) => {
      if (p.name === "Q3 Deck") {
        return [
          {
            name: "Q3 Deck",
            service: "gdrive",
            indexPrimaryKey: "a",
            itemType: "file",
            semanticSnippet: "Quarterly revenue is up 12% year over year.",
          },
        ];
      }
      return [];
    });
    const f = makeFixture({
      openClient: makeFakeClient({ askStream, searchRanked } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["hi"],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(
      f,
      "nimbus.attachIndexItemToAsk",
    )({
      label: "Q3 Deck",
      contextValue: "nimbusIndexItem",
      payload: { id: "a", name: "Q3 Deck", service: "gdrive", itemType: "file" },
    });

    expect(searchRanked).toHaveBeenCalledWith({ name: "Q3 Deck", limit: expect.any(Number) });
    const posted = lastAttachments(f);
    expect(posted?.chips[0]?.label).toBe("Q3 Deck");
    expect(posted?.chips[0]?.state).toBe("sent");

    // The fetched snippet, not a metadata block, is what actually left.
    await cmd(f, "nimbus.ask")();
    const sent = (askStream.mock.calls[0]?.[0] as string | undefined) ?? "";
    expect(sent).toContain("Quarterly revenue is up 12% year over year.");
  });

  // Nothing in the index matches by name (or the match has no
  // semanticSnippet either) — attachIndexItem must fall back to a NEUTRAL
  // metadata block rather than attaching emptiness. Proven by checking the
  // block that actually reaches askStream contains the item's own name and
  // service, so "we attached something" cannot pass while the block is
  // blank — and that it carries no imperative, since it is prepended AHEAD
  // of the user's own typed question and must not upstage it.
  test("nimbus.attachIndexItemToAsk falls back to a metadata block when no snippet can be found", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({
        askStream,
        searchRanked: async () => [],
      } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["hi"],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(
      f,
      "nimbus.attachIndexItemToAsk",
    )({
      label: "Q3 Deck",
      contextValue: "nimbusIndexItem",
      payload: { id: "a", name: "Q3 Deck", service: "gdrive", itemType: "file" },
    });

    const posted = lastAttachments(f);
    expect(posted?.chips[0]?.label).toBe("Q3 Deck");
    // A metadata block is real content, not emptiness — the assembler sends
    // it, it does not refuse it as unreadable.
    expect(posted?.chips[0]?.state).toBe("sent");

    await cmd(f, "nimbus.ask")();
    const sent = (askStream.mock.calls[0]?.[0] as string | undefined) ?? "";
    expect(sent).toContain("Q3 Deck");
    expect(sent).toContain("gdrive");
    // Not buildAskPrompt's imperative: the user's own typed question ("hi")
    // must read as the instruction, not have one prepended ahead of it.
    expect(sent).not.toContain("Tell me about");
  });

  test("nimbus.attachIndexItemToAsk refuses a secret-shaped item with a warning, never attaching it", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(
      f,
      "nimbus.attachIndexItemToAsk",
    )({
      label: ".env.production",
      contextValue: "nimbusIndexItem",
      payload: { id: "a", name: ".env.production", service: "local_files" },
    });
    await waitForConnect();

    expect(f.warnMessages.some((m) => m.includes(".env.production") && m.includes("secret"))).toBe(
      true,
    );
    expect(lastAttachments(f)).toBeUndefined();
  });

  test("nimbus.attachIndexItemToAsk is a no-op for a node without a payload", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.attachIndexItemToAsk")({ label: "x", contextValue: "nimbusIndexItem" });
    await waitForConnect();
    expect(lastAttachments(f)).toBeUndefined();
  });

  test("openAttachPicker and detachContext webview messages route to the attach picker and detach", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      findFilesResult: [{ fsPath: "/home/dev/proj/src/a.ts" }],
      fileContents: { "/home/dev/proj/src/a.ts": "console.log('hi');\n" },
      openClient: makeFakeClient({
        askStream: doneAskStream(),
        searchRanked: async () => [],
      } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["hi"],
      quickPickAnswers: [{ label: "$(file) src/a.ts", kind: "file", path: "src/a.ts" }],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    // Ask first, so the panel exists and registers its onMessage handler.
    await cmd(f, "nimbus.ask")();
    const fire = f.webviewMessageHandlers[0];
    if (fire === undefined) throw new Error("no webview message handler registered");

    // `fire` mirrors panel.onMessage's real signature — void, fire-and-forget —
    // so its async work (findFiles/searchRanked/showQuickPick/cacheFile) is
    // only OBSERVABLE after letting the microtask queue drain, same as the
    // "route every known message type" test above does for submitAsk.
    fire({ type: "openAttachPicker" });
    await waitForConnect();
    await waitForConnect();
    const afterAttach = lastAttachments(f);
    const id = afterAttach?.chips[0]?.id;
    expect(id).toBeTruthy();

    fire({ type: "detachContext", id });
    await waitForConnect();
    const afterDetach = lastAttachments(f);
    expect(afterDetach?.chips).toHaveLength(0);
  });

  // Before this fix, `openAttachPicker: () => attachPicker()` had no
  // try/catch, and panel.onMessage's caller `void`-s the handler's promise —
  // a thrown findFiles (a very large or virtual workspace can throw rather
  // than reject gracefully) left the Attach button doing nothing at all: no
  // message, no log. `onSubmitAsk` right next door already guards this;
  // mirrored here.
  test("openAttachPicker webview message logs rather than swallowing when the picker throws", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({
        askStream: doneAskStream(),
        searchRanked: async () => [],
      } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["hi"],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.ask")();
    const fire = f.webviewMessageHandlers[0];
    if (fire === undefined) throw new Error("no webview message handler registered");

    (f.deps.workspace.findFiles as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("workspace too large to enumerate");
    });

    expect(() => fire({ type: "openAttachPicker" })).not.toThrow();
    await waitForConnect();
    await waitForConnect();
    expect(
      f.outputAppendLines.some(
        (l) => l.includes("openAttachPicker failed") && l.includes("too large"),
      ),
    ).toBe(true);
  });

  // `attachments.ts` promises a secret-shaped path is "never even read" — the
  // picker's file branch called cacheFile() BEFORE attaching, reading a
  // picked .env's bytes into the extension host even though the assembler
  // would refuse to send them. No bytes left the process, but the comment
  // and the behaviour disagreed; this proves the read itself is skipped.
  test("nimbus.attachContext never reads a secret-shaped file picked from the list", async () => {
    const openTextDocument = vi.fn(async () => ({
      getText: () => "SECRET=1",
      uri: { fsPath: "/home/dev/proj/.env" },
    }));
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      findFilesResult: [{ fsPath: "/home/dev/proj/.env" }],
      openClient: makeFakeClient({ searchRanked: async () => [] } as never),
      quickPickAnswers: [{ label: "$(file) .env", kind: "file", path: ".env" }],
    });
    f.deps.workspace.openTextDocument = openTextDocument;
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();

    expect(openTextDocument).not.toHaveBeenCalled();
    // Still attached (and still correctly refused by the assembler) — this
    // is about the READ, not about whether the chip shows up.
    const posted = lastAttachments(f);
    expect(posted?.chips[0]?.label).toBe(".env");
    expect(posted?.chips[0]?.state).toBe("refused");
  });

  // When a chat controller already exists, ensureChatController() returns it
  // WITHOUT calling createOrReveal() — so an attach from the editor context
  // menu, with the Nimbus tab in a background group, used to look like
  // nothing happened.
  test("nimbus.attachSelectionToAsk reveals the panel even when the controller already exists", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({ askStream: doneAskStream() } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["hi"],
      activeEditor: {
        text: "line0\nline1\n",
        selectionText: "line1",
        empty: false,
        startLine: 1,
        endLine: 1,
        fileName: "/home/dev/proj/src/a.ts",
      },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.ask")(); // creates the controller (and reveals once)
    const revealedAfterCreate = f.panelRevealedCount;

    cmd(f, "nimbus.attachSelectionToAsk")();
    await waitForConnect();

    expect(f.panelRevealedCount).toBeGreaterThan(revealedAfterCreate);
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
      fire({ type: "openAttachPicker" });
      fire({ type: "detachContext", id: "a1" });
      fire({ type: "unknownType" });
      fire("not an object");
      fire(null);
      fire({ noType: true });
    }).not.toThrow();

    // `startGateway` above kicks off a fire-and-forget reconnect
    // (closeClient -> tryConnect); let it fully settle before relying on the
    // connection again, or submitAsk can land in the brief disconnected
    // window and skip the askStream call it's here to prove happens.
    await waitForConnect();
    await waitForConnect();

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
        // Has synced before and holds indexed items: a connector that WAS
        // working and broke. One that never synced and indexed nothing was
        // never configured, and no longer counts as degraded — see
        // summarizeConnectorHealth.
        lastSyncAt: 1_700_000_000_000,
        nextSyncAt: null,
        intervalMs: 60000,
        itemCount: 42,
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

  test("a connector health change recollects the context panel, not just the Connectors view", async () => {
    // Captures the WebviewViewProvider real-context-view.ts hands to
    // vscode.window.registerWebviewViewProvider — real-context-view.ts talks
    // to the raw "vscode" module directly, not deps.window, so this is the
    // only seam that can resolve the view the way VS Code itself would.
    const registerSpy = vi.spyOn(vscodeWindow, "registerWebviewViewProvider");
    const posted: unknown[] = [];
    const fakeWebviewView = {
      visible: true,
      webview: {
        options: undefined as unknown,
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u: unknown) => ({ toString: () => `https://webview/${String(u)}` }),
        onDidReceiveMessage: (_h: (raw: unknown) => void) => ({ dispose: () => undefined }),
        postMessage: vi.fn(async (msg: unknown) => {
          posted.push(msg);
          return true;
        }),
      },
      onDidChangeVisibility: (_h: () => void) => ({ dispose: () => undefined }),
      onDidDispose: (_h: () => void) => ({ dispose: () => undefined }),
    };

    const connectorListStatus = vi.fn(async () => [
      {
        serviceId: "github",
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

    const call = registerSpy.mock.calls.find(([viewId]) => viewId === "nimbus.contextView");
    const provider = call?.[1] as { resolveWebviewView: (v: unknown) => void };
    provider.resolveWebviewView(fakeWebviewView);
    expect(posted).toHaveLength(0); // resolving the view alone must not collect

    await waitForConnect();
    await flush();

    expect(connectorListStatus).toHaveBeenCalled();
    // The health-change branch called the recollect handle, which ran a real
    // collection and posted its render — proof the handle is wired, not just
    // that connectorsView.refresh() fired.
    expect(fakeWebviewView.webview.postMessage).toHaveBeenCalled();
    expect(posted.some((m) => (m as { type?: string }).type === "render")).toBe(true);
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
    expect(cancelSubscribers).toHaveLength(1);
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

  test.each([
    ["a string", "nightly-sync"],
    ["null", null],
  ])("a tree argument whose payload is %s falls back to the picker", async (_label, payload) => {
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
    await cmd(f, "nimbus.runWorkflow")({ payload });
    expect(f.deps.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(workflowRunStream).toHaveBeenCalledWith(
      expect.objectContaining({ name: "nightly-sync" }),
    );
  });

  test("a Gateway that drops between listing and running reports the run as not connected", async () => {
    // The listing succeeded on a live client; by the time the run is started
    // the connection has gone. The run must refuse rather than reach for a
    // client that no longer exists.
    let f: ReturnType<typeof makeFixture> | undefined;
    const workflowRunStream = vi.fn(() => runHandle());
    const workflowList = vi.fn(async () => {
      // Drops the live client synchronously; the re-dial then fails.
      if (f !== undefined) void cmd(f, "nimbus.reconnect")();
      return { workflows: [WF_ROW] };
    });
    f = makeFixture({
      openClient: connectsOnce(
        makeFakeClient({ workflowList, workflowRunStream } as unknown as Partial<ClientLike>),
      ),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.runWorkflow")({ payload: { workflowName: "nightly-sync" } });
    expect(workflowList).toHaveBeenCalledTimes(1);
    expect(workflowRunStream).not.toHaveBeenCalled();
    expect(f.errorMessages).toContain(
      "Nimbus: workflow nightly-sync failed — Nimbus: not connected to the Gateway.",
    );
    teardown(f);
  });
});

// Connects once, then refuses every later attempt — so a test can build state
// while connected and then lose the Gateway underneath it: nimbus.reconnect
// drops the live client before it re-dials, and the re-dial fails.
function connectsOnce(client: () => Promise<ClientLike>): () => Promise<ClientLike> {
  let opened = false;
  return async () => {
    if (opened) throw new Error("ECONNREFUSED");
    opened = true;
    return await client();
  };
}

// Disposes everything activation registered. Among other things this stops the
// connection manager, whose reconnect backoff would otherwise keep a 3s timer
// alive past the test that made the connection fail.
function teardown(f: Captured): void {
  for (const s of f.ctx.subscriptions) s.dispose();
}

const NOT_CONNECTED_YET =
  'Nimbus is not connected to the Gateway yet. Try again in a moment, or run "Nimbus: Reconnect to Gateway".';

describe("activation reads its settings", () => {
  test("a short workspace root is named in the debug log as dropped from the leak check", async () => {
    // Narrowing the leak check silently would read as "we checked everything".
    const f = makeFixture({
      cfg: { logLevel: "debug" },
      workspaceFolders: [{ uri: { fsPath: "/w" } }],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const line = f.outputAppendLines.find((l) => l.includes("egress: leak check skipping"));
    expect(line).toMatch(/\[debug\] egress: leak check skipping \d+ short root\(s\): /);
    expect(line?.split("short root(s): ")[1]?.split(", ")).toContain("/w");
  });

  test("when every root is long enough to search for, nothing is reported as skipped", async () => {
    // os.tmpdir() is "/tmp" on Linux — always too short — so the temp dir is
    // pointed at a longer path for this activation: TMPDIR on POSIX, TEMP/TMP
    // on Windows. That is the situation a macOS or Windows user is in.
    const names = ["TMPDIR", "TEMP", "TMP"] as const;
    const saved = names.map((n) => [n, process.env[n]] as const);
    const longTemp = join(tmpdir(), "nimbus-long-enough-temp-root");
    for (const n of names) process.env[n] = longTemp;
    try {
      expect(tmpdir()).toBe(longTemp);
      const f = makeFixture({
        cfg: { logLevel: "debug" },
        workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      });
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      expect(
        f.outputAppendLines.some((l) => l.includes("Nimbus VS Code extension activating")),
      ).toBe(true);
      expect(f.outputAppendLines.some((l) => l.includes("leak check skipping"))).toBe(false);
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  test("an explicit nimbus.socketPath is dialled as-is, without discovery", async () => {
    const override = join(tmpdir(), "nimbus-override.sock");
    const discover = vi.fn(async () => ({ socketPath: TEST_SOCKET_PATH, source: "default" }));
    const dialled: string[] = [];
    const f = makeFixture({ cfg: { socketPath: override }, discoverSocket: discover });
    const client = await makeFakeClient()();
    f.deps.openClient = async (socketPath) => {
      dialled.push(socketPath);
      return client;
    };
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(dialled).toEqual([override]);
    expect(discover).not.toHaveBeenCalled();
  });

  test("the Connectors view lists never-configured services only when the setting asks", async () => {
    const connectorListStatus = vi.fn(async () => [
      {
        serviceId: "airflow",
        status: "ok" as const,
        healthState: "not_configured",
        lastSyncAt: null,
        nextSyncAt: null,
        intervalMs: 60_000,
        itemCount: 0,
        lastError: null,
        consecutiveFailures: 0,
        depth: "summary" as const,
        enabled: true,
      },
    ]);
    const labelsWith = async (cfg: Record<string, unknown>): Promise<string[]> => {
      const f = makeFixture({
        cfg,
        openClient: makeFakeClient({ connectorListStatus } as unknown as Partial<ClientLike>),
      });
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      const rows = (await f.treeProviders.get("nimbus.connectorsView")?.getChildren()) ?? [];
      return (rows as Array<{ label: string }>).map((r) => r.label);
    };
    expect(await labelsWith({ "connectors.showUnconfigured": true })).toEqual(["airflow"]);
    expect((await labelsWith({}))[0]).toBe("No connectors configured");
  });
});

describe("status-bar polls that race", () => {
  // The connector poll runs on every status-bar render; a nimbus.* settings
  // change is the simplest way to trigger one.
  const pollAgain = (f: Captured): void => {
    for (const h of f.configChangeHandlers) h({ affectsConfiguration: (s) => s === "nimbus" });
  };
  // Every value the extension has set `nimbus.connected` to, in order. It starts
  // with the replay of the initial idle state (false), then true on connect.
  const connectedFlags = (f: Captured & { deps: ActivateDeps }): unknown[] =>
    (f.deps.commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === "setContext" && c[1] === "nimbus.connected")
      .map((c) => c[2]);

  test("an egress poll that FAILS after a newer poll succeeded neither logs nor tears down", async () => {
    // A transport-shaped error: honoured, it would mark the connection dead.
    const first = deferred<never>();
    let call = 0;
    const egressHead = vi.fn(async () => {
      call += 1;
      if (call === 1) return await first.promise;
      return { head: "freshhead00", count: 99 };
    });
    const f = makeFixture({ openClient: makeFakeClient({ egressHead } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    call = 0;
    cmd(f, "nimbus.refreshEgress")(); // poll #1: pending
    await Promise.resolve();
    cmd(f, "nimbus.refreshEgress")(); // poll #2: supersedes #1
    await flush();
    let rejectFirst = (_e: Error): void => undefined;
    const late = new Promise<never>((_r, reject) => {
      rejectFirst = reject;
    });
    const flagsBefore = connectedFlags(f);
    first.resolve(late as never);
    rejectFirst(new Error("socket hang up"));
    await flush();
    expect(f.outputAppendLines.some((l) => l.includes("egressHead poll failed"))).toBe(false);
    // Still connected: the stale failure did not mark the transport dead.
    expect(flagsBefore.at(-1)).toBe(true);
    expect(connectedFlags(f)).toEqual(flagsBefore);
    expect(f.statusItem.text).toContain("99");
  });

  test("a superseded connector poll's late answer does not repaint the status bar", async () => {
    const degraded = [
      {
        serviceId: "slack",
        status: "error" as const,
        lastSyncAt: 1_700_000_000_000,
        nextSyncAt: null,
        intervalMs: 60000,
        itemCount: 42,
        lastError: "401",
        consecutiveFailures: 3,
        depth: "summary" as const,
        enabled: true,
      },
    ];
    const slow = deferred<typeof degraded>();
    let call = 0;
    const connectorListStatus = vi.fn(async () => {
      call += 1;
      return call === 2 ? await slow.promise : [];
    });
    const f = makeFixture({
      openClient: makeFakeClient({ connectorListStatus } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    expect(call).toBe(1);
    pollAgain(f); // #2: pending, will answer "slack is degraded"
    pollAgain(f); // #3: answers healthy, first
    await flush();
    slow.resolve(degraded);
    await flush();
    expect(call).toBe(3);
    expect(f.statusItem.tooltip ?? "").not.toContain("slack");
    expect(f.statusItem.text).not.toContain("degraded");
  });

  test("a superseded connector poll's late FAILURE neither logs nor tears down", async () => {
    let failSlow = (_e: Error): void => undefined;
    const slow = new Promise<never>((_r, reject) => {
      failSlow = reject;
    });
    let call = 0;
    const connectorListStatus = vi.fn(async () => {
      call += 1;
      return call === 2 ? await slow : [];
    });
    const f = makeFixture({
      openClient: makeFakeClient({ connectorListStatus } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    pollAgain(f);
    pollAgain(f);
    await flush();
    const flagsBefore = connectedFlags(f);
    failSlow(new Error("socket hang up"));
    await flush();
    expect(call).toBe(3);
    expect(f.outputAppendLines.some((l) => l.includes("connectorListStatus poll failed"))).toBe(
      false,
    );
    expect(flagsBefore.at(-1)).toBe(true);
    expect(connectedFlags(f)).toEqual(flagsBefore);
  });
});

describe("chat panel messages that carry nothing usable", () => {
  const handler = (f: Captured): ((msg: unknown) => void) => {
    const h = f.webviewMessageHandlers.at(-1);
    if (h === undefined) throw new Error("no webview message handler registered");
    return h;
  };

  test("a submitAsk with blank or non-string text starts no stream", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({ openClient: makeFakeClient({ askStream } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.newConversation")();
    handler(f)({ type: "submitAsk", text: "   " });
    handler(f)({ type: "submitAsk", text: 42 });
    handler(f)({ type: "submitAsk" });
    await flush();
    expect(askStream).not.toHaveBeenCalled();
    // The positive control: the same handler does start a stream for real text.
    handler(f)({ type: "submitAsk", text: "why is p99 up?" });
    await flush();
    expect(askStream).toHaveBeenCalledTimes(1);
  });

  test("a submitAsk after the Gateway dropped and the panel was rebuilt says so", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({ openClient: connectsOnce(makeFakeClient({ askStream } as never)) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.newConversation")();
    const fire = handler(f);
    f.disposeChatPanel(); // drops the cached controller
    await cmd(f, "nimbus.reconnect")(); // and the Gateway with it
    fire({ type: "submitAsk", text: "still there?" });
    await flush();
    expect(f.errorMessages).toContain(NOT_CONNECTED_YET);
    expect(askStream).not.toHaveBeenCalled();
    teardown(f);
  });

  test("a hitlResponse with no request id resolves nothing; an unknown decision resolves without answering", async () => {
    const { f } = makeInlineHitlFixture();
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.ask")();
    await flush();
    handle.fireHitl({
      requestId: "req-z",
      prompt: "Allow?",
      streamId: "s-inline",
    } as Parameters<typeof handle.fireHitl>[0]);
    await flush();

    handler(f)({ type: "hitlResponse", requestId: "", decision: "approve" });
    await flush();
    // Still pending: showPendingHitl reveals the panel only while one is.
    const revealsBefore = f.panelRevealedCount;
    await cmd(f, "nimbus.showPendingHitl")();
    expect(f.panelRevealedCount).toBe(revealsBefore + 1);

    // Neither "approve" nor "reject": resolved as no decision, so nothing is
    // sent — and the request is no longer pending.
    handler(f)({ type: "hitlResponse", requestId: "req-z", decision: "maybe" });
    await flush();
    expect(f.outputAppendLines.some((l) => l.includes("HITL sendResponse failed"))).toBe(false);
    const revealsAfter = f.panelRevealedCount;
    await cmd(f, "nimbus.showPendingHitl")();
    expect(f.panelRevealedCount).toBe(revealsAfter);
  });

  test("an openExternal with no url opens nothing", async () => {
    const openExternal = vi.spyOn(env, "openExternal");
    try {
      const f = makeFixture({});
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      await cmd(f, "nimbus.newConversation")();
      handler(f)({ type: "openExternal", url: "" });
      handler(f)({ type: "openExternal" });
      await flush();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      openExternal.mockRestore();
    }
  });

  test("a detachContext with no id detaches nothing", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      activeEditor: {
        text: "line0\nline1\n",
        selectionText: "line1",
        empty: false,
        fileName: "/home/dev/proj/src/a.ts",
      },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachSelectionToAsk")();
    const id = lastAttachments(f)?.chips[0]?.id ?? "";
    expect(id.length).toBeGreaterThan(0);
    const postsBefore = f.postedToWebview.length;
    handler(f)({ type: "detachContext", id: "" });
    await flush();
    expect(f.postedToWebview).toHaveLength(postsBefore);
    handler(f)({ type: "detachContext", id });
    await flush();
    expect(lastAttachments(f)?.chips).toEqual([]);
  });
});

describe("attachments, end to end", () => {
  test("a file attached earlier is re-read at send, so an edit made since is what goes out", async () => {
    const askStream = doneAskStream();
    const fileContents: Record<string, string> = {
      "/home/dev/proj/src/a.ts": "export const v = 1;\n",
    };
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      findFilesResult: [{ fsPath: "/home/dev/proj/src/a.ts" }],
      fileContents,
      openClient: makeFakeClient({ askStream, searchRanked: async () => [] } as never),
      quickPickAnswers: [{ label: "$(file) src/a.ts", kind: "file", path: "src/a.ts" }],
      inputBoxAnswers: ["what does this export?"],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();
    fileContents["/home/dev/proj/src/a.ts"] = "export const v = 2;\n"; // edited since attaching
    await cmd(f, "nimbus.ask")();
    const sent = String(askStream.mock.calls[0]?.[0] ?? "");
    expect(sent).toContain("export const v = 2;");
    expect(sent).not.toContain("export const v = 1;");
  });

  test("an index item whose snippet lookup fails is attached from its metadata, and the failure is logged", async () => {
    const askStream = doneAskStream();
    const f = makeFixture({
      openClient: makeFakeClient({
        askStream,
        searchRanked: async () => {
          throw new Error("index busy");
        },
      } as unknown as Partial<ClientLike>),
      inputBoxAnswers: ["summarise it"],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(
      f,
      "nimbus.attachIndexItemToAsk",
    )({
      payload: {
        id: "notion:9",
        name: "Runbook",
        service: "notion",
        itemType: "page",
        url: "https://notion.example/runbook",
      },
    });
    expect(
      f.outputAppendLines.some((l) =>
        l.includes("attach index item: snippet lookup failed: index busy"),
      ),
    ).toBe(true);
    expect(lastAttachments(f)?.chips[0]?.label).toBe("Runbook");
    await cmd(f, "nimbus.ask")();
    const sent = String(askStream.mock.calls[0]?.[0] ?? "");
    expect(sent).toContain(
      "Name: Runbook\nService: notion\nType: page\nURL: https://notion.example/runbook",
    );
  });

  test("attaching an index item after the Gateway dropped still attaches it, without a lookup", async () => {
    const searchRanked = vi.fn(async () => []);
    const f = makeFixture({
      openClient: connectsOnce(makeFakeClient({ searchRanked } as unknown as Partial<ClientLike>)),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.newConversation")(); // the panel exists...
    await cmd(f, "nimbus.reconnect")(); // ...and then the Gateway goes
    await cmd(
      f,
      "nimbus.attachIndexItemToAsk",
    )({
      payload: { id: "gdrive:1", name: "Q3 Deck", service: "gdrive" },
    });
    expect(searchRanked).not.toHaveBeenCalled();
    // No lookup was even attempted, so none failed.
    expect(f.outputAppendLines.some((l) => l.includes("snippet lookup failed"))).toBe(false);
    expect(lastAttachments(f)?.chips.map((c) => c.label)).toEqual(["Q3 Deck"]);
    teardown(f);
  });

  test("the picker describes a typeless index hit by its service alone, and keeps its url", async () => {
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({
        searchRanked: async () => [
          {
            name: "Q3 Deck",
            service: "gdrive",
            indexPrimaryKey: "gdrive:1",
            url: "https://docs.example/q3",
          },
        ],
      } as never),
      quickPickAnswers: [undefined],
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();
    const items = (f.deps.window.showQuickPick as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Array<{ label: string; description?: string; item?: { url?: string } }>;
    const row = items.find((i) => i.label === "$(database) Q3 Deck");
    expect(row?.description).toBe("gdrive");
    expect(row?.item?.url).toBe("https://docs.example/q3");
  });

  test("the attach picker while disconnected says so and lists nothing", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachContext")();
    expect(f.errorMessages).toContain(NOT_CONNECTED_YET);
    expect(f.deps.workspace.findFiles).not.toHaveBeenCalled();
    teardown(f);
  });

  test("a whitespace-only selection is not attached, and says why", async () => {
    const f = makeFixture({
      activeEditor: { text: "a\n   \n", selectionText: "   ", empty: false, fileName: "a.ts" },
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.attachSelectionToAsk")();
    expect(f.errorMessages).toEqual(["Nimbus: select text first."]);
    expect(lastAttachments(f)).toBeUndefined();
  });
});

describe("chat commands while disconnected", () => {
  const ITEM = { payload: { id: "gdrive:1", name: "Q3 Deck", service: "gdrive" } };
  const SELECTION = {
    text: "const a = 1;",
    selectionText: "const a = 1;",
    empty: false,
    fileName: "/home/dev/proj/a.ts",
  };
  test.each([
    ["nimbus.ask", [], { inputBoxAnswers: ["what changed?"] }],
    [
      "nimbus.askAboutSelection",
      [],
      { inputBoxAnswers: ["Explain this:"], activeEditor: SELECTION },
    ],
    ["nimbus.attachSelectionToAsk", [], { activeEditor: SELECTION }],
    ["nimbus.attachIndexItemToAsk", [ITEM], {}],
    ["nimbus.askAboutIndexItem", [ITEM], {}],
    ["nimbus.openSession", ["s-1"], {}],
    ["nimbus.openAgentChat", [{ id: "ops", label: "Ops" }], {}],
  ] as const)("%s says the Gateway is not connected and opens no panel", async (id, args, opts) => {
    const f = makeFixture({ ...opts, openClient: disconnectedClient() } as Parameters<
      typeof makeFixture
    >[0]);
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, id)(...args);
    expect(f.errorMessages).toEqual([NOT_CONNECTED_YET]);
    expect(f.postedToWebview).toEqual([]);
    expect(f.webviewMessageHandlers).toEqual([]);
    teardown(f);
  });

  test("findRelatedFromIndex and openEgressEntry ignore an argument they cannot read", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.findRelatedFromIndex")({ payload: { nope: true } });
    await cmd(f, "nimbus.openEgressEntry")({ nope: true });
    expect(f.quickPicks).toHaveLength(0);
    expect(f.openedDocs).toEqual([]);
    expect(f.errorMessages).toEqual([]);
  });
});

// Subscribes to a registered tree view's change event — the only trace a
// refresh() leaves from outside extension.ts.
function onViewChange(f: Captured, viewId: string): ReturnType<typeof vi.fn> {
  const provider = f.treeProviders.get(viewId) as unknown as
    | { onDidChangeTreeData?: (listener: () => void) => unknown }
    | undefined;
  if (provider?.onDidChangeTreeData === undefined) throw new Error(`${viewId} has no change event`);
  const listener = vi.fn();
  provider.onDidChangeTreeData(listener);
  return listener;
}

const BRIEF_BASE = { agentVersion: 1, generatedAt: 0, latencyMs: 1, gaps: [] };

describe("editor integrations reach the Gateway through extension.ts", () => {
  const hoverDoc = (fsPath: string) => ({ uri: { fsPath, toString: () => `file://${fsPath}` } });
  const NOT_YET_SETTLED = { isCancellationRequested: false };

  test("the blame hover asks the raw client about the hovered line, repo-relative and one-based", async () => {
    const agentsWhyPeek = vi.fn(async () => ({
      subject: null,
      author: "Ada",
      authorEmail: null,
      commitSha: "abcdef1234567",
      committedAt: null,
      commitSubject: "fix: clear the retry loop",
      pr: null,
      ticket: null,
      hasMore: false,
    }));
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      openClient: makeFakeClient({ agentsWhyPeek } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = stubLanguages.lastHoverProvider;
    if (provider === undefined) throw new Error("no hover provider registered");
    vi.useFakeTimers();
    try {
      const pending = provider.provideHover(
        hoverDoc("/home/dev/proj/src/a.ts"),
        { line: 41 },
        NOT_YET_SETTLED,
      );
      // The hover waits for the cursor to settle before it asks anything.
      await vi.advanceTimersByTimeAsync(150);
      const hover = await pending;
      expect(agentsWhyPeek).toHaveBeenCalledWith({ ref: "src/a.ts", line: 42 });
      expect(hover).toBeInstanceOf(Hover);
      const contents = (hover as Hover).contents;
      expect(contents).toBeInstanceOf(MarkdownString);
      const md = (contents as MarkdownString).value;
      expect(md).toContain("**Ada**");
      expect(md).toContain("fix: clear the retry loop");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the blame hover stays silent while disconnected, and when switched off", async () => {
    const f = makeFixture({ cfg: { logLevel: "debug" }, openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const provider = stubLanguages.lastHoverProvider;
    if (provider === undefined) throw new Error("no hover provider registered");
    vi.useFakeTimers();
    try {
      const pending = provider.provideHover(hoverDoc("/r/a.ts"), { line: 0 }, NOT_YET_SETTLED);
      await vi.advanceTimersByTimeAsync(150);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(
      f.outputAppendLines.some((l) =>
        l.includes("whyPeek hover failed: Nimbus: not connected to the Gateway."),
      ),
    ).toBe(true);
    teardown(f);

    const agentsWhyPeek = vi.fn();
    const off = makeFixture({
      cfg: { "briefs.showHoverBlame": false },
      openClient: makeFakeClient({ agentsWhyPeek } as never),
    });
    activateWithDeps(off.ctx, off.deps);
    await waitForConnect();
    const offProvider = stubLanguages.lastHoverProvider;
    expect(
      await offProvider?.provideHover(hoverDoc("/r/a.ts"), { line: 0 }, NOT_YET_SETTLED),
    ).toBeUndefined();
    expect(agentsWhyPeek).not.toHaveBeenCalled();
  });

  describe("diagnostic code actions", () => {
    const TEXT = "const a = 1;\nconst x = maybe();\nx.go();\n";
    const FILE = "/home/dev/proj/src/a.ts";
    const diagnostic = {
      message: "Object is possibly 'undefined'.",
      severity: 0,
      source: "ts",
      code: 2532,
      range: { start: { line: 1, character: 10 }, end: { line: 1, character: 17 } },
    };
    const document = { fileName: FILE, languageId: "typescript", getText: () => TEXT };

    // The argument the lightbulb would hand each command, built by the real
    // provider from the real document — not hand-written here.
    function offeredArg(): unknown {
      const provider = stubLanguages.lastCodeActionsProvider;
      if (provider === undefined) throw new Error("no code actions provider registered");
      const actions = provider.provideCodeActions(document, diagnostic.range, {
        diagnostics: [diagnostic],
      });
      const arg = actions?.[0]?.command?.arguments?.[0];
      if (arg === undefined) throw new Error("no diagnostic action was offered");
      return arg;
    }

    test("an explain action is offered and runs through the gate with the configured agent", async () => {
      const agentInvoke = vi.fn(async (_input: string, _opts: unknown) => ({
        reply: "`maybe()` can return undefined.",
      }));
      const f = makeFixture({
        cfg: { askAgent: "ops" },
        openClient: makeFakeClient({ agentInvoke } as never),
      });
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      const arg = offeredArg() as { query: string; documentPath: string; fullText: string };
      expect(arg.documentPath).toBe(FILE);
      expect(arg.fullText).toBe(TEXT);
      expect(arg.query.length).toBeGreaterThan(0);
      await cmd(f, DIAGNOSTIC_COMMANDS.explain)(arg);
      expect(agentInvoke).toHaveBeenCalledTimes(1);
      expect(agentInvoke.mock.calls[0]?.[1]).toEqual({ stream: false, agent: "ops" });
      expect(f.openedDocs).toEqual([
        { title: "Nimbus explanation.md", content: "`maybe()` can return undefined." },
      ]);
    });

    test("a fix re-reads the open document by its path and diffs against it", async () => {
      const agentInvoke = vi.fn(async () => ({ reply: "```ts\nconst x = maybe() ?? 0;\n```" }));
      const diffs: Array<{ left: string; right: string }> = [];
      const f = makeFixture({ openClient: makeFakeClient({ agentInvoke } as never) });
      f.deps.workspace.textDocuments = [{ uri: { fsPath: FILE }, getText: () => TEXT }];
      f.deps.openDiff = async (o) => {
        diffs.push({ left: o.left, right: o.right });
      };
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      await cmd(f, DIAGNOSTIC_COMMANDS.fix)(offeredArg());
      expect(diffs).toEqual([
        { left: TEXT, right: "const a = 1;\nconst x = maybe() ?? 0;\nx.go();\n" },
      ]);
      expect(f.warnMessages.filter((m) => m.includes("not open"))).toEqual([]);
    });

    test("prior occurrences opens the index search seeded with the diagnostic's query", async () => {
      const searchRanked = vi.fn(async () => []);
      const f = makeFixture({ openClient: makeFakeClient({ searchRanked } as never) });
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      const arg = offeredArg() as { query: string };
      await cmd(f, DIAGNOSTIC_COMMANDS.priorOccurrences)(arg);
      expect(f.quickPicks).toHaveLength(1);
      expect(f.quickPicks[0]?.placeholder).toBe("Prior occurrences of this error");
      expect(f.quickPicks[0]?.value).toBe(arg.query);
    });

    test("while disconnected no action is offered, and a stale one says so instead of sending", async () => {
      const f = makeFixture({ openClient: makeFakeClient({ agentInvoke: vi.fn() } as never) });
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      const arg = offeredArg(); // captured while connected...
      const explain = deferredCommand(f, DIAGNOSTIC_COMMANDS.explain);
      teardown(f); // ...and then the client is gone
      const provider = stubLanguages.lastCodeActionsProvider;
      expect(
        provider?.provideCodeActions(document, diagnostic.range, { diagnostics: [diagnostic] }),
      ).toBeUndefined();
      await explain(arg);
      expect(f.errorMessages).toEqual(["Nimbus: not connected to Gateway."]);
      expect(f.openedDocs).toEqual([]);
    });
  });

  test("the context panel's two Gateway reads reach the raw client, with the configured limit", async () => {
    const registerSpy = vi.spyOn(vscodeWindow, "registerWebviewViewProvider");
    const agentsWhyPeek = vi.fn(async () => ({
      subject: null,
      author: "Ada",
      authorEmail: null,
      commitSha: null,
      committedAt: null,
      commitSubject: null,
      pr: null,
      ticket: null,
      hasMore: false,
    }));
    const searchRanked = vi.fn(async () => [
      { name: "neighbour.ts", service: "github", indexPrimaryKey: "gh:1", score: 1 },
    ]);
    const posted: Array<{ type?: string; section?: { id?: string } }> = [];
    let receive: (raw: unknown) => void = () => undefined;
    const view = {
      visible: true,
      webview: {
        options: undefined as unknown,
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u: unknown) => ({ toString: () => `https://webview/${String(u)}` }),
        onDidReceiveMessage: (h: (raw: unknown) => void) => {
          receive = h;
          return { dispose: () => undefined };
        },
        postMessage: async (m: unknown) => {
          posted.push(m as { type?: string; section?: { id?: string } });
          return true;
        },
      },
      onDidChangeVisibility: () => ({ dispose: () => undefined }),
      onDidDispose: () => ({ dispose: () => undefined }),
    };
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: "/home/dev/proj" } }];
    stubWindow.activeTextEditor = {
      document: {
        fileName: "/home/dev/proj/src/a.ts",
        uri: { scheme: "file", fsPath: "/home/dev/proj/src/a.ts" },
        languageId: "typescript",
        isDirty: false,
        getText: () => "",
        lineAt: () => ({ range: { end: {} } }),
      },
      selection: { isEmpty: true, active: { line: 3 }, start: { line: 3 }, end: { line: 3 } },
    };
    try {
      const f = makeFixture({
        cfg: { "search.limit": 7 },
        openClient: makeFakeClient({ agentsWhyPeek, searchRanked } as never),
      });
      activateWithDeps(f.ctx, f.deps);
      const call = registerSpy.mock.calls.find(([viewId]) => viewId === "nimbus.contextView");
      const provider = call?.[1] as { resolveWebviewView: (v: unknown) => void } | undefined;
      if (provider === undefined) throw new Error("the context view provider was not registered");
      provider.resolveWebviewView(view);
      await waitForConnect();
      await flush();
      receive({ type: "ready" });
      await flush();
      // Line 3 in the editor is line 4 on the wire; the path is repo-relative.
      expect(agentsWhyPeek).toHaveBeenCalledWith({ ref: "src/a.ts", line: 4 });
      expect(searchRanked).toHaveBeenCalledWith({ name: "src/a.ts", limit: 7 });
      const sections = posted.filter((m) => m.type === "section").map((m) => m.section?.id);
      expect(sections).toEqual(expect.arrayContaining(["blame", "related"]));
      teardown(f);
    } finally {
      stubWindow.activeTextEditor = undefined;
      stubWorkspace.workspaceFolders = undefined;
      registerSpy.mockRestore();
    }
  });
});

// A registered command handler, captured BEFORE teardown() unregisters it — so
// a test can invoke it in the state teardown leaves behind (client gone, the
// manager still reporting its last state), the way an in-flight UI event would.
function deferredCommand(f: Captured, id: string): (...args: unknown[]) => unknown {
  const h = f.commandHandlers.get(id);
  if (h !== undefined) return h;
  throw new Error(`command ${id} was not registered before teardown`);
}

describe("a chat panel that outlives its Gateway", () => {
  test("resuming a session after a reconnect failed says so, and never reaches the stale client", async () => {
    // The controller is cached for the life of the panel, so it must resolve
    // the client per call. Here the live client is gone; a call through a
    // captured one would hit a closed pipe.
    const getSessionTranscript = vi.fn(async () => ({
      sessionId: "s-9",
      turns: [],
      hasMore: false,
    }));
    const f = makeFixture({
      openClient: connectsOnce(makeFakeClient({ getSessionTranscript } as never)),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.newConversation")();
    await cmd(f, "nimbus.reconnect")();
    await cmd(f, "nimbus.openSession")("s-9");
    expect(getSessionTranscript).not.toHaveBeenCalled();
    expect(f.postedToWebview.at(-1)).toEqual({ type: "emptyState", sub: "no-transcript" });
    expect(
      f.outputAppendLines.some((l) =>
        l.includes(
          'getSessionTranscript failed: Nimbus is not connected to the Gateway. Run "Nimbus: Reconnect to Gateway".',
        ),
      ),
    ).toBe(true);
    teardown(f);
  });
});

describe("brief command wiring", () => {
  test("a brief while disconnected reports it and sends nothing", async () => {
    const f = makeFixture({ openClient: disconnectedClient() });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.brief.huddle")();
    expect(f.errorMessages).toEqual(["Nimbus: not connected to the Gateway."]);
    expect(f.openedDocs).toEqual([]);
    expect(f.warnMessages).toEqual([]); // no pre-flight modal for a send that cannot happen
    teardown(f);
  });

  const whyFor = (p: { ref: string; line?: number }) => ({
    ...BRIEF_BASE,
    kind: "why",
    query: { ref: p.ref, line: p.line ?? null },
    subject: null,
    findings: [],
  });

  test("Why? on a real file asks about the cursor line, repo-relative and one-based", async () => {
    const agentsWhy = vi.fn(async (p: { ref: string; line?: number }) => whyFor(p));
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      activeEditor: { text: "x", fileName: "/home/dev/proj/src/a.ts", line: 9 },
      openClient: makeFakeClient({ agentsWhy } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.brief.why")();
    expect(agentsWhy).toHaveBeenCalledWith({ ref: "src/a.ts", line: 10 });
    expect(f.openedDocs).toEqual([
      { title: "Nimbus — Why is this here?.md", content: "No history found for `src/a.ts:10`." },
    ]);
  });

  test("a hover link's target wins over the editor; a malformed one falls back to it", async () => {
    const agentsWhy = vi.fn(async (p: { ref: string; line?: number }) => whyFor(p));
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      activeEditor: { text: "x", fileName: "/home/dev/proj/src/a.ts", line: 9 },
      openClient: makeFakeClient({ agentsWhy } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.brief.why")({ ref: "src/b.ts", line: 3 });
    await cmd(f, "nimbus.brief.why")({ ref: "src/b.ts" }); // no line: not a target
    await cmd(f, "nimbus.brief.why")("src/b.ts:3"); // not an object at all
    expect(agentsWhy.mock.calls.map((c) => c[0])).toEqual([
      { ref: "src/b.ts", line: 4 },
      { ref: "src/a.ts", line: 10 },
      { ref: "src/a.ts", line: 10 },
    ]);
  });

  test("conflicts renders each collision's age against the real clock", async () => {
    const agentsConflicts = vi.fn(async (p: { file: string }) => ({
      ...BRIEF_BASE,
      kind: "conflict",
      query: { file: p.file },
      startEntityId: null,
      collisions: [
        {
          peerId: "p1",
          who: "Sam",
          service: "github",
          collisionType: "open_pr",
          title: "Rework session refresh",
          snippet: "",
          modifiedAt: Date.now() - 2 * 3_600_000,
        },
      ],
    }));
    const f = makeFixture({
      workspaceFolders: [{ uri: { fsPath: "/home/dev/proj" } }],
      activeEditor: { text: "x", fileName: "/home/dev/proj/src/a.ts" },
      openClient: makeFakeClient({ agentsConflicts } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.brief.conflicts")();
    expect(f.openedDocs[0]?.content).toContain("**Sam** — open pr in github, 2h ago");
  });

  test("pre-flight prefills the namespace from nimbus.briefs.defaultNamespace", async () => {
    const agentsPreflight = vi.fn(async (p: { ref: string; namespace: string }) => ({
      ...BRIEF_BASE,
      kind: "preflight",
      query: { ref: p.ref, namespace: p.namespace },
      downstreams: [],
      anyFailed: false,
      anyIncomplete: false,
    }));
    const f = makeFixture({
      cfg: { "briefs.defaultNamespace": "billing" },
      inputBoxAnswers: ["release-1.4", "billing"],
      openClient: makeFakeClient({ agentsPreflight } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.brief.preflight")();
    const prompts = (f.deps.window.showInputBox as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect((prompts[1]?.[0] as { value?: string } | undefined)?.value).toBe("billing");
    expect(agentsPreflight).toHaveBeenCalledWith({ ref: "release-1.4", namespace: "billing" });
  });
});

describe("SCM command wiring", () => {
  function fakeGitRepo(diffs: Record<string, string>): GitRepositoryLike {
    const paths = Object.keys(diffs);
    return {
      rootPath: "/home/dev/proj",
      changedFiles: async () => paths.map((path) => ({ path, status: "5" })),
      changedPathsNow: () => paths,
      stagedPathsNow: () => [],
      fileDiff: async (_scope, path) => diffs[path] ?? "",
      untrackedPaths: () => [],
      log: async () => ["feat: earlier change"],
      inputBox: { value: "" },
      branch: () => "main",
      onDidChange: () => ({ dispose: () => undefined }),
    };
  }
  const gitWith =
    (repo: GitRepositoryLike): (() => Promise<GitApiLike>) =>
    async () => ({
      repositories: () => [repo],
      onDidOpenRepository: () => ({ dispose: () => undefined }),
    });

  test("the commit message honours both SCM settings: secret files and the signed trailer", async () => {
    const repo = fakeGitRepo({
      "src/a.ts": "@@ -1 +1 @@\n+const a = 1;\n",
      ".env": "@@ -1 +1 @@\n+API_URL=https://staging.example\n",
    });
    const prompts: string[] = [];
    const egressProveWindow = vi.fn(async () => ({
      receipt: { digest: "d1", sigB64: "s1", pubkeyB64: "p1" },
    }));
    const f = makeFixture({
      cfg: { "scm.egressProofTrailer": true, "scm.skipSecretFiles": false },
      openClient: makeFakeClient({
        agentInvoke: async (input: string) => {
          prompts.push(input);
          return { reply: "feat: add a" };
        },
        egressProveWindow,
      } as never),
    });
    f.deps.git = gitWith(repo);
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.generateCommitMessage")();
    // skipSecretFiles=false: the .env diff was sent, not skipped.
    expect(prompts[0]).toContain("API_URL=https://staging.example");
    expect(egressProveWindow).toHaveBeenCalledWith({ since: expect.any(Number), sign: true });
    expect(repo.inputBox.value).toBe("feat: add a\n\nNimbus-Egress-Proof: d1 sig=s1 pubkey=p1");
  });

  test("the commit message while disconnected reports it before reading any diff", async () => {
    const repo = fakeGitRepo({ "src/a.ts": "@@ -1 +1 @@\n+a\n" });
    const changedFiles = vi.spyOn(repo, "changedFiles");
    const f = makeFixture({ openClient: disconnectedClient() });
    f.deps.git = gitWith(repo);
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.generateCommitMessage")();
    expect(f.errorMessages).toEqual(["Nimbus: not connected to Gateway."]);
    expect(changedFiles).not.toHaveBeenCalled();
    teardown(f);
  });

  test("docstrings splice a selection rewrite at the offsets the real editor reports", async () => {
    const diffs: Array<{ left: string; right: string }> = [];
    const f = makeFixture({
      activeEditor: {
        text: "AAA\nBBB\nCCC\n",
        selectionText: "BBB",
        empty: false,
        fileName: "a.ts",
      },
      openClient: makeFakeClient({
        agentInvoke: async () => ({ reply: "```ts\n// doc\nBBB\n```" }),
      } as never),
    });
    f.deps.openDiff = async (o) => {
      diffs.push({ left: o.left, right: o.right });
    };
    // No injected selectionOffsets: activate() falls back to the real editor's
    // Position → offset mapping, which the stub editor stands in for.
    stubWindow.activeTextEditor = {
      selection: {
        isEmpty: false,
        start: { line: 1, character: 0 },
        end: { line: 1, character: 3 },
      },
      document: { offsetAt: (p: { line: number; character: number }) => p.line * 4 + p.character },
    } as unknown as typeof stubWindow.activeTextEditor;
    try {
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      await cmd(f, "nimbus.generateDocstrings")();
    } finally {
      stubWindow.activeTextEditor = undefined;
    }
    expect(diffs).toEqual([{ left: "AAA\nBBB\nCCC\n", right: "AAA\n// doc\nBBB\nCCC\n" }]);
  });

  test("docstrings with no real editor to measure fall back to a read-only tab", async () => {
    const diffs: unknown[] = [];
    const f = makeFixture({
      activeEditor: { text: "AAA\nBBB\n", selectionText: "BBB", empty: false, fileName: "a.ts" },
      openClient: makeFakeClient({
        agentInvoke: async () => ({ reply: "```ts\n// doc\nBBB\n```" }),
      } as never),
    });
    f.deps.openDiff = async (o) => {
      diffs.push(o);
    };
    activateWithDeps(f.ctx, f.deps); // the stub's own activeTextEditor stays undefined
    await waitForConnect();
    await cmd(f, "nimbus.generateDocstrings")();
    expect(diffs).toEqual([]);
    expect(f.openedDocs).toEqual([{ title: "Nimbus docstrings.md", content: "// doc\nBBB" }]);
  });
});

describe("connector command wiring", () => {
  const ROW = {
    label: "github",
    contextValue: "nimbus.connector.active",
    payload: { serviceId: "github", itemCount: 3 },
  };

  test("a connector command acts on its row and refreshes the Connectors view", async () => {
    const connectorPause = vi.fn(async () => ({ ok: true }));
    const f = makeFixture({
      openClient: makeFakeClient({ connectorPause } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    const changed = onViewChange(f, "nimbus.connectorsView");
    await cmd(f, "nimbus.pauseConnector")(ROW);
    await flush();
    expect(connectorPause).toHaveBeenCalledWith({ serviceId: "github" });
    expect(f.infoMessages).toContain("Pausing github: done");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test("Refresh Connectors repaints the view without calling the Gateway", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    const changed = onViewChange(f, "nimbus.connectorsView");
    cmd(f, "nimbus.refreshConnectors")();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test("a pushed connector-config change refreshes the view once, debounced", async () => {
    let pushChange = (): void => undefined;
    const f = makeFixture({
      openClient: makeFakeClient({
        subscribeConnectorConfigChanged: (cb: () => void) => {
          pushChange = cb;
          return { dispose: () => undefined };
        },
      } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    const changed = onViewChange(f, "nimbus.connectorsView");
    vi.useFakeTimers();
    try {
      pushChange();
      pushChange(); // a burst collapses into one refresh
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("participant and LM-tool clients", () => {
  test("the participant gets no client while disconnected, and a forwarded retrieval search once connected", async () => {
    let offline: ParticipantDeps | undefined;
    const down = makeFixture({ openClient: disconnectedClient() });
    down.deps.registerChatParticipant = ({ deps }) => {
      offline = deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(down.ctx, down.deps);
    await waitForConnect();
    expect(offline?.client()).toBeUndefined();
    teardown(down);

    const retrieval = {
      items: [],
      retrieval: { vectorRanked: true, reason: null, partial: null, backfill: null },
      notes: [],
    };
    const searchRankedWithRetrieval = vi.fn(async () => retrieval);
    let online: ParticipantDeps | undefined;
    const up = makeFixture({
      openClient: makeFakeClient({ searchRankedWithRetrieval } as never),
    });
    up.deps.registerChatParticipant = ({ deps }) => {
      online = deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(up.ctx, up.deps);
    await waitForConnect();
    await expect(
      online?.client()?.searchRankedWithRetrieval({ name: "q", limit: 5 }),
    ).resolves.toBe(retrieval);
    expect(searchRankedWithRetrieval).toHaveBeenCalledWith({ name: "q", limit: 5 });
  });

  test("the LM tools get no client while disconnected, and a forwarded search once connected", async () => {
    let offline: LmToolsDeps | undefined;
    const down = makeFixture({ openClient: disconnectedClient() });
    down.deps.registerLmTools = ({ deps }) => {
      offline = deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(down.ctx, down.deps);
    await waitForConnect();
    expect(offline?.client()).toBeUndefined();
    teardown(down);

    const searchRanked = vi.fn(async () => [{ name: "a.ts" }]);
    let online: LmToolsDeps | undefined;
    const up = makeFixture({ openClient: makeFakeClient({ searchRanked } as never) });
    up.deps.registerLmTools = ({ deps }) => {
      online = deps;
      return { dispose: () => undefined };
    };
    activateWithDeps(up.ctx, up.deps);
    await waitForConnect();
    await expect(online?.client()?.searchRanked({ name: "a" })).resolves.toEqual([
      { name: "a.ts" },
    ]);
    expect(searchRanked).toHaveBeenCalledWith({ name: "a" });
  });
});

describe("search picker lifecycle", () => {
  test("a search that fails after the picker closed reports nothing", async () => {
    let fail = (_e: Error): void => undefined;
    const searchRanked = vi.fn(
      () =>
        new Promise<never>((_r, reject) => {
          fail = reject;
        }),
    );
    const f = makeFixture({
      openClient: makeFakeClient({ searchRanked } as never),
      searchDebounceMs: 0,
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0];
    if (qp === undefined) throw new Error("no quick pick opened");
    qp.setValueAndFire("auth");
    await flush();
    expect(searchRanked).toHaveBeenCalledTimes(1);
    qp.hide();
    fail(new Error("index went away"));
    await flush();
    expect(f.errorMessages).toEqual([]);
    expect(f.outputAppendLines.some((l) => l.includes("nimbus.search failed"))).toBe(false);
  });

  test("closing the picker before typing anything disposes it and searches nothing", async () => {
    const searchRanked = vi.fn(async () => []);
    const f = makeFixture({ openClient: makeFakeClient({ searchRanked } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    cmd(f, "nimbus.search")();
    const qp = f.quickPicks[0];
    qp?.hide();
    expect(qp?.disposed).toBe(true);
    await flush();
    expect(searchRanked).not.toHaveBeenCalled();
  });
});

describe("quick ask — the question box", () => {
  test.each([
    ["dismissed", undefined],
    ["answered with only whitespace", "   "],
  ])("a question box %s sends nothing and says nothing", async (_label, answer) => {
    const agentInvoke = vi.fn(async () => ({ reply: "x" }));
    const f = makeFixture({
      activeEditor: { text: "const a = 1;", empty: true, fileName: "a.ts" },
      quickPickAnswers: [{ label: "Custom question…" }],
      inputBoxAnswers: [answer],
      openClient: makeFakeClient({ agentInvoke } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.quickAsk")();
    expect(f.deps.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(agentInvoke).not.toHaveBeenCalled();
    expect(f.errorMessages).toEqual([]);
    expect(f.openedDocs).toEqual([]);
  });
});

describe("gateway lifecycle and settings wiring", () => {
  test("Start Gateway before the first connection attempt starts it with no socket yet", async () => {
    const spawn = vi.fn(async (): Promise<AutoStartResult> => ({ kind: "ok" }));
    const f = makeFixture({ autoStarter: { spawn } });
    activateWithDeps(f.ctx, f.deps);
    // Not awaited: the connection manager is still idle — discovery has not
    // answered yet — so there is no socket path to pass along.
    await cmd(f, "nimbus.startGateway")();
    expect(spawn).toHaveBeenCalledWith("");
  });

  test("the troubleshooter reports a connected socket whose Gateway does not answer ping", async () => {
    const f = makeFixture({
      warnMessageClicks: [undefined],
      openClient: makeFakeClient({
        gatewayPing: async () => {
          throw new Error("ping timed out");
        },
      } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.troubleshootConnection")();
    expect(f.warnMessages).toEqual([
      `Socket ${TEST_SOCKET_PATH} is connected, but the Gateway is not responding to ping: ping timed out.`,
    ]);
    expect(f.deps.window.showErrorMessage).not.toHaveBeenCalled();
  });

  test("the Workflows view loads through the live client, and Refresh Workflows repaints it", async () => {
    const workflowList = vi.fn(async () => ({ workflows: [] }));
    const f = makeFixture({ openClient: makeFakeClient({ workflowList } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    const rows = (await f.treeProviders.get("nimbus.workflowsView")?.getChildren()) as Array<{
      label: string;
    }>;
    expect(workflowList).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.label)).toEqual(["No saved workflows"]);
    const changed = onViewChange(f, "nimbus.workflowsView");
    cmd(f, "nimbus.refreshWorkflows")();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test("a settings change outside nimbus.* does not re-poll; nimbus.agents repaints the Agents view", async () => {
    const egressHead = vi.fn(async () => ({ head: "h", count: 1 }));
    const f = makeFixture({ openClient: makeFakeClient({ egressHead } as never) });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await flush();
    const agentsChanged = onViewChange(f, "nimbus.agentsView");
    egressHead.mockClear();
    for (const h of f.configChangeHandlers)
      h({ affectsConfiguration: (s) => s === "editor.fontSize" });
    await flush();
    expect(egressHead).not.toHaveBeenCalled();
    expect(agentsChanged).not.toHaveBeenCalled();
    for (const h of f.configChangeHandlers) {
      h({ affectsConfiguration: (s) => s === "nimbus" || s === "nimbus.agents" });
    }
    await flush();
    expect(agentsChanged).toHaveBeenCalledTimes(1);
    expect(egressHead).toHaveBeenCalledTimes(1);
  });

  test("changing nimbus.statusBarPollMs re-arms the poll at the new period", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      f.cfgValues["statusBarPollMs"] = 5_000;
      for (const h of f.configChangeHandlers) {
        h({ affectsConfiguration: (s) => s === "nimbus" || s === "nimbus.statusBarPollMs" });
      }
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(5_000);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      teardown(f);
    }
  });

  test("a broken egress chain with no row or reason still says it broke, without inventing either", async () => {
    const f = makeFixture({
      openClient: makeFakeClient({ egressVerify: async () => ({ ok: false }) } as never),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    await cmd(f, "nimbus.verifyEgress")();
    expect(f.errorMessages).toEqual(["Egress chain broke at row ?."]);
  });
});

describe("views racing deactivation", () => {
  // teardown() closes the client but leaves the manager's last state —
  // "connected" — in place: the window a load can still land in.
  test("the Sessions and Index views load nothing once the client is gone, rather than throwing", async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const queryItems = vi.fn(async () => ({ items: [] }));
    const f = makeFixture({
      openClient: makeFakeClient({ sessionList, queryItems } as unknown as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const sessions = f.treeProviders.get("nimbus.sessionsView");
    const index = f.treeProviders.get("nimbus.indexView");
    teardown(f);
    const sessionRows = (await sessions?.getChildren()) as Array<{ label: string }>;
    const indexRows = (await index?.getChildren()) as Array<{ label: string }>;
    expect(sessionRows.map((r) => r.label)).toEqual(["No saved sessions yet"]);
    expect(indexRows.map((r) => r.label)).toEqual(["No indexed items yet"]);
    expect(sessionList).not.toHaveBeenCalled();
    expect(queryItems).not.toHaveBeenCalled();
  });
});

describe("openers: edges of the virtual documents", () => {
  test("the read-only opener resolves an unknown or malformed URI to an empty document", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    try {
      const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
      await createReadonlyJsonOpener(ctx)("a.md", "AAA");
      const provider = spy.mock.calls[0]?.[1] as {
        provideTextDocumentContent(uri: { path: string }): string;
      };
      expect(provider.provideTextDocumentContent({ path: "/1/a.md" })).toBe("AAA");
      expect(provider.provideTextDocumentContent({ path: "/99/a.md" })).toBe("");
      expect(provider.provideTextDocumentContent({ path: "" })).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  test("the diff opener keeps the newest ten diffs and forgets older ones", async () => {
    const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
    try {
      const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
      const openDiff = createDiffOpener(ctx);
      for (let i = 1; i <= 11; i += 1) {
        await openDiff({ title: "T", left: `L${i}`, right: `R${i}`, fileName: "a.ts" });
      }
      const provider = spy.mock.calls[0]?.[1] as {
        provideTextDocumentContent(uri: { path: string }): string;
      };
      // 20 documents fit — two per diff — so the first diff is the one evicted.
      expect(provider.provideTextDocumentContent({ path: "/1/original/a.ts" })).toBe("");
      expect(provider.provideTextDocumentContent({ path: "/1/nimbus/a.ts" })).toBe("");
      expect(provider.provideTextDocumentContent({ path: "/2/original/a.ts" })).toBe("L2");
      expect(provider.provideTextDocumentContent({ path: "/11/nimbus/a.ts" })).toBe("R11");
    } finally {
      spy.mockRestore();
    }
  });

  test("the proof saver suggests the workspace folder, and saves nothing when cancelled", async () => {
    const dialog = vi.spyOn(stubWindow, "showSaveDialog").mockResolvedValue(undefined as never);
    const writeFile = vi.spyOn(stubWorkspace.fs, "writeFile");
    stubWorkspace.workspaceFolders = [{ uri: Uri.file("/home/dev/proj") as never }];
    try {
      const f = makeFixture({
        realProofSave: true,
        quickPickAnswers: [{ label: "Last 7 days" }],
        openClient: makeFakeClient({
          egressProveWindow: async () => ({ rows: [], verify: { ok: true } }),
        } as never),
      });
      activateWithDeps(f.ctx, f.deps);
      await waitForConnect();
      await cmd(f, "nimbus.proveEgressWindow")();
      const options = dialog.mock.calls[0]?.[0] as {
        filters: Record<string, string[]>;
        defaultUri?: { toString(): string };
      };
      expect(options.filters).toEqual({ HTML: ["html"], JSON: ["json"] });
      expect(options.defaultUri?.toString()).toMatch(/^\/home\/dev\/proj\/egress-proof-\d+\.html$/);
      expect(writeFile).not.toHaveBeenCalled();
      expect(f.infoMessages.some((m) => /proof saved/i.test(m))).toBe(false);
    } finally {
      dialog.mockRestore();
      writeFile.mockRestore();
      stubWorkspace.workspaceFolders = undefined;
    }
  });
});
