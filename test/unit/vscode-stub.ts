export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => undefined,
    show: (_preserveFocus?: boolean) => undefined,
    dispose: () => undefined,
  }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  registerTreeDataProvider: (_viewId: string, _provider: unknown) => ({ dispose: () => undefined }),
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
};
export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined,
};
export const env = {
  openExternal: async () => true,
  isTelemetryEnabled: false,
};
export class ThemeColor {
  constructor(public id: string) {}
}
export const Uri = {
  parse: (s: string) => ({ toString: () => s, scheme: s.split(":")[0] ?? "" }),
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
