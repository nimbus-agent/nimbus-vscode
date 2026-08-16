// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

const CONTEXT_SHELL = `<main id="root"></main>`;

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
}

// Mirrors test/unit/webview-listener.test.ts's dispatch helper: the VS Code
// host posts messages with a `vscode-webview://<id>` origin — an opaque,
// browser-assigned origin a foreign page cannot forge — and that origin is
// main.ts's trust boundary. dispatch() defaults to a trusted origin; each
// test overrides it to exercise the guard.
function dispatch(origin: string, data: unknown): void {
  const ev = new MessageEvent("message", { origin, data });
  globalThis.dispatchEvent(ev);
}

function rootHtml(): string {
  return document.querySelector("#root")?.innerHTML ?? "";
}

const RENDER_MESSAGE = {
  type: "render",
  generation: 1,
  sections: [{ id: "problems", title: "Problems", rows: [{ label: "Line 3: boom" }] }],
  offers: [],
  isDirty: false,
};

beforeAll(async () => {
  document.body.innerHTML = CONTEXT_SHELL;
  (globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
  });
  await import("../../src/context/webview/main.js");
});

beforeEach(() => {
  const root = document.querySelector("#root");
  if (root !== null) root.innerHTML = "";
});

describe("context webview message listener", () => {
  test("renders a render message from a vscode-webview origin", () => {
    dispatch("vscode-webview://abc", RENDER_MESSAGE);
    expect(rootHtml()).toContain("Line 3: boom");
  });

  test("drops messages with an empty origin", () => {
    dispatch("", RENDER_MESSAGE);
    expect(rootHtml()).not.toContain("Line 3: boom");
  });

  test("drops messages from foreign cross-origin frames", () => {
    dispatch("https://evil.example", RENDER_MESSAGE);
    expect(rootHtml()).not.toContain("Line 3: boom");
  });

  test("ignores payloads that do not look like ExtensionToContextView", () => {
    expect(() => dispatch("vscode-webview://abc", null)).not.toThrow();
    expect(() => dispatch("vscode-webview://abc", "not an object")).not.toThrow();
    expect(() => dispatch("vscode-webview://abc", { noType: true })).not.toThrow();
    expect(rootHtml()).toBe("");
  });
});
