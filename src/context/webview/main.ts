import type { ContextViewToExtension, ExtensionToContextView } from "../protocol.js";
import type { SignalSection } from "../signals.js";
import { DISABLED_NOTICE, renderOffers, renderSignals } from "./render.js";

// The browser half of the context panel. It decides nothing: it renders what
// the host sends and posts back the command a clicked offer names.

interface VsCodeApi {
  postMessage(message: ContextViewToExtension): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// The last HTML written into each mount. The host re-collects on a debounce, and
// with PR 1's two signals most collections produce a byte-identical render —
// moving the cursor within one file always does. Writing innerHTML anyway would
// make the `aria-live` signals region re-announce unchanged text and destroy
// keyboard focus inside the mount, so an identical repaint is skipped. Nothing
// else writes to these mounts, so the cache cannot drift from the DOM.
const painted: Record<string, string | undefined> = {};

// Sections arrive independently: the local ones ride the first render, and each
// Gateway-backed one lands when its RPC resolves. Keeping them by id means a
// late blame answer repaints one section rather than the whole panel.
let sections: SignalSection[] = [];
let currentGeneration = -1;
let currentIsDirty = false;

function paint(id: string, html: string): void {
  const el = document.getElementById(id);
  if (el === null) return;
  if (painted[id] === html) return;
  painted[id] = html;
  el.innerHTML = html;
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
  const typed = message as ExtensionToContextView;
  if (typed.type === "paused") {
    // "hidden" paints nothing because nobody is looking; "disabled" has to
    // explain itself, because the view is on screen and would otherwise read
    // as a surface that has silently broken.
    paint("signals", typed.reason === "disabled" ? DISABLED_NOTICE : "");
    paint("offers", "");
    return;
  }
  if (typed.type === "section") {
    // The same discipline as the payload check above, at the one place this
    // listener reaches two levels into a message: a `section` without a
    // section object would otherwise throw inside the listener.
    const section: unknown = (typed as { section?: unknown }).section;
    if (section === null || typeof section !== "object") return;
    if (typeof (section as { id?: unknown }).id !== "string") return;
    // Fenced: a section from a superseded collection describes a line or file
    // the user has already left.
    if (typed.generation !== currentGeneration) return;
    // Replace in place, never append. This relies on an invariant the
    // controller holds: the FIRST render seeds a slot for every signal id —
    // cached, local, disconnected or "Loading…" — so the id arriving here
    // always already has a slot. A section for an id with no slot is dropped
    // by this map rather than appended, which is the safe direction: the
    // alternative would grow the panel a duplicate heading at a time.
    sections = sections.map((s) => (s.id === typed.section.id ? typed.section : s));
    paint("signals", renderSignals({ sections, isDirty: currentIsDirty }));
    return;
  }
  // Matched explicitly rather than assumed as the else branch: a message type
  // this bundle does not yet know about — added by a later host version, say —
  // must be dropped, not rendered as though it were a render message.
  if (typed.type !== "render") return;
  currentGeneration = typed.generation;
  currentIsDirty = typed.isDirty;
  sections = [...typed.sections];
  paint("signals", renderSignals({ sections, isDirty: currentIsDirty }));
  paint("offers", renderOffers(typed.offers));
});

document.addEventListener("click", onClick);
vscode.postMessage({ type: "ready" });
