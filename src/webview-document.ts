import { randomUUID } from "node:crypto";

// The HTML document each bundled webview — the chat panel and the context view —
// is served as. One copy of the shell and, above all, of its
// Content-Security-Policy, so the two surfaces cannot drift apart on it: nothing
// loads by default; styles and fonts come only from the webview's own resource
// origin (plus inline styles); and the single script is the bundle, admitted by
// a nonce minted fresh for every render rather than by origin.
//
// Kept free of `vscode` (the caller passes strings) so the shell is unit-tested
// here, not only inside the real-* adapters that serve it, which are vscode glue
// excluded from coverage.

export interface WebviewDocument {
  /** The webview's `cspSource`: the origin its own resources are served from. */
  cspSource: string;
  title: string;
  /** The bundle's stylesheet, already mapped through `asWebviewUri`. */
  styleUri: string;
  /** The bundle's script, already mapped through `asWebviewUri`. */
  scriptUri: string;
  /** The markup inside `<main id="root">`, written into the page verbatim. */
  root: string;
}

export function renderWebviewDocument(doc: WebviewDocument, nonce: string = newNonce()): string {
  const csp =
    `default-src 'none'; ` +
    `style-src ${doc.cspSource} 'unsafe-inline'; ` +
    `font-src ${doc.cspSource}; ` +
    `script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>${doc.title}</title>
<link rel="stylesheet" href="${doc.styleUri}" />
</head>
<body>
<main id="root">${doc.root}</main>
<script nonce="${nonce}" src="${doc.scriptUri}"></script>
</body>
</html>`;
}

// A random UUID's 32 hex digits, dashes dropped — the form both webviews have
// always used.
function newNonce(): string {
  return randomUUID().replaceAll("-", "");
}
