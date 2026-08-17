import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

type View = { id: string; name: string; type?: string; initialSize?: number; visibility?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: { views?: { nimbus?: View[] } };
};

const views = manifest.contributes?.views?.nimbus ?? [];

type Config = { properties?: Record<string, { type?: string; default?: unknown }> };
const configManifest = manifest as unknown as {
  contributes?: { configuration?: Config | Config[] };
};

describe("extension manifest: context setting", () => {
  test("contributes nimbus.context.enabled, defaulting to on", () => {
    const raw = configManifest.contributes?.configuration;
    const blocks = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const property = blocks
      .flatMap((b) => Object.entries(b.properties ?? {}))
      .find(([key]) => key === "nimbus.context.enabled")?.[1];
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

  test("weights the context view above the tree views it sits over", () => {
    const context = views.find((v) => v.id === "nimbus.contextView");
    expect(context?.initialSize).toBeGreaterThanOrEqual(3);
    for (const v of views.filter((x) => x.id !== "nimbus.contextView")) {
      expect(v.initialSize ?? 1).toBeLessThan(context?.initialSize ?? 0);
    }
  });

  test("collapses the six tree views so Context holds the space on first open", () => {
    const context = views.find((v) => v.id === "nimbus.contextView");
    expect(context?.visibility).toBeUndefined();
    for (const id of [
      "nimbus.auditView",
      "nimbus.egressView",
      "nimbus.agentsView",
      "nimbus.indexView",
      "nimbus.sessionsView",
      "nimbus.workflowsView",
    ]) {
      expect(views.find((v) => v.id === id)?.visibility).toBe("collapsed");
    }
  });
});
