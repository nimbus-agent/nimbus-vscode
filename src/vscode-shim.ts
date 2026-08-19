type Thenable<T> = PromiseLike<T>;

// Mirrors vscode.ProgressLocation.Notification (=15); the concrete vscode enum
// is not importable from the pure shim, so the value is named here.
export const PROGRESS_LOCATION_NOTIFICATION = 15;

export interface DisposableLike {
  dispose(): void;
}

/** The slice of vscode.CancellationToken the extension uses. */
export interface CancellationTokenLike {
  onCancellationRequested(cb: () => void): DisposableLike;
}

/**
 * The slice of vscode.Progress<{ message?: string; increment?: number }> handed
 * to a withProgress task. Nothing here reports progress yet — the type exists
 * so the seam DESCRIBES the real API, whose task is called `(progress, token)`.
 * Typing the task as taking the token alone let a cast hide that the run
 * surface's "token" was really the Progress object.
 */
export interface ProgressLike {
  report(value: { message?: string; increment?: number }): void;
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
    /** Masks the input. Set for every credential field; never logged. */
    password?: boolean;
    /** Keeps a half-entered credential alive when focus wanders. */
    ignoreFocusOut?: boolean;
    validateInput?: (value: string) => string | undefined;
  }): Thenable<string | undefined>;
  showQuickPick<T extends QuickPickItemLike>(
    items: readonly T[],
    opts?: { placeHolder?: string; matchOnDescription?: boolean; matchOnDetail?: boolean },
  ): Thenable<T | undefined>;
  createQuickPick<T extends QuickPickItemLike>(): QuickPickLike<T>;
  registerTreeDataProvider<T>(viewId: string, provider: TreeDataProviderLike<T>): DisposableLike;
  activeTextEditor: TextEditorLike | undefined;
  // Mirrors the real API exactly: the task is invoked as `task(progress, token)`
  // — the reporter FIRST, vscode's CancellationToken second. Most callers ignore
  // both (their sends are not cancellable); a cancellable: true caller reads the
  // token to learn the user hit Cancel. Do not "simplify" this to the token
  // alone: activate() reaches the real window through an `unknown` cast, so this
  // declaration is the only thing that can catch a call site forwarding the
  // wrong argument, and once it did not, every workflow run died on
  // `token.onCancellationRequested is not a function`.
  withProgress<R>(
    options: { location: number; title?: string; cancellable?: boolean },
    task: (progress: ProgressLike, token: CancellationTokenLike) => Thenable<R>,
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

/**
 * The slice of vscode.TextDocument needed to re-read an OPEN document by path,
 * whether or not it has focus. `fsPath` is a local filesystem path and stays
 * inside the extension host — nothing built from it may reach a payload.
 */
export interface OpenTextDocumentLike {
  getText(range?: unknown): string;
  uri: { fsPath: string };
}

export interface WorkspaceApi {
  getConfiguration(section: string): WorkspaceConfigSection;
  onDidChangeConfiguration(handler: (e: ConfigurationChangeEventLike) => void): DisposableLike;
  /** False in Restricted Mode — the pre-flight gate is never suppressed there. */
  isTrusted: boolean;
  /** Leak-check needles. Undefined when no folder is open (a loose file). */
  workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
  /**
   * Every document VS Code currently holds open, focused or not. Focus is the
   * wrong identity for "is this still the file the request was about" — the user
   * moves around while a request is in flight — so lookups here match on path.
   */
  textDocuments: readonly OpenTextDocumentLike[];
  /**
   * Reads a file that need not be open. `textDocuments` above only covers what
   * VS Code already holds; an attachment usually names a file that is not open.
   * Real VS Code returns the live buffer when the path is already open, so this
   * alone is enough to prefer unsaved edits over the on-disk bytes.
   */
  openTextDocument(fsPath: string): Thenable<OpenTextDocumentLike>;
  /** Workspace file search for the attach picker. `max` caps the result set. */
  findFiles(
    include: string,
    exclude: string | undefined,
    max: number,
  ): Thenable<Array<{ fsPath: string }>>;
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
