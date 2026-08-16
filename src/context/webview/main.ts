import type { ContextViewToExtension, ExtensionToContextView } from "../protocol.js";
import { renderPanel } from "./render.js";

// The browser half of the context panel. It decides nothing: it renders what
// the host sends and posts back the command a clicked offer names.

interface VsCodeApi {
  postMessage(message: ContextViewToExtension): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function mount(): HTMLElement | null {
  return document.getElementById("root");
}

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button.offer");
  if (!(button instanceof HTMLElement)) return;
  const command = button.dataset["command"];
  if (command === undefined) return;
  const raw = button.dataset["target"];
  const args = raw === undefined ? [] : [JSON.parse(raw) as unknown];
  vscode.postMessage({ type: "run", command, args });
}

window.addEventListener("message", (event: MessageEvent<ExtensionToContextView>) => {
  // Trust boundary (CodeQL js/missing-origin-check, Sonar S2819): only the VS
  // Code host can post a `vscode-webview://<id>` origin — it's an
  // opaque, browser-assigned origin a foreign page cannot forge. Checked
  // inline, not via an imported helper, so static analysis sees the guard
  // directly at the listener rather than through an indirection it may not
  // follow, and so this bundle stays free of the chat webview's module.
  if (!event.origin.startsWith("vscode-webview://")) return;
  const message: unknown = event.data;
  // A trusted origin says nothing about payload shape: guard against a
  // null/non-object message or one missing `type` before branching on it,
  // matching src/chat/webview/main.ts's same check.
  if (
    message === null ||
    typeof message !== "object" ||
    typeof (message as { type?: unknown }).type !== "string"
  ) {
    return;
  }
  const root = mount();
  if (root === null) return;
  const typed = message as ExtensionToContextView;
  if (typed.type === "paused") {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = renderPanel({
    sections: typed.sections,
    offers: typed.offers,
    isDirty: typed.isDirty,
  });
});

document.addEventListener("click", onClick);
vscode.postMessage({ type: "ready" });
