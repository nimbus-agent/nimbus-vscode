import { describe, expect, test } from "vitest";

import { createEgressGate, type EgressGateDeps } from "../../src/egress/gate.js";
import type { EgressMeta } from "../../src/egress/preflight.js";
import { createPreflightSkipStore } from "../../src/egress/skip-store.js";
import type { MementoLike } from "../../src/vscode-shim.js";

class FakeMemento implements MementoLike {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

interface Shown {
  message: string;
  modal: boolean;
  detail: string | undefined;
  items: string[];
}

function harness(opts: { answers?: (string | undefined)[]; trusted?: boolean } = {}) {
  const shown: Shown[] = [];
  const opened: { title: string; content: string }[] = [];
  const logs: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const deps: EgressGateDeps = {
    window: {
      showWarningMessage: async (
        message: string,
        o?: { modal?: boolean; detail?: string },
        ...items: string[]
      ) => {
        shown.push({ message, modal: o?.modal === true, detail: o?.detail, items });
        return answers.shift();
      },
    },
    openReadonly: async (title, content) => {
      opened.push({ title, content });
    },
    skips: createPreflightSkipStore(new FakeMemento()),
    isTrusted: () => opts.trusted !== false,
    roots: () => ["C:\\gitrep\\nimbus"],
    log: {
      error: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      info: (m) => logs.push(m),
      debug: (m) => logs.push(m),
    },
  };
  return { gate: createEgressGate(deps), deps, shown, opened, logs };
}

const META: EgressMeta = {
  action: "Review Changes",
  files: [{ name: "a.ts", note: "staged" }],
  omissions: [],
};

describe("pass-through kinds", () => {
  for (const kind of ["ask", "participant", "lmTool"] as const) {
    test(`${kind} sends without prompting`, async () => {
      const h = harness();
      expect(await h.gate.check(kind, "hello", META)).toBe("send");
      expect(h.shown).toEqual([]);
    });
  }

  test("record stores the payload without prompting", () => {
    const h = harness();
    h.gate.record("ask", "hello", { action: "Ask", files: [], omissions: [] });
    expect(h.shown).toEqual([]);
    expect(h.gate.lastPayload()?.prompt).toBe("hello");
  });

  test("the gate fills roots so no call site can forget them", () => {
    const h = harness();
    h.gate.record("ask", "hello", { action: "Ask", files: [], omissions: [] });
    expect(h.gate.lastPayload()?.roots).toEqual(["C:\\gitrep\\nimbus"]);
  });
});

describe("prompting kinds", () => {
  test("Send returns send", async () => {
    const h = harness({ answers: ["Send"] });
    expect(await h.gate.check("scm", "diff", META)).toBe("send");
    expect(h.shown[0]?.modal).toBe(true);
  });

  test("the modal carries the summary as its detail", async () => {
    const h = harness({ answers: ["Send"] });
    await h.gate.check("scm", "diff", META);
    expect(h.shown[0]?.detail).toContain("Review Changes");
    expect(h.shown[0]?.detail).toContain("a.ts — staged");
  });

  test("dismissing the modal cancels", async () => {
    const h = harness({ answers: [undefined] });
    expect(await h.gate.check("scm", "diff", META)).toBe("cancel");
  });

  test("Always send sets the skip and sends", async () => {
    const h = harness({ answers: ["Always send Source Control here"] });
    expect(await h.gate.check("scm", "diff", META)).toBe("send");
    expect(h.deps.skips.isSkipped("scm")).toBe(true);
  });

  test("a set skip sends without prompting", async () => {
    const h = harness({ answers: [] });
    await h.deps.skips.setSkipped("scm");
    expect(await h.gate.check("scm", "diff", META)).toBe("send");
    expect(h.shown).toEqual([]);
  });

  test("a skip on one surface does not disarm the other", async () => {
    const h = harness({ answers: [undefined] });
    await h.deps.skips.setSkipped("quickAsk");
    expect(await h.gate.check("scm", "diff", META)).toBe("cancel");
    expect(h.shown).toHaveLength(1);
  });
});

describe("Show full text", () => {
  test("opens the tab, then re-asks with a NON-modal notification", async () => {
    const h = harness({ answers: ["Show full text", "Send"] });
    expect(await h.gate.check("scm", "EXACT BYTES", META)).toBe("send");
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.content).toContain("EXACT BYTES");
    expect(h.shown[0]?.modal).toBe(true);
    // A modal here would block the workbench and leave the user unable to
    // read the tab they just asked for.
    expect(h.shown[1]?.modal).toBe(false);
  });

  test("dismissing the second prompt cancels", async () => {
    const h = harness({ answers: ["Show full text", undefined] });
    expect(await h.gate.check("scm", "diff", META)).toBe("cancel");
  });

  test("choosing Cancel on the second prompt cancels", async () => {
    const h = harness({ answers: ["Show full text", "Cancel"] });
    expect(await h.gate.check("scm", "diff", META)).toBe("cancel");
  });
});

describe("Restricted Mode", () => {
  test("prompts even when the surface is skipped", async () => {
    const h = harness({ answers: [undefined], trusted: false });
    await h.deps.skips.setSkipped("scm");
    expect(await h.gate.check("scm", "diff", META)).toBe("cancel");
    expect(h.shown).toHaveLength(1);
  });

  test("offers no Always send button, which would be ignored anyway", async () => {
    const h = harness({ answers: [undefined], trusted: false });
    await h.gate.check("scm", "diff", META);
    expect(h.shown[0]?.items).toEqual(["Send", "Show full text"]);
  });
});

describe("the brief kind", () => {
  const BRIEF_META: EgressMeta = {
    action: "Why is this here? (agents.why)",
    files: [
      { name: "src/a.ts:42", note: "the extension sends this path, not the file's contents" },
    ],
    omissions: [],
  };

  test("prompts, like the other context-assembling surfaces", async () => {
    const h = harness({ answers: ["Send"] });
    const decision = await h.gate.check("brief", '{"ref":"src/a.ts","line":42}', BRIEF_META);
    expect(decision).toBe("send");
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.modal).toBe(true);
  });

  test("offers an Always-send button labelled for the surface", async () => {
    const h = harness({ answers: ["Always send Agent Briefs here"] });
    expect(await h.gate.check("brief", "{}", BRIEF_META)).toBe("send");
    expect(h.deps.skips.isSkipped("brief")).toBe(true);
  });

  test("a stored skip suppresses the modal", async () => {
    const h = harness({ answers: ["Send"] });
    await h.deps.skips.setSkipped("brief");
    expect(await h.gate.check("brief", "{}", BRIEF_META)).toBe("send");
    expect(h.shown).toEqual([]);
  });

  test("fails closed when the modal is dismissed", async () => {
    const h = harness({ answers: [undefined] });
    expect(await h.gate.check("brief", "{}", BRIEF_META)).toBe("cancel");
  });

  test("Restricted Mode ignores a stored skip and withholds the Always button", async () => {
    const h = harness({ answers: ["Send"], trusted: false });
    await h.deps.skips.setSkipped("brief");
    expect(await h.gate.check("brief", "{}", BRIEF_META)).toBe("send");
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.items).not.toContain("Always send Agent Briefs here");
  });
});
