export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => undefined,
    show: (_preserveFocus?: boolean) => undefined,
    dispose: () => undefined,
  }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  // Real VS Code invokes the task as `task(progress, token)` — progress FIRST.
  // A stub that called `task()` (or `task(token)`) could not expose an
  // argument-order bug even in principle, and one shipped: the workflow run
  // surface read `token.onCancellationRequested` off the Progress object.
  withProgress: async (
    _opts: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>,
  ) =>
    task(
      { report: (_value: { message?: string; increment?: number }) => undefined },
      // A token that never fires: nothing in these tests cancels a send.
      { onCancellationRequested: () => ({ dispose: () => undefined }) },
    ),
  createQuickPick: () => {
    const sub = () => ({ dispose: () => undefined });
    return {
      value: "",
      placeholder: undefined,
      items: [],
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      selectedItems: [],
      onDidChangeValue: sub,
      onDidAccept: sub,
      onDidHide: sub,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
    };
  },
  registerTreeDataProvider: (_viewId: string, _provider: unknown) => ({ dispose: () => undefined }),
  registerWebviewViewProvider: (_viewId: string, _provider: unknown) => ({
    dispose: () => undefined,
  }),
  // Assignable, so a test can seed it before driving a path that reads it —
  // mirrors workspace.workspaceFolders below. No test in this suite exercises
  // the context panel's live-editor path, so this stays undefined.
  activeTextEditor: undefined as
    | {
        document: {
          fileName: string;
          uri: { scheme: string; fsPath: string };
          languageId: string;
          isDirty: boolean;
          getText: (range?: unknown) => string;
          lineAt: (line: number) => { range: { end: unknown } };
        };
        selection: { isEmpty: boolean; active: unknown; start: unknown; end: unknown };
      }
    | undefined,
  onDidChangeActiveTextEditor: (_h: (e: unknown) => void) => ({ dispose: () => undefined }),
  onDidChangeTextEditorSelection: (_h: (e: unknown) => void) => ({ dispose: () => undefined }),
  showTextDocument: async (doc: unknown, _opts?: unknown) => ({
    document: doc,
    edit: async (
      callback: (editBuilder: { insert: (pos: unknown, text: string) => void }) => void,
    ) => {
      callback({ insert: () => undefined });
      return true;
    },
  }),
  showSaveDialog: async (_opts?: unknown) => ({ fsPath: "/tmp/egress-proof.json", scheme: "file" }),
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: "",
    backgroundColor: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  createWebviewPanel: (_viewType: string, _title: string, _column: number, _options?: unknown) => {
    let html = "";
    return {
      webview: {
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: unknown) => ({ toString: () => `https://webview/${String(uri)}` }),
        get html(): string {
          return html;
        },
        set html(v: string) {
          html = v;
        },
        postMessage: async (_m: unknown) => true,
        onDidReceiveMessage: (_h: (m: unknown) => void) => ({ dispose: () => undefined }),
      },
      visible: true,
      active: true,
      reveal: () => undefined,
      dispose: () => undefined,
      onDidDispose: (_h: () => void) => ({ dispose: () => undefined }),
      onDidChangeViewState: (_h: () => void) => ({ dispose: () => undefined }),
    };
  },
};
export const workspace = {
  getConfiguration: (_section: string) => ({
    get: (_key: string, dflt: unknown) => dflt,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  registerTextDocumentContentProvider: (_scheme: string, _provider: unknown) => ({
    dispose: () => undefined,
  }),
  openTextDocument: async (uri: unknown) => ({ uri }),
  onDidSaveTextDocument: (_h: (doc: unknown) => void) => ({ dispose: () => undefined }),
  isTrusted: true,
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  // Every open document, focused or not. Assignable, so a test can seed it and
  // drive a path-based document lookup.
  textDocuments: [] as Array<{ uri: { fsPath: string }; getText(): string }>,
  fs: {
    writeFile: async (_uri: unknown, _content: Uint8Array) => undefined,
  },
};
export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined,
};
export const chat = {
  createChatParticipant: (_id: string, _handler: unknown) => ({
    dispose: () => undefined,
  }),
};
export const lm = {
  registerTool: (_name: string, _tool: unknown) => ({ dispose: () => undefined }),
};
export class LanguageModelTextPart {
  constructor(public value: string) {}
}
export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
}
export const env = {
  openExternal: async () => true,
  isTelemetryEnabled: false,
};
export class ThemeColor {
  constructor(public id: string) {}
}
export class ThemeIcon {
  constructor(public id: string) {}
}

// Hover support. `isTrusted` is a plain field here, but it is load-bearing in
// the real API: without it the `command:` link in a peek hover is inert.
export class MarkdownString {
  isTrusted = false;
  constructor(public value: string = "") {}
}

export class Hover {
  constructor(public contents: unknown) {}
}

// Code-action support. `append` keeps the real API's empty-value guard, so
// `Empty.append("quickfix.nimbus.explain")` yields that string rather than a
// leading-dot variant.
export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  constructor(public readonly value: string) {}
  append(parts: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${parts}` : parts);
  }
}

export class CodeAction {
  command?: { command: string; title: string; arguments?: unknown[] };
  diagnostics?: unknown[];
  isPreferred?: boolean;
  // Declared, though real-provider.ts must never set it: a code action carrying
  // an `edit` is APPLIED the instant the user picks it. A test can only assert
  // it stayed undefined if the field exists to be read.
  edit?: unknown;
  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

export interface CodeActionsProviderLike {
  provideCodeActions(
    document: unknown,
    range: unknown,
    context: { diagnostics: readonly unknown[] },
  ): CodeAction[] | undefined;
}

export interface HoverProviderLike {
  provideHover(document: unknown, position: unknown, token: unknown): Promise<unknown>;
}

export const languages = {
  // Captured for the same reason as lastCodeActionsProvider below: what
  // real-hover.ts guarantees is that the MarkdownString it hands back carries
  // `isTrusted` — without which the hover's "Why? →" command link is inert —
  // and nothing could observe that while the provider went straight in the bin.
  lastHoverProvider: undefined as HoverProviderLike | undefined,
  lastHoverSelector: undefined as unknown,
  registerHoverProvider: (selector: unknown, provider: unknown) => {
    languages.lastHoverSelector = selector;
    languages.lastHoverProvider = provider as HoverProviderLike;
    return { dispose: () => undefined };
  },
  // Captured, not discarded, so a test can DRIVE the registered provider.
  // real-provider.ts guarantees every action carries a command and no `edit`,
  // and never sets `isPreferred` — both guarantees are the ABSENCE of an
  // assignment in glue, which nothing could observe while the provider went
  // straight in the bin. Read it as `languages.lastCodeActionsProvider`;
  // disposing does not clear it, so registration order is what decides.
  lastCodeActionsProvider: undefined as CodeActionsProviderLike | undefined,
  registerCodeActionsProvider: (_selector: unknown, provider: unknown, _metadata?: unknown) => {
    languages.lastCodeActionsProvider = provider as CodeActionsProviderLike;
    return { dispose: () => undefined };
  },
  getDiagnostics: (_uri: unknown) => [] as unknown[],
  onDidChangeDiagnostics: (_h: (e: unknown) => void) => ({ dispose: () => undefined }),
};
export const Uri = {
  // Splits the query and fragment, as the real vscode.Uri.parse does. This
  // matters: a virtual-document path carrying "?" or "#" comes back TRUNCATED,
  // and a content provider that keys its map on the untruncated path silently
  // serves "". That shipped once — the brief titles end in "?", so their
  // read-only tabs opened empty — precisely because this stub used to hand back
  // the whole string as `path` and no unit test could reproduce it.
  parse: (s: string) => {
    const scheme = s.split(":")[0] ?? "";
    const rest = s.slice(scheme.length + 1);
    const hash = rest.indexOf("#");
    const withoutFragment = hash >= 0 ? rest.slice(0, hash) : rest;
    const fragment = hash >= 0 ? rest.slice(hash + 1) : "";
    const q = withoutFragment.indexOf("?");
    const path = q >= 0 ? withoutFragment.slice(0, q) : withoutFragment;
    const query = q >= 0 ? withoutFragment.slice(q + 1) : "";
    return { toString: () => s, scheme, path, query, fragment };
  },
  file: (p: string) => ({ toString: () => p, fsPath: p, scheme: "file" }),
  joinPath: (base: { toString(): string }, ...segments: string[]) => ({
    toString: () => [base.toString(), ...segments].join("/"),
    scheme: "file",
  }),
};
// Combines several disposables into one, as the real vscode.Disposable.from
// does — used by real-context-view.ts to return a single Disposable for all
// of its event-listener registrations.
export class Disposable {
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    this.onDispose();
  }
  static from(...disposables: ReadonlyArray<{ dispose(): void }>): Disposable {
    return new Disposable(() => {
      for (const d of disposables) d.dispose();
    });
  }
}
export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}
export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}
export enum ViewColumn {
  Beside = -2,
  Active = -1,
  One = 1,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
