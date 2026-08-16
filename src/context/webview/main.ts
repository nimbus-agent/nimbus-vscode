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
  const root = mount();
  if (root === null) return;
  const message = event.data;
  if (message.type === "paused") {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = renderPanel({
    sections: message.sections,
    offers: message.offers,
    isDirty: message.isDirty,
  });
});

document.addEventListener("click", onClick);
vscode.postMessage({ type: "ready" });
