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

// The VS Code host posts messages from the embedding (parent) frame with a
// `vscode-webview://` origin. main.ts enforces BOTH `ev.source === window.parent`
// and a non-empty `vscode-webview` origin (an inline CodeQL/Sonar origin check).
// dispatch() mirrors a trusted host message by default; individual tests override
// `origin`/`source` to exercise those guards. `source` is set via defineProperty
// because jsdom's MessageEvent constructor does not accept a Window for `source`.
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

  test("drops messages whose source is not the parent frame", () => {
    dispatch("vscode-webview://xyz", { type: "userMessage", text: "no-source-payload" }, null);
    expect(transcriptHtml()).not.toContain("no-source-payload");
  });

  test("ignores payloads that do not look like ExtensionToWebview", () => {
    dispatch("vscode-webview://abc", "not an object");
    dispatch("vscode-webview://abc", { noType: true });
    dispatch("vscode-webview://abc", null);
    expect(transcriptHtml()).toBe("");
  });
});
