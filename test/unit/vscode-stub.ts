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
  withProgress: async (_opts: unknown, task: () => Promise<unknown>) => task(),
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
  isTrusted: true,
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
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
  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

export const languages = {
  registerHoverProvider: (_selector: unknown, _provider: unknown) => ({
    dispose: () => undefined,
  }),
  registerCodeActionsProvider: (_selector: unknown, _provider: unknown, _metadata?: unknown) => ({
    dispose: () => undefined,
  }),
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
export enum ViewColumn {
  Beside = -2,
  Active = -1,
  One = 1,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
