import { describe, expect, test } from "vitest";

import { renderWebviewDocument, type WebviewDocument } from "../../src/webview-document.js";

const DOC: WebviewDocument = {
  cspSource: "https://file+.vscode-resource.vscode-cdn.net",
  title: "Nimbus",
  styleUri: "https://file+.vscode-resource.vscode-cdn.net/media/webview.css",
  scriptUri: "https://file+.vscode-resource.vscode-cdn.net/media/webview.js",
  root: `\n  <section id="mount"></section>\n`,
};

const NONCE = "0123456789abcdef0123456789abcdef";

function cspOf(html: string): string {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/.exec(html);
  if (m?.[1] === undefined) throw new Error("no CSP meta tag");
  return m[1];
}

function noncesOf(html: string): string[] {
  return [...html.matchAll(/nonce-([0-9a-f]+)'|nonce="([0-9a-f]+)"/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

describe("renderWebviewDocument", () => {
  test("renders the shell around the caller's root markup", () => {
    expect(renderWebviewDocument(DOC, NONCE)).toBe(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${DOC.cspSource} 'unsafe-inline'; font-src ${DOC.cspSource}; script-src 'nonce-${NONCE}';" />
<title>Nimbus</title>
<link rel="stylesheet" href="${DOC.styleUri}" />
</head>
<body>
<main id="root">
  <section id="mount"></section>
</main>
<script nonce="${NONCE}" src="${DOC.scriptUri}"></script>
</body>
</html>`);
  });

  // The policy both webviews share. Pinned piece by piece, so a loosening —
  // a script admitted by origin, an eval, a default that loads anything —
  // fails here by name rather than as a one-character diff in the shell above.
  test("denies by default and admits the script by nonce alone", () => {
    const csp = cspOf(renderWebviewDocument(DOC, NONCE));
    expect(csp.startsWith("default-src 'none';")).toBe(true);
    expect(csp).toContain(`script-src 'nonce-${NONCE}';`);
    expect(csp).toContain(`style-src ${DOC.cspSource} 'unsafe-inline';`);
    expect(csp).toContain(`font-src ${DOC.cspSource};`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|https?:|\*)/);
  });

  test("mints a fresh nonce per render and uses it in both places", () => {
    const first = noncesOf(renderWebviewDocument(DOC));
    const second = noncesOf(renderWebviewDocument(DOC));
    expect(first).toHaveLength(2);
    expect(first[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(first[1]).toBe(first[0]);
    expect(second[0]).not.toBe(first[0]);
  });
});
