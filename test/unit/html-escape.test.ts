import { describe, expect, test } from "vitest";

import { escapeHtml as chatEscapeHtml } from "../../src/chat/webview/render.js";
import { escapeHtml as contextEscapeHtml } from "../../src/context/webview/render.js";
import { escapeHtml } from "../../src/html-escape.js";

describe("escapeHtml (shared)", () => {
  test("escapes each of the five HTML metacharacters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("escapes every occurrence, not just the first", () => {
    expect(escapeHtml("<<&&>>")).toBe("&lt;&lt;&amp;&amp;&gt;&gt;");
  });

  // An ampersand that is already part of an entity is still escaped: the
  // input is text, never markup, so "&amp;" must render as those five
  // characters rather than collapse to "&".
  test("treats an existing entity as text", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("leaves everything else untouched", () => {
    const plain = "hello world — 123 é \\ / ` = \n\t";
    expect(escapeHtml(plain)).toBe(plain);
    expect(escapeHtml("")).toBe("");
  });

  // The point of the module: one escaper for every webview surface. Each
  // renderer re-exports it rather than carrying a copy that could drift.
  test("is the very function both webview renderers expose", () => {
    expect(chatEscapeHtml).toBe(escapeHtml);
    expect(contextEscapeHtml).toBe(escapeHtml);
  });
});
