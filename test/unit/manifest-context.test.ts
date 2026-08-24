import { describe, expect, test } from "vitest";

import { configProperties, views } from "./helpers/manifest.js";

describe("extension manifest: context setting", () => {
  test("contributes nimbus.context.enabled, defaulting to on", () => {
    const property = configProperties["nimbus.context.enabled"];
    expect(property?.type).toBe("boolean");
    expect(property?.default).toBe(true);
  });
});

describe("extension manifest: context panel", () => {
  test("declares the context view in the Nimbus container", () => {
    expect(views.some((v) => v.id === "nimbus.contextView")).toBe(true);
  });

  test("declares it as a webview, not a tree", () => {
    expect(views.find((v) => v.id === "nimbus.contextView")?.type).toBe("webview");
  });

  test("places it first — an ambient panel below six collapsed trees is invisible", () => {
    expect(views[0]?.id).toBe("nimbus.contextView");
  });

  test("leaves the six tree views in place", () => {
    const ids = views.map((v) => v.id);
    for (const id of [
      "nimbus.auditView",
      "nimbus.egressView",
      "nimbus.agentsView",
      "nimbus.indexView",
      "nimbus.sessionsView",
      "nimbus.workflowsView",
    ]) {
      expect(ids).toContain(id);
    }
  });
});
