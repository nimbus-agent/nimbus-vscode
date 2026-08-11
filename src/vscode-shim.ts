type Thenable<T> = PromiseLike<T>;

// Mirrors vscode.ProgressLocation.Notification (=15); the concrete vscode enum
// is not importable from the pure shim, so the value is named here.
export const PROGRESS_LOCATION_NOTIFICATION = 15;

export interface DisposableLike {
  dispose(): void;
}

export interface OutputChannelHandle {
  appendLine(msg: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface StatusBarItemHandle {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: { id: string } | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface QuickPickItemLike {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickLike<T> {
  value: string;
  placeholder: string | undefined;
  items: readonly T[];
  busy: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  readonly selectedItems: readonly T[];
  onDidChangeValue(cb: (value: string) => void): DisposableLike;
  onDidAccept(cb: () => void): DisposableLike;
  onDidHide(cb: () => void): DisposableLike;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface TreeItemCommandLike {
  command: string;
  title: string;
  arguments?: unknown[];
}

export interface TreeItemLike {
  label: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  // vscode.TreeItemCollapsibleState: None=0, Collapsed=1, Expanded=2.
  collapsibleState?: number;
  command?: TreeItemCommandLike;
  // A ThemeIcon id (codicon) on the pure side; applyThemeIcons swaps it for a
  // real vscode.ThemeIcon assigned to `iconPath` before registration.
  iconId?: string;
  iconPath?: unknown;
}

export interface TreeDataProviderLike<T> {
  getTreeItem(element: T): TreeItemLike;
  getChildren(element?: T): T[] | Promise<T[]>;
  // Mirrors vscode.TreeDataProvider.onDidChangeTreeData — a vscode.Event<T | T[] |
  // undefined | null | void>. VS Code subscribes (calling with just the listener)
  // to learn when to refresh; the trailing Event args go unused here.
  onDidChangeTreeData?: (
    listener: (e: T | T[] | undefined) => void,
    thisArgs?: unknown,
    disposables?: DisposableLike[],
  ) => DisposableLike;
}

export interface TextEditorLike {
  document: {
    getText(range?: unknown): string;
    fileName: string;
    languageId: string;
    /** Scheme only. Briefs run against files in a repo; see real-hover.ts. */
    uri: { scheme: string };
  };
  // `active` is the cursor end of the selection — zero-based, straight from
  // vscode.Selection. agentsWhy({ref, line}) needs it; nothing else does yet.
  selection: { isEmpty: boolean; active: { line: number } };
}

export interface MessageOptionsLike {
  modal?: boolean;
  /** Secondary text under the main message. Modal dialogs only; plain text. */
  detail?: string;
}

export interface WindowApi {
  createOutputChannel(name: string): OutputChannelHandle;
  createStatusBarItem(alignment: 1 | 2, priority: number): StatusBarItemHandle;
  showInformationMessage(
    msg: string,
    opts: MessageOptionsLike,
    ...items: string[]
  ): Thenable<string | undefined>;
  showErrorMessage(
    msg: string,
    opts?: MessageOptionsLike,
    ...items: string[]
  ): Thenable<string | undefined>;
  showWarningMessage(
    msg: string,
    opts?: MessageOptionsLike,
    ...items: string[]
  ): Thenable<string | undefined>;
  showInputBox(opts?: {
    prompt?: string;
    value?: string;
    placeHolder?: string;
    validateInput?: (value: string) => string | undefined;
  }): Thenable<string | undefined>;
  showQuickPick<T extends QuickPickItemLike>(
    items: readonly T[],
    opts?: { placeHolder?: string; matchOnDescription?: boolean; matchOnDetail?: boolean },
  ): Thenable<T | undefined>;
  createQuickPick<T extends QuickPickItemLike>(): QuickPickLike<T>;
  registerTreeDataProvider<T>(viewId: string, provider: TreeDataProviderLike<T>): DisposableLike;
  activeTextEditor: TextEditorLike | undefined;
  withProgress<R>(
    options: { location: number; title?: string; cancellable?: boolean },
    task: () => Thenable<R>,
  ): Thenable<R>;
}

export interface WorkspaceConfigSection {
  get<T>(key: string, defaultValue: T): T;
}

export interface ConfigurationChangeEventLike {
  affectsConfiguration(section: string): boolean;
}

export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface WorkspaceApi {
  getConfiguration(section: string): WorkspaceConfigSection;
  onDidChangeConfiguration(handler: (e: ConfigurationChangeEventLike) => void): DisposableLike;
  /** False in Restricted Mode — the pre-flight gate is never suppressed there. */
  isTrusted: boolean;
  /** Leak-check needles. Undefined when no folder is open (a loose file). */
  workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
}

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface CommandsApi {
  executeCommand<T>(command: string, ...args: unknown[]): Thenable<T | undefined>;
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): DisposableLike;
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[];
  workspaceState: MementoLike;
}
