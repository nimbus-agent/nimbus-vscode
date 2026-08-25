import { beforeEach, describe, expect, test } from "vitest";

import type { PeekHover } from "../../src/briefs/peek-hover.js";
import { registerWhyPeekHover } from "../../src/briefs/real-hover.js";
import { Hover, languages, MarkdownString } from "./vscode-stub.js";

// real-hover.ts is thin vscode glue, but two of its three lines are load-bearing
// and neither is expressible in peek-hover.ts (which holds the logic and never
// sees a vscode type):
//
//   * `isTrusted = true` — without it the rendered "Why? →" `command:` link is
//     inert, and the hover looks like it works right up until it is clicked;
//   * the `undefined` short-circuit — returning a Hover wrapping "undefined"
//     would paint an empty tooltip over every line of every file.

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function document(fsPath: string) {
  return { uri: { fsPath, toString: () => `file://${fsPath}` } };
}

function drive(provide: PeekHover["provide"]) {
  registerWhyPeekHover({ hover: { provide }, log });
  const provider = languages.lastHoverProvider;
  if (provider === undefined) throw new Error("no hover provider was registered");
  return provider;
}

describe("registerWhyPeekHover", () => {
  beforeEach(() => {
    languages.lastHoverProvider = undefined;
    languages.lastHoverSelector = undefined;
  });

  // An untitled buffer has no path to blame, and a virtual document — our own
  // read-only brief tabs included — is in no repo. Registering against every
  // scheme would run a blame lookup over both.
  test("registers for file-scheme documents only", () => {
    drive(async () => undefined);
    expect(languages.lastHoverSelector).toEqual({ scheme: "file" });
  });

  test("a trusted MarkdownString carries the markdown, so the command link works", async () => {
    const provider = drive(async () => "**why** [Why? →](command:nimbus.brief.why)");
    const hover = (await provider.provideHover(
      document("/repo/src/a.ts"),
      { line: 41 },
      undefined,
    )) as Hover;

    expect(hover).toBeInstanceOf(Hover);
    const content = hover.contents as MarkdownString;
    expect(content).toBeInstanceOf(MarkdownString);
    expect(content.value).toContain("command:nimbus.brief.why");
    // The whole reason this glue exists rather than returning a bare string.
    expect(content.isTrusted).toBe(true);
  });

  test("no peek means no hover at all, not an empty one", async () => {
    const provider = drive(async () => undefined);
    expect(
      await provider.provideHover(document("/repo/src/a.ts"), { line: 0 }, undefined),
    ).toBeUndefined();
  });

  // Raw editor coordinates go through untouched: relativising the path and the
  // 0→1-based line conversion belong to the deps wired in extension.ts, and
  // doing either here as well would double-apply them.
  test("passes the editor's own path, line and token through unchanged", async () => {
    const seen: unknown[] = [];
    const token = { isCancellationRequested: false };
    const provider = drive(async (req) => {
      seen.push(req);
      return "x";
    });
    await provider.provideHover(document("/repo/src/a.ts"), { line: 41 }, token);
    expect(seen[0]).toEqual({
      target: { ref: "/repo/src/a.ts", line: 41 },
      docKey: "file:///repo/src/a.ts",
      token,
    });
  });
});
