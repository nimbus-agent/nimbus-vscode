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

  test("attachments replaces the composer chip container on every post", () => {
    dispatch({
      type: "attachments",
      chips: [{ id: "a1", label: "src/a.ts", detail: "", state: "sent", chars: 20 }],
      totalChars: 20,
      provisional: true,
    });
    expect($("#attach-mount").innerHTML).toContain("src/a.ts");
    expect($("#attach-mount").innerHTML).toContain("estimated");
    // A later post fully replaces the previous render — no leftover chip.
    dispatch({ type: "attachments", chips: [], totalChars: 0, provisional: true });
    expect($("#attach-mount").innerHTML).toBe("");
  });

  test("turnAttachments is spliced into the user turn userMessage creates next, as a non-removable record", () => {
    dispatch({
      type: "turnAttachments",
      chips: [{ label: "src/a.ts", detail: "", state: "sent", chars: 20 }],
    });
    dispatch({ type: "userMessage", text: "explain this" });
    const turn = document.querySelector("article.turn-user");
    expect(turn?.innerHTML).toContain("src/a.ts");
    expect(turn?.querySelector(".turn-chips")).not.toBeNull();
  });

  test("turnAttachmentsFailed discards the pending manifest before it is ever rendered", () => {
    dispatch({
      type: "turnAttachments",
      chips: [{ label: "src/a.ts", detail: "", state: "sent", chars: 20 }],
    });
    dispatch({ type: "turnAttachmentsFailed" });
    dispatch({ type: "userMessage", text: "explain this" });
    const turn = document.querySelector("article.turn-user");
    expect(turn?.innerHTML).not.toContain("src/a.ts");
    expect(turn?.querySelector(".turn-chips")).toBeNull();
  });

  test("cancelled finalizes the streaming turn, marks it Stopped, and re-enables send", () => {
    dispatch({ type: "userMessage", text: "q" });
    dispatch({ type: "token", text: "partial" });
    dispatch({ type: "cancelled" });
    expect($("#transcript").innerHTML).toContain("partial");
    expect($("#transcript").innerHTML).toContain("Stopped");
    expect($("#transcript").querySelector('[data-streaming="1"]')).toBeNull();
    expect(btn("#input-send").disabled).toBe(false);
    expect(btn("#input-stop").disabled).toBe(true);
  });

  test("cancelled while not streaming is a no-op", () => {
    // beforeEach dispatched reset → not streaming.
    expect(() => dispatch({ type: "cancelled" })).not.toThrow();
    expect(btn("#input-send").disabled).toBe(false);
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
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
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

  test("clicking Stop shows Stopping… and disables the Stop button", () => {
    dispatch({ type: "userMessage", text: "q" });
    click($("#input-stop"));
    expect($("#status").textContent).toBe("Stopping…");
    expect(btn("#input-stop").disabled).toBe(true);
  });

  test("clicking Attach posts openAttachPicker", () => {
    click($("#attach-btn"));
    expect(posted.at(-1)).toEqual({ type: "openAttachPicker" });
  });

  test("clicking a composer chip's remove button posts detachContext with its id", () => {
    dispatch({
      type: "attachments",
      chips: [{ id: "a3", label: "src/a.ts", detail: "", state: "sent", chars: 20 }],
      totalChars: 20,
      provisional: true,
    });
    const removeBtn = document.querySelector<HTMLButtonElement>("#attach-mount button.chip-remove");
    if (removeBtn === null) throw new Error("no chip-remove button");
    click(removeBtn);
    expect(posted.at(-1)).toEqual({ type: "detachContext", id: "a3" });
  });

  test("a sent-turn chip carries the turn-chips class styles.css hides its remove control under", () => {
    dispatch({
      type: "turnAttachments",
      chips: [{ label: "src/a.ts", detail: "", state: "sent", chars: 20 }],
    });
    dispatch({ type: "userMessage", text: "q" });
    const removeBtn = document.querySelector<HTMLButtonElement>(
      "article.turn-user .turn-chips button.chip-remove",
    );
    expect(removeBtn?.closest(".turn-chips")).not.toBeNull();
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
