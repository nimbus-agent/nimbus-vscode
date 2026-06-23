// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { ExtensionToWebview, WebviewToExtension } from "../../src/chat/chat-protocol.js";

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

const posted: WebviewToExtension[] = [];

// Mirror a trusted host→webview message (parent frame + vscode-webview origin).
function dispatch(data: ExtensionToWebview): void {
  const ev = new MessageEvent("message", { origin: "vscode-webview://app", data });
  Object.defineProperty(ev, "source", { value: window.parent, configurable: true });
  globalThis.dispatchEvent(ev);
}

function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (el === null) throw new Error(`missing selector: ${sel}`);
  return el;
}

function btn(sel: string): HTMLButtonElement {
  return $(sel) as HTMLButtonElement;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeAll(async () => {
  document.body.innerHTML = CHAT_SHELL;
  (
    globalThis as unknown as {
      acquireVsCodeApi: () => {
        postMessage: (m: WebviewToExtension) => void;
        getState: () => unknown;
        setState: (s: unknown) => void;
      };
    }
  ).acquireVsCodeApi = () => ({
    postMessage: (m) => {
      posted.push(m);
    },
    getState: () => undefined,
    setState: () => undefined,
  });
  await import("../../src/chat/webview/main.js");
});

beforeEach(() => {
  posted.length = 0;
  // reset restores a clean, non-streaming shell between tests.
  dispatch({ type: "reset" });
});

describe("webview applyMessage", () => {
  test("reset clears the transcript and shows the empty state", () => {
    dispatch({ type: "userMessage", text: "scratch" });
    dispatch({ type: "reset" });
    expect($("#transcript").innerHTML).toBe("");
    expect($("#empty-mount").innerHTML).toContain("Nothing yet");
  });

  test("hydrate renders stored transcript turns", () => {
    dispatch({ type: "hydrate", turns: [{ role: "user", text: "remembered", timestamp: 1 }] });
    expect($("#transcript").innerHTML).toContain("remembered");
  });

  test("userMessage appends a turn and enters streaming mode", () => {
    dispatch({ type: "userMessage", text: "ask me" });
    expect($("#transcript").innerHTML).toContain("ask me");
    expect(btn("#input-send").disabled).toBe(true);
    expect(btn("#input-stop").disabled).toBe(false);
  });

  test("token updates the streaming turn body", () => {
    dispatch({ type: "userMessage", text: "q" });
    dispatch({ type: "token", text: "partial answer" });
    expect($("#transcript").innerHTML).toContain("partial answer");
  });

  test("subTask inserts then updates a row in place", () => {
    dispatch({ type: "subTask", subTaskId: "t1", status: "running" });
    expect(document.querySelectorAll("li.subtask-row")).toHaveLength(1);
    dispatch({ type: "subTask", subTaskId: "t1", status: "finished", progress: 1 });
    expect(document.querySelectorAll("li.subtask-row")).toHaveLength(1);
    expect($("#subtask-list").innerHTML).toContain("finished");
  });

  test("hitlInline renders a consent card with action buttons", () => {
    dispatch({ type: "hitlInline", requestId: "r1", prompt: "Allow write?", details: { a: 1 } });
    expect($("#hitl-mount").innerHTML).toContain("Allow write?");
    expect(document.querySelector('button.hitl-btn[data-decision="approve"]')).not.toBeNull();
  });

  test("done finalizes streaming and re-enables send", () => {
    dispatch({ type: "userMessage", text: "q" });
    dispatch({ type: "token", text: "a" });
    dispatch({ type: "done", reply: "a", sessionId: "s" });
    expect(btn("#input-send").disabled).toBe(false);
    expect(btn("#input-stop").disabled).toBe(true);
  });

  test("error renders an alert turn", () => {
    dispatch({ type: "error", message: "kaboom" });
    expect($("#transcript").innerHTML).toContain("Error: kaboom");
  });

  test("emptyState renders the disconnected view including the socket path", () => {
    dispatch({ type: "emptyState", sub: "disconnected", socketPath: "/run/n.sock" });
    expect($("#empty-mount").innerHTML).toContain("Gateway not connected");
    expect($("#empty-mount").innerHTML).toContain("/run/n.sock");
  });

  test("themeChange is a no-op", () => {
    expect(() => dispatch({ type: "themeChange" })).not.toThrow();
  });
});

describe("webview interactions", () => {
  test("submitting the form posts submitAsk and clears the input", () => {
    const input = $("#input-text") as HTMLTextAreaElement;
    input.value = "hello world";
    $("#input-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(posted.at(-1)).toEqual({ type: "submitAsk", text: "hello world" });
    expect(input.value).toBe("");
  });

  test("submitting blank input posts nothing", () => {
    const input = $("#input-text") as HTMLTextAreaElement;
    input.value = "   ";
    $("#input-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(posted).toHaveLength(0);
  });

  test("submitting while streaming is suppressed", () => {
    dispatch({ type: "userMessage", text: "q" });
    posted.length = 0;
    const input = $("#input-text") as HTMLTextAreaElement;
    input.value = "blocked";
    $("#input-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(posted).toHaveLength(0);
  });

  test("Ctrl+Enter in the textarea submits", () => {
    const input = $("#input-text") as HTMLTextAreaElement;
    input.value = "via keyboard";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(posted.at(-1)).toEqual({ type: "submitAsk", text: "via keyboard" });
  });

  test("Stop posts stopStream while streaming", () => {
    dispatch({ type: "userMessage", text: "q" });
    posted.length = 0;
    click($("#input-stop"));
    expect(posted.at(-1)).toEqual({ type: "stopStream" });
  });

  test("approving a HITL card posts the decision and swaps the card for a stub", () => {
    dispatch({ type: "hitlInline", requestId: "r9", prompt: "Allow?" });
    const approve = document.querySelector<HTMLButtonElement>(
      'button.hitl-btn[data-decision="approve"]',
    );
    if (approve === null) throw new Error("no approve button");
    click(approve);
    expect(posted.at(-1)).toEqual({ type: "hitlResponse", requestId: "r9", decision: "approve" });
    expect($("#hitl-mount").innerHTML).toContain("Decision recorded: approved");
  });

  test("empty-state action buttons post their commands", () => {
    dispatch({ type: "emptyState", sub: "disconnected", socketPath: "" });
    const startBtn = document.querySelector<HTMLButtonElement>(
      'button[data-action="startGateway"]',
    );
    if (startBtn === null) throw new Error("no startGateway button");
    click(startBtn);
    expect(posted.at(-1)).toEqual({ type: "startGateway" });

    dispatch({ type: "emptyState", sub: "permission-denied" });
    const logsBtn = document.querySelector<HTMLButtonElement>('button[data-action="openLogs"]');
    if (logsBtn === null) throw new Error("no openLogs button");
    click(logsBtn);
    expect(posted.at(-1)).toEqual({ type: "openLogs" });
  });
});
