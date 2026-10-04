// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WebviewToExtension } from "../../src/chat/chat-protocol.js";

// src/chat/webview/main.ts wires itself up at import time. The other webview
// suites import it once into a finished document; these two cover what
// happens at the edges of that one moment, each on a fresh module instance.

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

const posted: WebviewToExtension[] = [];

beforeEach(() => {
  posted.length = 0;
  vi.resetModules();
  (
    globalThis as unknown as {
      acquireVsCodeApi: () => { postMessage: (m: WebviewToExtension) => void };
    }
  ).acquireVsCodeApi = () => ({
    postMessage: (m) => {
      posted.push(m);
    },
  });
});

afterEach(() => {
  // Drop the own-property override, restoring jsdom's prototype getter.
  Reflect.deleteProperty(document, "readyState");
  document.body.innerHTML = "";
});

describe("chat webview bootstrap", () => {
  test("a script that runs while the document is still loading waits for DOMContentLoaded", async () => {
    document.body.innerHTML = CHAT_SHELL;
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    await import("../../src/chat/webview/main.js");
    // Nothing is wired yet: the handshake would otherwise be the first post.
    expect(posted).toEqual([]);
    expect(document.querySelector("#empty-mount")?.innerHTML).toBe("");

    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(posted).toEqual([{ type: "ready" }]);
    expect(document.querySelector("#empty-mount")?.innerHTML).toContain("Nothing yet.");
  });

  test("a shell missing a required element fails loudly, naming the selector", async () => {
    // The same shell with the Attach button removed.
    document.body.innerHTML = CHAT_SHELL.replace(
      '<button type="button" id="attach-btn">Attach…</button>',
      "",
    );
    await expect(import("../../src/chat/webview/main.js")).rejects.toThrow(
      "webview shell missing required selector: #attach-btn",
    );
    expect(posted).toEqual([]);
  });
});
