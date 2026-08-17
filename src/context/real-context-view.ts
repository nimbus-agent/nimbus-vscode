import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import { toRelativeRef } from "../briefs/params.js";
import { errMsg, type Logger } from "../logging.js";
import type { GitApiLike, GitRepositoryLike } from "../scm/git-types.js";
import { repoContaining } from "../scm/repo-select.js";
import type { SidebarConnection } from "../sidebar/tree-view.js";
import { createController } from "./controller.js";
import { createDebouncer, DEBOUNCE_MS } from "./debounce.js";
import { validateInbound } from "./protocol.js";
import { type ContextClientLike, SIGNAL_CATALOG } from "./signals.js";
import {
  buildSnapshot,
  type DiagnosticSummary,
  type GitSummary,
  SELECTION_MAX_CHARS,
} from "./snapshot.js";

// Thin vscode-API glue — mirrors real-provider.ts and real-chat-panel.ts. Every
// decision (what the context is, which briefs fit, what may be executed, what
// to cache) lives in the pure modules beside this file, which carry the tests.
//
// PR 1 re-collected on every event, with no cache. PR 2 hands collection to
// controller.ts, which owns the cache, in-flight coalescing, the generation
// fence and invalidation — this file's job is now just: build a snapshot, and
// wire the events that should invalidate or re-collect.

const VIEW_ID = "nimbus.contextView";

export function registerContextView(deps: {
  log: Logger;
  // Async and possibly absent: this is the same accessor the SCM trio takes —
  // the built-in git extension may not have activated yet.
  git: () => Promise<GitApiLike | undefined>;
  /** Undefined while disconnected — Gateway-backed signals then sit out. */
  client: () => ContextClientLike | undefined;
  connection: SidebarConnection;
  searchLimit: () => number;
  contextEnabled: () => boolean;
}): vscode.Disposable {
  let view: vscode.WebviewView | undefined;

  const controller = createController({
    signals: SIGNAL_CATALOG,
    signalDeps: {
      client: deps.client,
      now: () => Date.now(),
      searchLimit: deps.searchLimit,
    },
    connection: deps.connection,
    post: (message) => {
      if (view === undefined) return;
      void view.webview.postMessage(message);
    },
    isVisible: () => view?.visible === true,
    log: deps.log,
  });

  // Takes the repo directly rather than looking it up itself, so collect()
  // can resolve it once via repoContaining and reuse it for repoPath too —
  // one git lookup per collection, not two.
  const gitSummaryFor = (repo: GitRepositoryLike | undefined): GitSummary | undefined => {
    if (repo === undefined) return undefined;
    try {
      // changedPathsNow, NOT changedFiles("all"): this runs on every debounce
      // tick while the user works, and changedFiles shells out to `git diff`.
      // The git extension has already materialised its working-tree state, so
      // this is a read of data in hand — the same state untrackedPaths reads.
      //
      // Working tree UNION index. changedPathsNow is unstaged-only and, under
      // the default git.untrackedChanges: "mixed", includes untracked files;
      // stagedPathsNow is index-vs-HEAD. Either alone makes the count fall as
      // the user stages, which is the opposite of what "changed files" means.
      const changedPaths = [...new Set([...repo.changedPathsNow(), ...repo.stagedPathsNow()])];
      return { branch: repo.branch(), changedPaths };
    } catch (e: unknown) {
      // A failed read must not cost the branch row, which is already in hand.
      deps.log.warn(`context panel could not read changed files: ${errMsg(e)}`);
      return { branch: repo.branch(), changedPaths: undefined };
    }
  };

  // Bound the READ, not just the stored value. Ctrl+A on a large file makes
  // getText(selection) copy the whole document before buildSnapshot clamps it to
  // 300 chars. Five lines is far more than the clamp can consume, and the slice
  // covers the one-enormous-line case (a minified bundle).
  const SELECTION_READ_LINES = 5;
  const selectionText = (editor: vscode.TextEditor): string => {
    const sel = editor.selection;
    if (sel.isEmpty) return "";
    const lastLine = Math.min(sel.end.line, sel.start.line + SELECTION_READ_LINES);
    const end = lastLine === sel.end.line ? sel.end : editor.document.lineAt(lastLine).range.end;
    return editor.document
      .getText(new vscode.Range(sel.start, end))
      .slice(0, SELECTION_MAX_CHARS * 2);
  };

  const diagnosticsFor = (uri: vscode.Uri): DiagnosticSummary[] =>
    vscode.languages.getDiagnostics(uri).map((d) => ({
      message: d.message,
      severity: d.severity,
      line: d.range.start.line,
    }));

  // A LOCAL ordering token — distinct from the controller's own generation
  // counter, which stamps a snapshot only once it reaches controller.collect()
  // (i.e. AFTER this function's own await). Without this, two collect() calls
  // whose deps.git() lookups resolve out of order can have the
  // later-started (staler) call reach the controller second and take the
  // HIGHER generation, so its render overwrites the fresher one and every
  // later section reply fences against a stale answer. This restores true
  // call order before a snapshot ever reaches the controller.
  let collectSeq = 0;

  const collect = async (): Promise<void> => {
    if (view === undefined || !view.visible) return;
    // The setting is read per collection, not captured: it can change under a
    // long-lived view, and the config listener below only exists to repaint
    // promptly, not to be the authority.
    if (!deps.contextEnabled()) {
      controller.invalidateAll();
      view.webview.postMessage({ type: "paused", reason: "disabled" }).then(undefined, () => {});
      return;
    }
    collectSeq += 1;
    const mine = collectSeq;
    const editor = vscode.window.activeTextEditor;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const repos = (await deps.git())?.repositories() ?? [];
    // fileName is the editor's absolute path — a local filesystem lookup, not
    // a payload; the repo-relative values derived from it below are what
    // reach the snapshot.
    const repo = repoContaining(repos, editor?.document.fileName);
    const git = gitSummaryFor(repo);
    if (mine !== collectSeq || view === undefined) return;
    const snapshot = buildSnapshot({
      // The controller owns the generation counter now; the snapshot carries
      // whatever it is told, and 0 here means "the controller will stamp it".
      generation: 0,
      ...(editor === undefined
        ? {}
        : {
            editor: {
              // Relative, never absolute: an absolute path names the user's home
              // directory, and this value is rendered.
              path: toRelativeRef(editor.document.fileName, roots),
              // Relative to the containing repository, not the workspace — see
              // ContextSnapshot.repoPath. Undefined when no repository
              // contains the file, matching repoContaining's own contract.
              ...(repo === undefined
                ? {}
                : { repoPath: toRelativeRef(editor.document.fileName, [repo.rootPath]) }),
              scheme: editor.document.uri.scheme,
              languageId: editor.document.languageId,
              line: editor.selection.active.line,
              selection: selectionText(editor),
              isDirty: editor.document.isDirty,
            },
          }),
      ...(git === undefined ? {} : { git }),
      ...(editor === undefined ? {} : { diagnostics: diagnosticsFor(editor.document.uri) }),
    });
    await controller.collect(snapshot);
  };

  const recollect = (): void => {
    void collect().catch((e: unknown) =>
      deps.log.warn(`context panel collect failed: ${errMsg(e)}`),
    );
  };

  // One debouncer per event source, at the spec's tiers. Becoming visible and
  // the webview's ready handshake collect immediately: both are single events
  // the user is waiting on, not bursts.
  const onSelection = createDebouncer(DEBOUNCE_MS.selection, recollect);
  const onEditor = createDebouncer(DEBOUNCE_MS.editor, recollect);
  const onDiagnostics = createDebouncer(DEBOUNCE_MS.diagnostics, recollect);
  // Git is the fourth source, at the editor tier. It is NOT a rare, deliberate
  // event: the git extension fires onDidChange after every updateModelState(),
  // which its working-tree watcher triggers while the user types.
  //
  // invalidateAll, not invalidateSignal("git"): `git`'s cacheKey is undefined,
  // so its cache is permanently empty and clearing it clears nothing. What a
  // commit or a branch switch actually invalidates is BLAME — whose key is
  // path:line, with no mention of HEAD — so without this the panel would keep
  // reporting the pre-commit author and sha for every line already visited.
  // (Carrying HEAD on GitSummary and folding it into blame's key is the
  // narrower fix; it is a seam change, deferred to PR 3.)
  const onGit = createDebouncer(DEBOUNCE_MS.editor, () => {
    controller.invalidateAll();
    recollect();
  });

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const mediaRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), "..", "media");
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      webviewView.webview.html = renderHtml(webviewView.webview, mediaRoot);
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const result = validateInbound(raw);
        if (result.kind === "rejected") {
          deps.log.warn(`context panel refused a message: ${result.reason}`);
          return;
        }
        if (result.kind === "ready") {
          recollect();
          return;
        }
        void vscode.commands
          .executeCommand(result.command, ...result.args)
          .then(undefined, (e: unknown) => {
            deps.log.error(`context panel command failed: ${errMsg(e)}`);
          });
      });
      // Collection is suspended entirely while the view is hidden; becoming
      // visible collects once for the current context.
      webviewView.onDidChangeVisibility(() => recollect());
      // Drop the reference when the view goes away: a debounced collection can
      // still fire after disposal, and collect() gates on `view` being set.
      webviewView.onDidDispose(() => {
        view = undefined;
      });
    },
  };

  // Save: the indexer may pick the file up, so `related` can legitimately
  // change. Drop that path's entries, then collect.
  const onSave = (document: vscode.TextDocument): void => {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    controller.invalidatePath(toRelativeRef(document.fileName, roots));
    recollect();
  };

  // Git state: branch switches and staging change what the git section says.
  //
  // Re-attached rather than attached once. The git extension discovers
  // repositories asynchronously, so the set can still be empty when this first
  // runs — subscribing only to what is there at activation is how this trigger
  // ends up never firing at all. Re-attaching on every open also covers a repo
  // closing: its listener is disposed with the rest.
  // Guards the two async chains below against a teardown that lands while
  // deps.git() is still pending: without it, a subscription can be created
  // AFTER dispose() has already run and never gets torn down.
  let gitWiringDisposed = false;
  const gitSubs: Array<{ dispose(): void }> = [];
  const attachGitListeners = async (): Promise<void> => {
    const api = await deps.git();
    for (const previous of gitSubs.splice(0)) previous.dispose();
    if (gitWiringDisposed) return;
    for (const repo of api?.repositories() ?? []) {
      gitSubs.push(repo.onDidChange(() => onGit.trigger()));
    }
  };

  let openSub: { dispose(): void } | undefined;
  void deps
    .git()
    .then((api) => {
      const sub = api?.onDidOpenRepository(() => {
        void attachGitListeners()
          // Same reasoning as onGit: a repository appearing can change the
          // branch, the changed-file count and every cached blame answer.
          .then(() => onGit.trigger())
          .catch((e: unknown) => deps.log.warn(`context panel git re-attach failed: ${errMsg(e)}`));
      });
      if (gitWiringDisposed) {
        sub?.dispose();
        return;
      }
      openSub = sub;
      void attachGitListeners().catch((e: unknown) =>
        deps.log.warn(`context panel git listeners failed: ${errMsg(e)}`),
      );
    })
    .catch((e: unknown) => deps.log.warn(`context panel git init failed: ${errMsg(e)}`));

  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.window.onDidChangeActiveTextEditor(() => onEditor.trigger()),
    vscode.window.onDidChangeTextEditorSelection(() => onSelection.trigger()),
    vscode.languages.onDidChangeDiagnostics(() => onDiagnostics.trigger()),
    vscode.workspace.onDidSaveTextDocument((document) => onSave(document)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("nimbus.context.enabled")) return;
      // Turning it back on must not wait for the next cursor move, and turning
      // it off must clear what is on screen now.
      recollect();
    }),
    { dispose: () => onSelection.dispose() },
    { dispose: () => onEditor.dispose() },
    { dispose: () => onDiagnostics.dispose() },
    { dispose: () => onGit.dispose() },
    { dispose: () => controller.dispose() },
    {
      dispose: () => {
        gitWiringDisposed = true;
        openSub?.dispose();
        for (const s of gitSubs.splice(0)) s.dispose();
      },
    },
  );
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "context.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "context.css"));
  const nonce = randomUUID().replaceAll("-", "");
  const csp =
    `default-src 'none'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource}; ` +
    `script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Nimbus Context</title>
<link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
<main id="root">
  <!--
    aria-live is scoped to the informational half only, as real-chat-panel.ts
    scopes it to its own sections. The offers are focusable buttons: a live
    region containing interactive controls re-announces them on every change,
    and this panel's content changes whenever the cursor moves. The two mounts
    are also repainted independently, so a new diagnostic no longer destroys
    keyboard focus on an offer button.
  -->
  <section id="signals" aria-live="polite"></section>
  <section id="offers"></section>
</main>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
