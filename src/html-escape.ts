// HTML escaping for every string this extension interpolates into webview
// markup: the chat webview, the context panel and the consent-details page.
//
// One copy, so a fix to it reaches every surface at once. It imports nothing on
// purpose: it is bundled into all three bundles — both browser IIFEs and the
// extension host — and a copy living in the chat webview's render module would
// drag marked and DOMPurify into the other two, which have no use for them.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five characters that are significant in HTML text and attribute values. */
export function escapeHtml(s: string): string {
  return s.replaceAll(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
