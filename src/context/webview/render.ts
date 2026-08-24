import type { Offer } from "../offers.js";
import type { SignalSection } from "../signals.js";

// Pure HTML-string rendering for the context panel.
//
// escapeHtml is defined here rather than imported from the chat webview's
// render module on purpose: that module pulls in marked and DOMPurify, ~20 KB
// of markdown machinery this panel has no use for, and both bundles ship in the
// .vsix.
//
// No icons are rendered. SignalRow.iconId and Offer.iconId still name a real
// codicon — the sidebar tree views draw the same ids as ThemeIcons — but a
// webview has no codicon font unless the extension ships one, and this one does
// not. Emitting `<span class="codicon codicon-…">` here produced an empty inline
// element and a stray flex gap before every label. The ids stay in the data
// model for whichever PR ships the font.

// Shown when nimbus.context.enabled is false. The view deliberately stays in
// the sidebar when the setting is off, so it has to say why it is empty —
// a blank panel reads as a broken one.
//
// `.empty` and nothing else: that class already exists in styles.css and is
// what every other empty state in this panel uses, so this inherits the panel's
// theming for free. No <code> element — styles.css has no rule for one, so it
// would render in a browser-default font matching nothing else here.
export const DISABLED_NOTICE = `<p class="empty">Context panel is off — turn on nimbus.context.enabled to use it.</p>`;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRow(label: string, detail: string | undefined): string {
  const sub = detail === undefined ? "" : `<span class="detail">${escapeHtml(detail)}</span>`;
  return `<li class="row"><span class="label">${escapeHtml(label)}</span>${sub}</li>`;
}

// What a section with no rows says instead. A section still loading says so
// rather than claiming emptiness it has not established yet; one that has
// finished falls back to its own wording, then to the generic line.
function emptyTextOf(section: SignalSection): string {
  if (section.loading === true) return "Loading…";
  return section.empty ?? "Nothing to show.";
}

function renderSectionBody(section: SignalSection): string {
  if (section.rows.length > 0) {
    const rows = section.rows.map((r) => renderRow(r.label, r.detail)).join("");
    return `<ul class="rows">${rows}</ul>`;
  }
  return `<p class="empty">${escapeHtml(emptyTextOf(section))}</p>`;
}

export function renderSections(sections: readonly SignalSection[]): string {
  return (
    sections
      // A suppressed section with nothing to say renders nothing — not a heading
      // over an empty state. Filtered here rather than in the controller so the
      // rule is one pure line with no state behind it.
      .filter((section) => !(section.suppressWhenEmpty === true && section.rows.length === 0))
      .map((section) => {
        const heading = escapeHtml(section.title);
        const body = renderSectionBody(section);
        return `<section class="signal" data-signal="${escapeHtml(section.id)}"><h2>${heading}</h2>${body}</section>`;
      })
      .join("")
  );
}

export function renderOffers(offers: readonly Offer[]): string {
  if (offers.length === 0) {
    return `<section class="offers"><p class="empty">Open a file to see the briefs that fit it.</p></section>`;
  }
  const buttons = offers
    .map((offer) => {
      // The target rides in a data attribute rather than an inline handler: the
      // CSP allows no inline script, and main.ts reads it back on click.
      const target =
        offer.target === undefined
          ? ""
          : ` data-target="${escapeHtml(JSON.stringify(offer.target))}"`;
      return `<button class="offer" data-command="${escapeHtml(offer.command)}"${target}>${escapeHtml(offer.label)}</button>`;
    })
    .join("");
  return `<section class="offers"><h2>Ask about this</h2>${buttons}</section>`;
}

/**
 * The informational half of the panel: the unsaved-edits banner and the signal
 * sections. Rendered separately from the offers because the two go into
 * different mounts — see main.ts, and the shell in real-context-view.ts.
 */
export function renderSignals(input: {
  sections: readonly SignalSection[];
  isDirty: boolean;
}): string {
  const dirty = input.isDirty
    ? `<p class="dirty">Unsaved edits — history may not line up with what is on screen.</p>`
    : "";
  return `${dirty}${renderSections(input.sections)}`;
}
