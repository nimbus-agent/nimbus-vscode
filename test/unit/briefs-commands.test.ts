import { describe, expect, test } from "vitest";

import { type BriefCommandDeps, createBriefCommands } from "../../src/briefs/commands.js";
import { EgressCancelled } from "../../src/egress/gated-client.js";
import type { Logger } from "../../src/logging.js";

const silentLog: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const BASE = { agentVersion: 1, generatedAt: 0, latencyMs: 1, gaps: [] };

interface Harness {
  deps: BriefCommandDeps;
  opened: Array<{ title: string; content: string }>;
  errors: string[];
  infos: string[];
  actions: string[];
  calls: Array<{ brief: string; params: unknown; meta: unknown }>;
}

function harness(over: Partial<BriefCommandDeps> = {}, fail?: Error): Harness {
  const opened: Array<{ title: string; content: string }> = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const actions: string[] = [];
  const calls: Array<{ brief: string; params: unknown; meta: unknown }> = [];

  const record =
    (brief: string, result: unknown) =>
    async (params: unknown, meta: unknown): Promise<unknown> => {
      calls.push({ brief, params, meta });
      if (fail !== undefined) throw fail;
      return result;
    };

  const deps: BriefCommandDeps = {
    briefs: () =>
      ({
        why: record("why", {
          ...BASE,
          kind: "why",
          query: { ref: "src/a.ts", line: 7 },
          subject: null,
          findings: [],
        }),
        ghost: record("ghost", {
          ...BASE,
          kind: "ghost",
          query: { file: "src/a.ts" },
          startEntityId: null,
          findings: [],
        }),
        conflicts: record("conflicts", {
          ...BASE,
          kind: "conflict",
          query: { file: "src/a.ts" },
          startEntityId: null,
          collisions: [],
        }),
        huddle: record("huddle", {
          ...BASE,
          kind: "huddle",
          query: { sinceMs: 1 },
          contributions: [],
        }),
      }) as never,
    activeEditor: () => ({
      document: { getText: () => "", fileName: "/home/dev/proj/src/a.ts", languageId: "ts" },
      selection: { isEmpty: true, active: { line: 6 } },
    }),
    roots: () => ["/home/dev/proj"],
    now: () => 1_000_000,
    openReadonly: async (title, content) => {
      opened.push({ title, content });
    },
    window: {
      showErrorMessage: async (msg: string, _o?: unknown, ...items: string[]) => {
        errors.push(msg);
        actions.push(...items);
        return undefined;
      },
      showInformationMessage: async (msg: string) => {
        infos.push(msg);
        return undefined;
      },
    } as never,
    log: silentLog,
    ...over,
  };
  return { deps, opened, errors, infos, actions, calls };
}

describe("brief commands", () => {
  // The fixture editor's cursor sits on active.line 6 (VS Code, 0-based), which
  // is line 7 in the gutter and therefore line 7 on the wire.
  test("why reads the cursor line and sends a repo-relative, 1-based ref", async () => {
    const h = harness();
    await createBriefCommands(h.deps).why();
    expect(h.calls[0]?.brief).toBe("why");
    expect(h.calls[0]?.params).toEqual({ ref: "src/a.ts", line: 7 });
  });

  test("the manifest names the same line the params carry", async () => {
    const h = harness();
    await createBriefCommands(h.deps).why();
    const files = (h.calls[0]?.meta as { files: Array<{ name: string }> }).files;
    expect(files[0]?.name).toBe("src/a.ts:7");
  });

  test("why prefers pre-resolved args over the active editor", async () => {
    const h = harness();
    await createBriefCommands(h.deps).why({ ref: "src/other.ts", line: 99 });
    expect(h.calls[0]?.params).toEqual({ ref: "src/other.ts", line: 100 });
  });

  test("the manifest names the path and says contents are not sent", async () => {
    const h = harness();
    await createBriefCommands(h.deps).ghost();
    expect(h.calls[0]?.meta).toEqual({
      action: "Who knew this code? (agents.ghost)",
      files: [{ name: "src/a.ts", note: "the extension sends this path, not the file's contents" }],
      omissions: [],
    });
  });

  test("huddle needs no editor and sends no files", async () => {
    const h = harness({ activeEditor: () => undefined });
    await createBriefCommands(h.deps).huddle();
    expect(h.calls[0]?.brief).toBe("huddle");
    expect(h.calls[0]?.meta).toEqual({
      action: "Team huddle (agents.huddle)",
      files: [],
      omissions: [],
    });
  });

  test("a file-scoped brief without an editor tells the user instead of throwing", async () => {
    const h = harness({ activeEditor: () => undefined });
    await createBriefCommands(h.deps).conflicts();
    expect(h.calls).toEqual([]);
    expect(h.infos[0]).toContain("Open a file");
  });

  test("a disconnected client is reported, not thrown", async () => {
    const h = harness({ briefs: () => undefined });
    await createBriefCommands(h.deps).why();
    expect(h.errors[0]).toContain("not connected");
  });

  test("the result opens in a read-only tab named for the brief", async () => {
    const h = harness();
    await createBriefCommands(h.deps).conflicts();
    expect(h.opened[0]?.title).toBe("Nimbus — Who else is touching this?.md");
    expect(h.opened[0]?.content).toContain("Nobody else is touching `src/a.ts`");
  });

  test("cancelling at the gate is silent", async () => {
    const h = harness({}, new EgressCancelled());
    await createBriefCommands(h.deps).why();
    expect(h.errors).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test("a failure surfaces the message verbatim and offers Retry", async () => {
    const h = harness({}, new Error("gateway: no index for that repo"));
    await createBriefCommands(h.deps).why();
    expect(h.errors[0]).toContain("gateway: no index for that repo");
    expect(h.actions).toContain("Retry");
  });

  test("Retry re-runs with the same resolved args, so nothing is re-derived", async () => {
    const seen: unknown[] = [];
    let attempts = 0;
    // Answer "Retry" once, then dismiss, so the recursion terminates.
    const h = harness({
      window: {
        showErrorMessage: async (_m: string, _o?: unknown, ...items: string[]) =>
          items.includes("Retry") && attempts < 2 ? "Retry" : undefined,
        showInformationMessage: async () => undefined,
      } as never,
      briefs: () =>
        ({
          why: async (params: unknown) => {
            attempts += 1;
            seen.push(params);
            throw new Error("boom");
          },
        }) as never,
    });
    await createBriefCommands(h.deps).why({ ref: "src/a.ts", line: 3 });
    expect(attempts).toBe(2);
    expect(seen).toEqual([
      { ref: "src/a.ts", line: 4 },
      { ref: "src/a.ts", line: 4 },
    ]);
  });
});
