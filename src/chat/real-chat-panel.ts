import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import type { Logger } from "../logging.js";
import type { ChatPanel, ChatPanelFactory, WebviewPanelLike } from "./chat-panel.js";

// The production ChatPanel/ChatPanelFactory backed by a real VS Code webview
// panel. This is thin vscode-API glue — the extension injects a fake factory in
// tests (see ActivateDeps.chatPanelFactory), so this file is exercised only by
// a smoke test and is excluded from coverage alongside vscode-shim.ts.

export function createRealChatPanelFactory(log: Logger): ChatPanelFactory {
  let current: ChatPanel | undefined;
  const mediaRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), "..", "media");

  return {
    createOrReveal(): ChatPanel {
      if (current !== undefined) {
        current.reveal();
        return current;
      }
      const panel = vscode.window.createWebviewPanel(
        "nimbus.chat",
        "Nimbus",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [mediaRoot],
        },
      );
      panel.webview.html = renderChatHtml(panel.webview, mediaRoot);
      const wrapper = wrapWebviewPanel(panel, log, () => {
        current = undefined;
      });
      current = wrapper;
      return wrapper;
    },
    current(): ChatPanel | undefined {
      return current;
    },
  };
}

function wrapWebviewPanel(
  panel: vscode.WebviewPanel,
  log: Logger,
  onDisposed: () => void,
): ChatPanel {
  const disposeListeners: Array<() => void> = [];
  panel.onDidDispose(() => {
    onDisposed();
    for (const l of disposeListeners) {
      try {
        l();
      } catch (e) {
        log.warn(
          `chatPanel onDispose handler threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  });
  const webviewLike = {
    cspSource: panel.webview.cspSource,
    asWebviewUri: (p: string) => panel.webview.asWebviewUri(vscode.Uri.parse(p)).toString(),
    get html(): string {
      return panel.webview.html;
    },
    set html(v: string) {
      panel.webview.html = v;
    },
    postMessage: (m: unknown) => panel.webview.postMessage(m),
    onDidReceiveMessage: (h: (msg: unknown) => void) => panel.webview.onDidReceiveMessage(h),
  };
  const panelLike: WebviewPanelLike = {
    get visible(): boolean {
      return panel.visible;
    },
    get active(): boolean {
      return panel.active;
    },
    webview: webviewLike,
    reveal: () => panel.reveal(),
    dispose: () => panel.dispose(),
    onDidDispose: (h) => panel.onDidDispose(h),
    onDidChangeViewState: (h) => panel.onDidChangeViewState(h),
  };
  return {
    reveal: () => panel.reveal(),
    dispose: () => panel.dispose(),
    panel: () => panelLike,
    onDispose: (h) => disposeListeners.push(h),
    onMessage: (h) => panel.webview.onDidReceiveMessage(h),
    postMessage: (m) => panel.webview.postMessage(m),
    isVisible: () => panel.visible,
    isActive: () => panel.active,
  };
}

function renderChatHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview.css"));
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
<title>Nimbus</title>
<link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
<main id="root">
  <section id="empty-mount" aria-live="polite"></section>
  <section id="transcript" aria-live="polite" aria-relevant="additions"></section>
  <section id="hitl-mount" aria-live="assertive"></section>
  <footer id="footer">
    <div id="status-row">
      <ul id="subtask-list"></ul>
      <span id="status"></span>
    </div>
    <form id="input-form">
      <textarea id="input-text" rows="2" placeholder="Ask Nimbus… (Cmd/Ctrl+Enter to send)"></textarea>
      <button type="submit" id="input-send">Send</button>
      <button type="button" id="input-stop" disabled>Stop</button>
    </form>
  </footer>
</main>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
