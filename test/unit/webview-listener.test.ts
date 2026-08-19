// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

const CHAT_SHELL = `
<main id="root">
  <section id="empty-mount"></section>
  <section id="transcript"></section>
  <section id="hitl-mount"></section>
  <footer id="footer">
    <ul id="subtask-list"></ul>
    <span id="status"></span>
    <div id="attach-row">
      <div id="attach-mount"></div>
      <button type="button" id="attach-btn">Attach…</button>
    </div>
    <form id="input-form">
      <textarea id="input-text"></textarea>
      <button type="submit" id="input-send">Send</button>
      <button type="button" id="input-stop" disabled>Stop</button>
    </form>
  </footer>
</main>
`;

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (s: unknown) => void;
}

// The VS Code host posts messages with a `vscode-webview://<id>` origin — a
// browser-assigned, non-spoofable opaque origin only the webview host can
// produce. That origin is main.ts's trust boundary (an inline CodeQL/Sonar
// origin check). It does NOT require `ev.source === window.parent`: on VS Code's
// MessageChannel transport the source is the channel port, not window.parent, so
// such a check would drop every legitimate message. dispatch() mirrors a trusted
// host message by default; individual tests override `origin`/`source` to
// exercise the guard. `source` is set via defineProperty because jsdom's
// MessageEvent constructor does not accept a Window for `source`.
function dispatch(origin: string, data: unknown, source: unknown = window.parent): void {
  const ev = new MessageEvent("message", { origin, data });
  Object.defineProperty(ev, "source", { value: source, configurable: true });
  globalThis.dispatchEvent(ev);
}

function transcriptHtml(): string {
  return document.querySelector("#transcript")?.innerHTML ?? "";
}

beforeAll(async () => {
  document.body.innerHTML = CHAT_SHELL;
  (globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  });
  await import("../../src/chat/webview/main.js");
});

beforeEach(() => {
  const t = document.querySelector("#transcript");
  if (t !== null) t.innerHTML = "";
});

describe("webview message listener", () => {
  test("renders a userMessage from the trusted parent frame + vscode-webview origin", () => {
    dispatch("vscode-webview://abc", { type: "userMessage", text: "hi from extension" });
    expect(transcriptHtml()).toContain("hi from extension");
  });

  test("drops messages with an empty origin", () => {
    dispatch("", { type: "userMessage", text: "from harness" });
    expect(transcriptHtml()).not.toContain("from harness");
  });

  test("drops messages from foreign cross-origin frames", () => {
    dispatch("https://evil.example", { type: "userMessage", text: "smuggled" });
    expect(transcriptHtml()).not.toContain("smuggled");
  });

  test("renders a trusted vscode-webview message regardless of source (MessageChannel transport)", () => {
    // Regression: VS Code's MessageChannel transport delivers host messages with
    // a source that is the channel port, not window.parent. Requiring
    // source === window.parent dropped every real message and left the panel
    // blank. The non-spoofable vscode-webview:// origin is the real guard.
    dispatch("vscode-webview://xyz", { type: "userMessage", text: "channel-transport" }, null);
    expect(transcriptHtml()).toContain("channel-transport");
  });

  test("ignores payloads that do not look like ExtensionToWebview", () => {
    dispatch("vscode-webview://abc", "not an object");
    dispatch("vscode-webview://abc", { noType: true });
    dispatch("vscode-webview://abc", null);
    expect(transcriptHtml()).toBe("");
  });
});
