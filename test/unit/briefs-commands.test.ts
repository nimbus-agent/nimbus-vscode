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
  /** Every prompt shown, in order — one entry per showInputBox call. */
  prompts: string[];
  /** The `value` (prefill) each showInputBox call was given, same order as prompts. */
  prefills: Array<string | undefined>;
  /** The `validateInput` each showInputBox call was given, same order as prompts. */
  validators: Array<((v: string) => string | undefined) | undefined>;
  /** The namespace last remembered, or undefined if nothing was ever remembered. */
  remembered(): string | undefined;
  /** When true, showErrorMessage answers "Retry" once, then reverts to dismissing. */
  retryOnce: boolean;
  /** Runs between the first failed send and the retry, so a test can prove the
   *  retry uses the ORIGINALLY resolved args rather than re-deriving them. */
  onFirstFailure?: () => void;
}

function harness(
  over: Partial<BriefCommandDeps> = {},
  fail?: Error,
  answers: Array<string | undefined> = [],
): Harness {
  const opened: Array<{ title: string; content: string }> = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const actions: string[] = [];
  const calls: Array<{ brief: string; params: unknown; meta: unknown }> = [];
  const prompts: string[] = [];
  const prefills: Array<string | undefined> = [];
  const validators: Array<((v: string) => string | undefined) | undefined> = [];
  const pendingAnswers: Array<string | undefined> = [...answers];
  let remembered: string | undefined;
  let offeredRetry = false;

  // Shared across every brief the harness stubs. The first call throws `fail` —
  // running onFirstFailure first, so a test can mutate ambient state (e.g. move
  // the cursor) between the failure and the retry — then clears it, so a retry
  // succeeds. This is independent of `h.retryOnce`, which only controls whether
  // showErrorMessage actually offers a retry to take.
  let activeFail = fail;
  const record =
    (brief: string, result: unknown) =>
    async (params: unknown, meta: unknown): Promise<unknown> => {
      calls.push({ brief, params, meta });
      if (activeFail !== undefined) {
        const err = activeFail;
        activeFail = undefined;
        h.onFirstFailure?.();
        throw err;
      }
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
        janitor: record("janitor", {
          ...BASE,
          kind: "janitor",
          query: { resourceRef: "svc/legacy", idleDays: 90 },
          idle: true,
          proposalSuppressed: false,
          cleanupAction: null,
          peersClear: 0,
          peersTouched: [],
        }),
        preflight: record("preflight", {
          ...BASE,
          kind: "preflight",
          query: { ref: "release-1.4", namespace: "billing" },
          downstreams: [],
          anyFailed: false,
          anyIncomplete: false,
        }),
      }) as never,
    activeEditor: () => ({
      document: {
        getText: () => "",
        fileName: "/home/dev/proj/src/a.ts",
        languageId: "ts",
        uri: { scheme: "file" },
      },
      selection: { isEmpty: true, active: { line: 6 }, start: { line: 6 }, end: { line: 6 } },
    }),
    roots: () => ["/home/dev/proj"],
    now: () => 1_000_000,
    openReadonly: async (title, content) => {
      opened.push({ title, content });
    },
    namespaces: {
      recall: () => remembered,
      remember: async (_folder: string | undefined, ns: string) => {
        remembered = ns;
      },
    },
    defaultNamespace: () => "from-setting",
    window: {
      showErrorMessage: async (msg: string, _o?: unknown, ...items: string[]) => {
        errors.push(msg);
        actions.push(...items);
        if (h.retryOnce && !offeredRetry) {
          offeredRetry = true;
          return "Retry";
        }
        return undefined;
      },
      showInformationMessage: async (msg: string) => {
        infos.push(msg);
        return undefined;
      },
      showInputBox: async (opts?: {
        prompt?: string;
        value?: string;
        validateInput?: (v: string) => string | undefined;
      }) => {
        prompts.push(opts?.prompt ?? "");
        prefills.push(opts?.value);
        validators.push(opts?.validateInput);
        return pendingAnswers.shift();
      },
    } as never,
    log: silentLog,
    ...over,
  };

  const h: Harness = {
    deps,
    opened,
    errors,
    infos,
    actions,
    calls,
    prompts,
    prefills,
    validators,
    remembered: () => remembered,
    retryOnce: false,
  };
  return h;
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
    const sent = h.calls[0]?.meta as { files: Array<{ name: string }> } | undefined;
    expect(sent?.files[0]?.name).toBe("src/a.ts:7");
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

  test("a post-send failure does not report the brief as failed", async () => {
    const logErrors: string[] = [];
    const h = harness({
      log: {
        error: (m: string) => logErrors.push(m),
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      } as unknown as Logger,
      openReadonly: async () => {
        throw new Error("tab failed to open");
      },
    });
    await createBriefCommands(h.deps).why();
    // The send itself succeeded — this must not look like a send failure: no
    // "failed" message, no Retry offered (a retry here would re-send an
    // already-successful brief). The failure is logged instead.
    expect(h.errors).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(logErrors[0]).toContain("tab failed to open");
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

describe("janitor", () => {
  test("sends the prompted resource ref and idle days", async () => {
    const h = harness({}, undefined, ["svc/legacy", "30"]);
    await createBriefCommands(h.deps).janitor();
    expect(h.calls[0]?.brief).toBe("janitor");
    expect(h.calls[0]?.params).toEqual({ resourceRef: "svc/legacy", idleDays: 30 });
  });

  test("a blank idleDays omits the parameter", async () => {
    const h = harness({}, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    expect(h.calls[0]?.params).toEqual({ resourceRef: "svc/legacy" });
  });

  test("the resource prompt prefills the active editor's relative ref", async () => {
    const h = harness({}, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    expect(h.prefills[0]).toBe("src/a.ts");
  });

  test("no editor means no prefill, not a crash", async () => {
    const h = harness({ activeEditor: () => undefined }, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    expect(h.prefills[0]).toBeUndefined();
    expect(h.calls[0]?.params).toEqual({ resourceRef: "svc/legacy" });
  });

  test("dismissing the first prompt sends nothing and shows no error", async () => {
    const h = harness({}, undefined, [undefined]);
    await createBriefCommands(h.deps).janitor();
    expect(h.calls).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  // showInputBox returns undefined for Escape and "" for Enter-on-blank. Those
  // mean opposite things here, and collapsing them would send a brief the user
  // was trying to cancel — with no modal to catch it if they ticked
  // "Always send Agent Briefs here".
  test("escaping the idle-days prompt cancels instead of sending the default", async () => {
    const h = harness({}, undefined, ["svc/legacy", undefined]);
    await createBriefCommands(h.deps).janitor();
    expect(h.calls).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  test("idleDays rejects anything that is not a positive whole number", async () => {
    const h = harness({}, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    const validate = h.validators[1];
    expect(validate?.("")).toBeUndefined();
    expect(validate?.("30")).toBeUndefined();
    expect(validate?.("-5")).toBeTypeOf("string");
    expect(validate?.("2.5")).toBeTypeOf("string");
    expect(validate?.("0")).toBeTypeOf("string");
    expect(validate?.("abc")).toBeTypeOf("string");
  });

  test("idleDays rejects a digit string too long to be a safe integer", async () => {
    const h = harness({}, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    const validate = h.validators[1];
    // Matches POSITIVE_INT (all digits, no leading zero) but Number() of it
    // loses precision — must not be forwarded to the IPC payload.
    expect(validate?.("99999999999999999999")).toBeTypeOf("string");
  });

  test("the manifest names the resource, not a file path", async () => {
    const h = harness({}, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    expect(h.calls[0]?.meta).toEqual({
      action: "Is this idle? (agents.janitor)",
      files: [
        { name: "svc/legacy", note: "the extension sends this path, not the file's contents" },
      ],
      omissions: [],
    });
  });
});

describe("preflight", () => {
  test("sends the prompted ref and namespace", async () => {
    const h = harness({}, undefined, ["release-1.4", "billing"]);
    await createBriefCommands(h.deps).preflight();
    expect(h.calls[0]?.params).toEqual({ ref: "release-1.4", namespace: "billing" });
  });

  test("an empty namespace cancels rather than sending a guess", async () => {
    const h = harness({}, undefined, ["release-1.4", ""]);
    await createBriefCommands(h.deps).preflight();
    expect(h.calls).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  test("the namespace prompt prefills the setting when nothing is remembered", async () => {
    const h = harness({}, undefined, ["release-1.4", "billing"]);
    await createBriefCommands(h.deps).preflight();
    expect(h.prefills[1]).toBe("from-setting");
  });

  test("a remembered namespace beats the setting", async () => {
    const h = harness(
      { namespaces: { recall: () => "remembered-ns", remember: async () => undefined } },
      undefined,
      ["release-1.4", "billing"],
    );
    await createBriefCommands(h.deps).preflight();
    expect(h.prefills[1]).toBe("remembered-ns");
  });

  test("the namespace is remembered only after the send succeeds", async () => {
    const failed = harness({}, new Error("gateway down"), ["release-1.4", "billing"]);
    await createBriefCommands(failed.deps).preflight();
    expect(failed.remembered()).toBeUndefined();

    const ok = harness({}, undefined, ["release-1.4", "billing"]);
    await createBriefCommands(ok.deps).preflight();
    expect(ok.remembered()).toBe("billing");
  });
});

describe("retry", () => {
  // The parent design promises Retry "re-runs the command with the same
  // pre-resolved args, so nothing is re-prompted for". Prompting inside the
  // retry wrapper would make a user re-answer to retry a send they already
  // authorised.
  test("retrying a failed preflight re-sends without re-prompting", async () => {
    const h = harness({}, new Error("gateway down"), ["release-1.4", "billing"]);
    h.retryOnce = true;
    await createBriefCommands(h.deps).preflight();
    expect(h.prompts).toHaveLength(2);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.params).toEqual({ ref: "release-1.4", namespace: "billing" });
  });

  test("retrying why answers about the line it originally resolved", async () => {
    let line = 6;
    const h = harness(
      {
        activeEditor: () => ({
          document: {
            getText: () => "",
            fileName: "/home/dev/proj/src/a.ts",
            languageId: "ts",
            uri: { scheme: "file" },
          },
          selection: { isEmpty: true, active: { line }, start: { line }, end: { line } },
        }),
      },
      new Error("gateway down"),
    );
    h.retryOnce = true;
    h.onFirstFailure = () => {
      line = 40;
    };
    await createBriefCommands(h.deps).why();
    expect(h.calls[1]?.params).toEqual({ ref: "src/a.ts", line: 7 });
  });
});
