import type { HitlRequest } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import { renderDetailsHtml } from "../../src/hitl/hitl-details-webview.js";

function req(overrides: Partial<HitlRequest> = {}): HitlRequest {
  return {
    requestId: "r1",
    prompt: "Proceed?",
    details: { foo: "bar" },
    ...overrides,
  } as HitlRequest;
}

describe("renderDetailsHtml", () => {
  test("embeds the cspSource, prompt, details JSON, and requestId", () => {
    const html = renderDetailsHtml({ request: req(), cspSource: "vscode-resource:" });
    expect(html).toContain("vscode-resource:");
    expect(html).toContain("Proceed?");
    // The details JSON is HTML-escaped inside the <pre>, so quotes become &quot;.
    expect(html).toContain("&quot;foo&quot;: &quot;bar&quot;");
    // requestId is embedded into the inline script via JSON.stringify (unescaped).
    expect(html).toContain('"r1"');
  });

  test("escapes HTML metacharacters in the prompt to prevent injection", () => {
    const html = renderDetailsHtml({
      request: req({ prompt: `<img src=x onerror="alert('&')">` }),
      cspSource: "x",
    });
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
    expect(html).not.toContain("<img src=x");
  });

  test("renders null details when the request carries none", () => {
    const html = renderDetailsHtml({ request: req({ details: undefined }), cspSource: "x" });
    expect(html).toContain(">null<");
  });
});
