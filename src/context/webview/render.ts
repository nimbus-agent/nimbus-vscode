import type { Offer } from "../offers.js";
import type { SignalSection } from "../signals.js";

// Pure HTML-string rendering for the context panel.
//
// escapeHtml is defined here rather than imported from the chat webview's
// render module on purpose: that module pulls in marked and DOMPurify, ~20 KB
// of markdown machinery this panel has no use for, and both bundles ship in the
// .vsix.

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRow(label: string, detail: string | undefined, iconId: string | undefined): string {
  const icon =
    iconId === undefined ? "" : `<span class="codicon codicon-${escapeHtml(iconId)}"></span>`;
  const sub = detail === undefined ? "" : `<span class="detail">${escapeHtml(detail)}</span>`;
  return `<li class="row">${icon}<span class="label">${escapeHtml(label)}</span>${sub}</li>`;
}

export function renderSections(sections: readonly SignalSection[]): string {
  return sections
    .map((section) => {
      const body =
        section.rows.length === 0
          ? `<p class="empty">${escapeHtml(section.empty ?? "Nothing to show.")}</p>`
          : `<ul class="rows">${section.rows
              .map((r) => renderRow(r.label, r.detail, r.iconId))
              .join("")}</ul>`;
      return `<section class="signal" data-signal="${escapeHtml(section.id)}"><h2>${escapeHtml(
        section.title,
      )}</h2>${body}</section>`;
    })
    .join("");
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
      return `<button class="offer" data-command="${escapeHtml(offer.command)}"${target}><span class="codicon codicon-${escapeHtml(
        offer.iconId,
      )}"></span>${escapeHtml(offer.label)}</button>`;
    })
    .join("");
  return `<section class="offers"><h2>Ask about this</h2>${buttons}</section>`;
}

export function renderPanel(input: {
  sections: readonly SignalSection[];
  offers: readonly Offer[];
  isDirty: boolean;
}): string {
  const dirty = input.isDirty
    ? `<p class="dirty">Unsaved edits — history may not line up with what is on screen.</p>`
    : "";
  return `${dirty}${renderSections(input.sections)}${renderOffers(input.offers)}`;
}
