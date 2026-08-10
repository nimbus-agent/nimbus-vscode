import * as vscode from "vscode";

import type { Logger } from "../logging.js";
import type { PeekHover } from "./peek-hover.js";

// Thin vscode-API glue — mirrors real-lm-tools.ts and real-participant.ts. The
// logic (settle, supersede, cancellation) lives in peek-hover.ts, which is pure
// and carries the tests.

// `file` only: an untitled buffer has no path to blame, and a virtual document
// — our own read-only brief tabs included — is not in any repo.
const SELECTOR: vscode.DocumentSelector = { scheme: "file" };

export function registerWhyPeekHover(opts: { hover: PeekHover; log: Logger }): {
  dispose(): void;
} {
  return vscode.languages.registerHoverProvider(SELECTOR, {
    provideHover: async (document, position, token) => {
      // Raw editor coordinates. Relativising the path and the 0→1-based line
      // conversion happen in the deps wired in extension.ts, so this file holds
      // no logic worth testing.
      const md = await opts.hover.provide({
        target: { ref: document.uri.fsPath, line: position.line },
        docKey: document.uri.toString(),
        token,
      });
      if (md === undefined) return undefined;
      const content = new vscode.MarkdownString(md);
      // Required for the `command:` link to be clickable. Safe: every byte of
      // this string is built by renderPeek from typed Gateway fields — no user
      // HTML, no untrusted markup.
      content.isTrusted = true;
      return new vscode.Hover(content);
    },
  });
}
