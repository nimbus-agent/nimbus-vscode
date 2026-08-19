import type { ExtensionToWebview, WebviewToExtension } from "../chat-protocol.js";
import {
  renderChips,
  renderEmptyState,
  renderHitlCard,
  renderSubTaskRow,
  renderTurn,
  renderTurnChips,
} from "./render.js";

interface VsCodeApi {
  postMessage(msg: WebviewToExtension): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface Refs {
  transcript: HTMLElement;
  subTaskList: HTMLElement;
  emptyMount: HTMLElement;
  hitlMount: HTMLElement;
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  status: HTMLElement;
  attachMount: HTMLElement;
  attachBtn: HTMLButtonElement;
}

function refs(): Refs {
  return {
    transcript: must("#transcript"),
    subTaskList: must("#subtask-list"),
    emptyMount: must("#empty-mount"),
    hitlMount: must("#hitl-mount"),
    form: must<HTMLFormElement>("#input-form"),
    input: must<HTMLTextAreaElement>("#input-text"),
    send: must<HTMLButtonElement>("#input-send"),
    stop: must<HTMLButtonElement>("#input-stop"),
    status: must("#status"),
    attachMount: must("#attach-mount"),
    attachBtn: must<HTMLButtonElement>("#attach-btn"),
  };
}

function must<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (el === null) throw new Error(`webview shell missing required selector: ${sel}`);
  return el;
}

interface State {
  streamingText: string;
  streaming: boolean;
  // A resolved "turnAttachments" record arrives BEFORE the "userMessage" that
  // creates its turn bubble (the manifest must reach the webview before the
  // request leaves — see chat-controller.ts). Buffered here until that turn
  // bubble exists, so it can be spliced into the right article; a
  // "turnAttachmentsFailed" clears it unrendered when the send never went out.
  pendingTurnChipsHtml: string | undefined;
}

const state: State = {
  streamingText: "",
  streaming: false,
  pendingTurnChipsHtml: undefined,
};

// Finalize the in-flight turn and append a "Stopped" marker. Extracted from
// applyMessage's switch to keep that function's cognitive complexity in bounds.
function applyCancelled(r: Refs): void {
  if (!state.streaming) return;
  const streamingTurn = r.transcript.querySelector("article.turn-streaming");
  finalizeStreamingTurn(r);
  if (streamingTurn !== null) {
    const marker = document.createElement("div");
    marker.className = "turn-stopped-marker";
    marker.textContent = "⏹ Stopped";
    streamingTurn.appendChild(marker);
  }
  setStreaming(r, false);
}

function applyMessage(r: Refs, msg: ExtensionToWebview): void {
  switch (msg.type) {
    case "reset":
      r.transcript.replaceChildren();
      r.subTaskList.replaceChildren();
      r.hitlMount.replaceChildren();
      r.emptyMount.replaceChildren();
      r.emptyMount.insertAdjacentHTML("beforeend", renderEmptyState({ sub: "no-transcript" }));
      state.streamingText = "";
      state.pendingTurnChipsHtml = undefined;
      setStreaming(r, false);
      return;
    case "hydrate":
      r.transcript.replaceChildren();
      r.emptyMount.replaceChildren();
      for (const t of msg.turns) {
        r.transcript.insertAdjacentHTML("beforeend", renderTurn(t));
      }
      scrollToBottom(r);
      return;
    case "userMessage":
      r.emptyMount.replaceChildren();
      r.transcript.insertAdjacentHTML(
        "beforeend",
        renderTurn({ role: "user", text: msg.text, timestamp: Date.now() }),
      );
      // Splice the buffered turn manifest, if any, into the bubble just
      // created — the manifest belongs to THIS turn, not the general
      // transcript, and never to a turn that failed to start (see
      // "turnAttachmentsFailed").
      if (state.pendingTurnChipsHtml !== undefined) {
        r.transcript.lastElementChild?.insertAdjacentHTML("beforeend", state.pendingTurnChipsHtml);
        state.pendingTurnChipsHtml = undefined;
      }
      state.streamingText = "";
      r.transcript.insertAdjacentHTML(
        "beforeend",
        '<article class="turn turn-assistant turn-streaming"><header class="turn-header">Nimbus</header><div class="markdown" data-streaming="1"></div></article>',
      );
      setStreaming(r, true);
      scrollToBottom(r);
      return;
    case "token":
      state.streamingText += msg.text;
      {
        const target = r.transcript.querySelector('div.markdown[data-streaming="1"]');
        if (target !== null) {
          target.innerHTML = renderTurnBodyHtml(state.streamingText);
        }
      }
      scrollToBottom(r);
      return;
    case "subTask": {
      const row = renderSubTaskRow(msg);
      const existing = r.subTaskList.querySelector(
        `li.subtask-row[data-subtask-id="${cssEscape(msg.subTaskId)}"]`,
      );
      if (existing === null) {
        r.subTaskList.insertAdjacentHTML("beforeend", row);
      } else {
        existing.outerHTML = row;
      }
      return;
    }
    case "hitlInline":
      r.hitlMount.replaceChildren();
      r.hitlMount.insertAdjacentHTML(
        "beforeend",
        renderHitlCard({
          requestId: msg.requestId,
          prompt: msg.prompt,
          ...(msg.details === undefined ? {} : { details: msg.details }),
        }),
      );
      scrollToBottom(r);
      return;
    case "done":
      finalizeStreamingTurn(r);
      setStreaming(r, false);
      return;
    case "cancelled":
      applyCancelled(r);
      return;
    case "error":
      finalizeStreamingTurn(r);
      {
        const article = document.createElement("article");
        article.className = "turn turn-error";
        article.setAttribute("role", "alert");
        article.textContent = `Error: ${msg.message}`;
        r.transcript.append(article);
      }
      setStreaming(r, false);
      return;
    case "emptyState":
      r.transcript.replaceChildren();
      r.emptyMount.replaceChildren();
      r.emptyMount.insertAdjacentHTML(
        "beforeend",
        renderEmptyState({
          sub: msg.sub,
          ...(msg.socketPath === undefined ? {} : { socketPath: msg.socketPath }),
        }),
      );
      return;
    case "attachments":
      // Full replace, not a patch — this container renders exactly what the
      // host resolved, on every post, and computes nothing itself.
      r.attachMount.innerHTML = renderChips(msg.chips, msg.totalChars, msg.provisional);
      return;
    case "turnAttachments":
      // Buffered, not rendered yet — see State.pendingTurnChipsHtml.
      state.pendingTurnChipsHtml = renderTurnChips(msg.chips);
      return;
    case "turnAttachmentsFailed":
      state.pendingTurnChipsHtml = undefined;
      return;
    case "themeChange":
      return;
  }
}

function finalizeStreamingTurn(r: Refs): void {
  const target = r.transcript.querySelector<HTMLElement>('div.markdown[data-streaming="1"]');
  if (target !== null) {
    delete target.dataset["streaming"];
    target.innerHTML = renderTurnBodyHtml(state.streamingText);
    target.parentElement?.classList.remove("turn-streaming");
  }
  state.streamingText = "";
  r.subTaskList.replaceChildren();
  r.hitlMount.replaceChildren();
  scrollToBottom(r);
}

function renderTurnBodyHtml(text: string): string {
  const full = renderTurn({ role: "assistant", text });
  const start = full.indexOf('<div class="markdown">');
  const end = full.lastIndexOf("</div>");
  if (start < 0 || end < 0) return "";
  return full.slice(start + '<div class="markdown">'.length, end);
}

function setStreaming(r: Refs, streaming: boolean): void {
  state.streaming = streaming;
  r.send.disabled = streaming;
  r.stop.disabled = !streaming;
  r.status.textContent = streaming ? "Streaming…" : "";
}

function scrollToBottom(r: Refs): void {
  r.transcript.scrollTop = r.transcript.scrollHeight;
}

function cssEscape(s: string): string {
  return s.replaceAll(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function bootstrap(): void {
  const r = refs();

  r.emptyMount.insertAdjacentHTML("beforeend", renderEmptyState({ sub: "no-transcript" }));
  setStreaming(r, false);

  r.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) return;
    const text = r.input.value.trim();
    if (text.length === 0) return;
    vscode.postMessage({ type: "submitAsk", text });
    r.input.value = "";
  });

  r.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      r.form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  r.stop.addEventListener("click", () => {
    if (!state.streaming) return;
    r.stop.disabled = true;
    r.status.textContent = "Stopping…";
    vscode.postMessage({ type: "stopStream" });
  });

  // Wired here on the host's behalf; the host command it triggers lands in a
  // later task, so this posts into what is currently a no-op.
  r.attachBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "openAttachPicker" });
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    if (handleHitlButtonClick(target)) return;
    if (handleChipRemoveClick(target)) return;
    handleEmptyStateActionClick(target);
  });

  window.addEventListener("message", (ev) => {
    // Origin verification (CodeQL js/missing-origin-check, Sonar S2819).
    // VS Code posts host->webview messages from a `vscode-webview://<id>`
    // origin — a browser-assigned, non-spoofable opaque origin that only the
    // webview host can produce, so this is the real trust boundary. We do NOT
    // additionally require `ev.source === window.parent`: on VS Code's
    // MessageChannel transport the source is the channel port (neither
    // window.parent nor null), so that check rejected every legitimate message
    // and left the panel blank. The anchored `vscode-webview://` prefix also
    // rejects an empty/foreign origin. Kept inline so static analysis still
    // sees the origin check (see 985ab9cc).
    if (!ev.origin.startsWith("vscode-webview://")) return;
    const data = ev.data as ExtensionToWebview;
    if (data === null || typeof data !== "object" || typeof data.type !== "string") return;
    applyMessage(r, data);
  });

  vscode.postMessage({ type: "ready" });
}

function mkStub(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "hitl-stub";
  el.textContent = text;
  return el;
}

function handleHitlButtonClick(target: HTMLElement): boolean {
  const decisionBtn = target.closest<HTMLButtonElement>("button.hitl-btn[data-decision]");
  if (decisionBtn === null) return false;
  const requestId = decisionBtn.dataset["requestId"];
  const decision = decisionBtn.dataset["decision"];
  if (typeof requestId !== "string") return true;
  if (decision !== "approve" && decision !== "reject") return true;
  vscode.postMessage({ type: "hitlResponse", requestId, decision });
  const card = decisionBtn.closest<HTMLElement>(".hitl-card");
  if (card !== null) {
    const verb = decision === "approve" ? "approved" : "rejected";
    card.replaceWith(mkStub(`Decision recorded: ${verb}`));
  }
  return true;
}

// Live composer chips carry a remove control; sent-turn chips carry the same
// markup but are hidden via `.turn-chips .chip-remove { display: none; }`, so
// they are inert to a real click. A stray post here (e.g. a synthesized turn
// chip id that matches nothing in the live attachment set) is a harmless
// no-op on the host side.
function handleChipRemoveClick(target: HTMLElement): boolean {
  const removeBtn = target.closest<HTMLButtonElement>("button.chip-remove");
  if (removeBtn === null) return false;
  const id = removeBtn.dataset["id"];
  if (typeof id !== "string") return true;
  vscode.postMessage({ type: "detachContext", id });
  return true;
}

function handleEmptyStateActionClick(target: HTMLElement): void {
  const btn = target.closest<HTMLButtonElement>("button[data-action]");
  if (btn === null) return;
  const action = btn.dataset["action"];
  if (action === "openLogs") {
    vscode.postMessage({ type: "openLogs" });
  } else if (action === "startGateway") {
    vscode.postMessage({ type: "startGateway" });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
