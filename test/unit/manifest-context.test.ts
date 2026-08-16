import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type View = { id: string; name: string; type?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: { views?: { nimbus?: View[] } };
};

const views = manifest.contributes?.views?.nimbus ?? [];

describe("extension manifest: context panel", () => {
  test("declares the context view in the Nimbus container", () => {
    expect(views.some((v) => v.id === "nimbus.contextView")).toBe(true);
  });

  test("declares it as a webview, not a tree", () => {
    expect(views.find((v) => v.id === "nimbus.contextView")?.type).toBe("webview");
  });

  test("places it first — an ambient panel below five collapsed trees is invisible", () => {
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
