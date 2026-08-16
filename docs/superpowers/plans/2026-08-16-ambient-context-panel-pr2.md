# Ambient Context Panel — PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the context panel its two Gateway-backed signals — blame for the
cursor line and ranked related items for the file — and the cadence machinery
that keeps them from costing an RPC per keystroke.

**Architecture:** The signal contract becomes asynchronous and dependency-taking,
so a collector can reach the Gateway. A new pure `controller.ts` owns everything
that makes that affordable: an LRU cache keyed per signal, in-flight coalescing,
a generation fence, and invalidation on save, git change, disconnect and
reconnect. Sections stop being posted as one batch — each collector posts its own
as it resolves, so the panel never waits on the slowest RPC.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Vitest,
esbuild, Biome, VS Code extension API, `@nimbus-dev/client`.

**Spec:** `docs/superpowers/specs/2026-08-16-ambient-context-panel-design.md`
(read it alongside this plan). PR 1 shipped in #109; its plan is
`docs/superpowers/plans/2026-08-16-ambient-context-panel-pr1.md`.

## Global Constraints

- **No `any`.** External/untrusted data is `unknown` and narrowed. Biome enforces
  `noExplicitAny`, `noNonNullAssertion`, and `noConsole` in `src/`.
- **Log through the output channel** (`src/logging.ts`), never `console`.
- **`exactOptionalPropertyTypes` is on.** Never assign `undefined` to an optional
  (`?`) field — use a conditional spread. A required field typed `T | undefined`
  may hold `undefined`.
- **Relative imports carry the `.js` extension**; type-only imports use
  `import type`.
- **`vscode` is reached only through `src/vscode-shim.ts` or a dedicated
  `real-*.ts` glue file.** In `src/context/` that file is `real-context-view.ts`
  and no other file there may import `vscode`.
- **`src/context/` must never name `agentInvoke` or `askStream`.**
  `test/unit/egress-choke-point.test.ts` enforces this repo-wide.
- **Comments must not spell a dotted `agents*` call followed by a paren.** That
  same test scans comments; write `agents*` in prose.
- **Both new RPCs reach no model and stay ungated.** `agentsWhyPeek` is the
  documented gate exemption and the choke-point test keys on the method name
  across all of `src/`, so a second caller passes unchanged. `searchRanked` has
  the same posture as *Find related*. Neither may route through
  `src/egress/gated-client.ts`, and the `EgressKind` count stays at eight.
- **Never construct a `NimbusClient` in `src/context/`.** Collectors take a
  narrow structural client seam, the way every other pure module in this repo
  does.
- **Verification gate** before claiming done: `bun run test`,
  `bun run typecheck`, `bun run lint`, `bun run build`, `bun run check-bundle`,
  `bun run check-vsix-contents`, `bun run check-settings-docs`.
- **Commit messages are Conventional Commits** — the repo squash-merges and
  Release Please reads the PR title.

**Not in this PR:** the `nimbus.context.enabled` setting, `docs/settings.md`, the
diagnostic and SCM action routes, branch pre-fill for the prompted briefs, and
the ExTester spec. Those are PR 3. PR 1's `CLAUDE.md` / README / ROADMAP entries
landed in #111 and will need a second pass once this PR changes what the panel
shows.

**Known outstanding from PR 1:** the Extension Development Host pass has never
been run. Task 8 ends with it, and its checklist has grown — see that task.

---

### Task 1: Split `peek.ts` into fields and markdown

**Files:**
- Modify: `src/briefs/peek.ts`
- Test: `test/unit/briefs-peek.test.ts` (extend)

**Interfaces:**
- Consumes: `WhyPeek` from `@nimbus-dev/client`; `formatRelativeTime` from
  `src/sidebar/relative-time.js`.
- Produces: `PeekFields` and `peekFields(peek: WhyPeek, now: number): PeekFields | undefined`.
  Task 3 renders blame rows from it. `renderPeek` keeps its exact current
  signature and behaviour — the hover must not change.

`renderPeek` today turns a `WhyPeek` into hover markdown containing a
`command:` link. The panel needs the same facts as data. Extract the field
derivation so there is one interpretation of a `WhyPeek` and two renderings.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/briefs-peek.test.ts`:

```ts
import { peekFields } from "../../src/briefs/peek.js";

const EMPTY = {
  subject: null,
  author: null,
  authorEmail: null,
  commitSha: null,
  committedAt: null,
  commitSubject: null,
  pr: null,
  ticket: null,
  hasMore: false,
};

describe("peekFields", () => {
  test("declines when nothing resolved", () => {
    expect(peekFields(EMPTY, 1_000)).toBeUndefined();
  });

  test("shortens the sha to seven characters", () => {
    const fields = peekFields({ ...EMPTY, commitSha: "abcdef1234567890" }, 1_000);
    expect(fields?.shortSha).toBe("abcdef1");
  });

  test("formats the commit time relative to now", () => {
    const fields = peekFields({ ...EMPTY, author: "Ada", committedAt: 0 }, 60_000);
    expect(fields?.author).toBe("Ada");
    expect(fields?.relativeTime).toBeDefined();
  });

  test("labels a PR by number and a ticket by key, carrying their urls", () => {
    const fields = peekFields(
      {
        ...EMPTY,
        pr: { number: 42, title: "t", url: "https://example.test/pr/42" },
        ticket: { key: "OPS-7", title: "t", url: null },
      },
      1_000,
    );
    expect(fields?.pr).toEqual({ label: "PR #42", url: "https://example.test/pr/42" });
    expect(fields?.ticket).toEqual({ label: "OPS-7" });
  });

  test("never exposes the author email — it is a personal identifier nobody asked to display", () => {
    const fields = peekFields({ ...EMPTY, author: "Ada", authorEmail: "ada@example.test" }, 1_000);
    expect(JSON.stringify(fields)).not.toContain("ada@example.test");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/briefs-peek.test.ts`
Expected: FAIL — `peekFields` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/briefs/peek.ts`, add above `renderPeek`:

```ts
/** A `WhyPeek` reduced to display-ready fields. No markup, no links. */
export interface PeekFields {
  readonly author: string | undefined;
  readonly relativeTime: string | undefined;
  readonly shortSha: string | undefined;
  readonly commitSubject: string | undefined;
  readonly pr: { readonly label: string; readonly url?: string } | undefined;
  readonly ticket: { readonly label: string; readonly url?: string } | undefined;
}

// One interpretation of a WhyPeek, two renderings: the hover's markdown below
// and the context panel's rows. authorEmail is deliberately absent — it is a
// personal identifier the user did not ask to put on screen, and the name
// already attributes the line.
export function peekFields(peek: WhyPeek, now: number): PeekFields | undefined {
  if (peek.author === null && peek.commitSha === null && peek.pr === null && peek.ticket === null) {
    return undefined;
  }
  return {
    author: peek.author ?? undefined,
    relativeTime: peek.committedAt === null ? undefined : formatRelativeTime(now, peek.committedAt),
    shortSha: peek.commitSha === null ? undefined : shortSha(peek.commitSha),
    commitSubject: peek.commitSubject ?? undefined,
    pr:
      peek.pr === null
        ? undefined
        : {
            label: `PR #${peek.pr.number ?? "?"}`,
            ...(peek.pr.url === null ? {} : { url: peek.pr.url }),
          },
    ticket:
      peek.ticket === null
        ? undefined
        : {
            label: peek.ticket.key,
            ...(peek.ticket.url === null ? {} : { url: peek.ticket.url }),
          },
  };
}
```

- [ ] **Step 4: Rewrite `renderPeek` over the extracted fields**

Replace the body of `renderPeek` with one that consumes `peekFields`, leaving its
signature and output identical:

```ts
export function renderPeek(peek: WhyPeek, target: EditorTarget, now: number): string | undefined {
  // Nothing resolved — decline the hover rather than render an empty box. This
  // is the common case until the repo root is indexed (`nimbus init`).
  const fields = peekFields(peek, now);
  if (fields === undefined) return undefined;

  const head: string[] = [];
  if (fields.author !== undefined) head.push(`**${fields.author}**`);
  if (fields.relativeTime !== undefined) head.push(fields.relativeTime);
  if (fields.shortSha !== undefined) head.push(`\`${fields.shortSha}\``);

  const lines: string[] = [];
  if (head.length > 0) lines.push(head.join(" · "));
  if (fields.commitSubject !== undefined) lines.push(fields.commitSubject);

  const refs: string[] = [];
  if (fields.pr !== undefined) {
    refs.push(fields.pr.url === undefined ? fields.pr.label : `[${fields.pr.label}](${fields.pr.url})`);
  }
  if (fields.ticket !== undefined) {
    refs.push(
      fields.ticket.url === undefined
        ? fields.ticket.label
        : `[${fields.ticket.label}](${fields.ticket.url})`,
    );
  }
  if (refs.length > 0) lines.push(refs.join(" · "));

  // subject.repoRoot is an absolute path on this machine; it is never rendered.
  lines.push(whyLink(target));
  return lines.join("\n\n");
}
```

- [ ] **Step 5: Run the peek tests**

Run: `bunx vitest run test/unit/briefs-peek.test.ts test/unit/briefs-peek-hover.test.ts`
Expected: PASS. The pre-existing `renderPeek` tests are the regression check that
the hover's output did not change — if any fails, the extraction changed
behaviour and must be corrected, not the test.

- [ ] **Step 6: Run the full suite and commit**

```bash
bun run test && bun run typecheck && bun run lint
git add src/briefs/peek.ts test/unit/briefs-peek.test.ts
git commit -m "refactor(briefs): extract peek fields from the hover markdown"
```

---

### Task 2: Make the signal contract async and dependency-taking

**Files:**
- Modify: `src/context/signals.ts`
- Modify: `src/context/real-context-view.ts` (collect call site only)
- Test: `test/unit/context-signals.test.ts`

**Interfaces:**
- Consumes: `ContextSnapshot` from `src/context/snapshot.js`.
- Produces: `ContextClientLike`, `SignalDeps`, and a `SignalSpec` whose
  `collect(snapshot, deps): Promise<SignalSection>` and
  `cacheKey(snapshot): string | undefined`. `SignalSection` gains
  `loading?: boolean`. Tasks 3-8 all build on these.

Today `collect(snapshot)` is synchronous and pure, which no Gateway-backed
collector can be. This task changes the contract with no new signals, so the
ripple is isolated and reviewable on its own.

- [ ] **Step 1: Write the failing test**

Replace the `SIGNAL_CATALOG` describe block in `test/unit/context-signals.test.ts`
with:

```ts
import type { SignalDeps } from "../../src/context/signals.js";

const noDeps: SignalDeps = {
  client: () => undefined,
  now: () => 0,
  searchLimit: () => 20,
};

describe("SIGNAL_CATALOG", () => {
  test("covers both local signals and claims no Gateway", () => {
    expect(SIGNAL_CATALOG.map((s) => s.id)).toEqual(["problems", "git"]);
    expect(SIGNAL_CATALOG.every((s) => s.needsGateway === false)).toBe(true);
  });

  test("each entry collects the section its id names", async () => {
    const snap = buildSnapshot({ generation: 8, editor });
    for (const spec of SIGNAL_CATALOG) {
      const section = await spec.collect(snap, noDeps);
      expect(section.id).toBe(spec.id);
    }
  });

  test("local signals declare no cache key — they are cheap and always recollected", () => {
    const snap = buildSnapshot({ generation: 9, editor });
    for (const spec of SIGNAL_CATALOG) expect(spec.cacheKey(snap)).toBeUndefined();
  });
});
```

Also change the direct collector assertions in that file to await, e.g.
`expect((await problemsSection(snap, noDeps)).rows.map((r) => r.label))`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-signals.test.ts`
Expected: FAIL — `SignalDeps` is not exported and `collect` takes one argument.

- [ ] **Step 3: Write the implementation**

In `src/context/signals.ts`, add the seam types above `SignalSpec`:

```ts
import type { RankedSearchItem, WhyPeek } from "@nimbus-dev/client";

/**
 * The two Gateway calls this panel makes, and nothing else. A narrow structural
 * seam rather than the whole client: these modules stay pure and unit-testable,
 * and the surface a collector can reach is visible in one place. Both calls
 * reach no model — see the plan's Global Constraints.
 */
export interface ContextClientLike {
  agentsWhyPeek(p: { ref: string; line?: number }): Promise<WhyPeek>;
  searchRanked(params?: {
    name?: string;
    limit?: number;
  }): Promise<readonly RankedSearchItem[]>;
}

export interface SignalDeps {
  /** Undefined while disconnected; Gateway-backed collectors then sit out. */
  readonly client: () => ContextClientLike | undefined;
  readonly now: () => number;
  readonly searchLimit: () => number;
}
```

Give `SignalSection` a loading flag:

```ts
  /** True while a Gateway-backed collector is still in flight. */
  readonly loading?: boolean;
```

Change `SignalSpec` and make both existing collectors async:

```ts
export interface SignalSpec {
  readonly id: SignalId;
  /** Whether collecting this signal needs the Gateway socket. */
  readonly needsGateway: boolean;
  readonly collect: (snapshot: ContextSnapshot, deps: SignalDeps) => Promise<SignalSection>;
  /**
   * What a cached result for this snapshot would be keyed on, or undefined when
   * the signal is not worth caching. Local reads return undefined: they cost
   * nothing, and a cache would only add a way to be stale.
   */
  readonly cacheKey: (snapshot: ContextSnapshot) => string | undefined;
}
```

Mark `problemsSection` and `gitSection` `async` (their bodies are unchanged —
each takes `snapshot` and now also an unused `_deps: SignalDeps`), and update the
catalog:

```ts
export const SIGNAL_CATALOG: readonly SignalSpec[] = [
  { id: "problems", needsGateway: false, collect: problemsSection, cacheKey: () => undefined },
  { id: "git", needsGateway: false, collect: gitSection, cacheKey: () => undefined },
];
```

- [ ] **Step 4: Update the one call site**

In `src/context/real-context-view.ts`, the `postMessage` call currently maps
`SIGNAL_CATALOG` synchronously. Replace that argument with an awaited collect,
building the deps inline for now — Task 8 replaces this whole path with the
controller:

```ts
    const sections = await Promise.all(
      SIGNAL_CATALOG.map((spec) =>
        spec.collect(snapshot, { client: () => undefined, now: Date.now, searchLimit: () => 20 }),
      ),
    );
    if (mine !== generation || view === undefined) return;
    void view.webview.postMessage({
      type: "render",
      generation: mine,
      sections,
      offers: offersFor(snapshot),
      isDirty: snapshot.isDirty,
    });
```

- [ ] **Step 5: Run the tests and commit**

```bash
bunx vitest run test/unit/context-signals.test.ts
bun run test && bun run typecheck && bun run lint
git add src/context/signals.ts src/context/real-context-view.ts test/unit/context-signals.test.ts
git commit -m "refactor(context): make signal collection async and dependency-taking"
```

---

### Task 3: The blame signal

**Files:**
- Modify: `src/context/signals.ts`
- Test: `test/unit/context-signals-blame.test.ts`

**Interfaces:**
- Consumes: `ContextClientLike`, `SignalDeps`, `SignalSection` (Task 2);
  `peekFields` (Task 1).
- Produces: `blameSection(snapshot, deps): Promise<SignalSection>` and a
  `"blame"` member of `SignalId`, registered in `SIGNAL_CATALOG`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-signals-blame.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { blameSection, type ContextClientLike, type SignalDeps } from "../../src/context/signals.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 41,
  selection: "",
  isDirty: false,
};

const PEEK = {
  subject: null,
  author: "Ada",
  authorEmail: "ada@example.test",
  commitSha: "abcdef1234567890",
  committedAt: 0,
  commitSubject: "fix: the thing",
  pr: { number: 42, title: "t", url: "https://example.test/pr/42" },
  ticket: null,
  hasMore: false,
};

function deps(client: ContextClientLike | undefined): SignalDeps {
  return { client: () => client, now: () => 60_000, searchLimit: () => 20 };
}

const stub = (peek: unknown): ContextClientLike => ({
  agentsWhyPeek: async () => peek as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
  searchRanked: async () => [],
});

describe("blameSection", () => {
  test("renders author, subject and PR for the cursor line", async () => {
    const section = await blameSection(buildSnapshot({ generation: 1, editor }), deps(stub(PEEK)));
    const labels = section.rows.map((r) => r.label);
    expect(labels.some((l) => l.includes("Ada"))).toBe(true);
    expect(labels).toContain("fix: the thing");
    expect(labels).toContain("PR #42");
  });

  test("never renders the author email", async () => {
    const section = await blameSection(buildSnapshot({ generation: 2, editor }), deps(stub(PEEK)));
    expect(JSON.stringify(section)).not.toContain("ada@example.test");
  });

  test("asks the Gateway about the cursor line, by repo-relative ref", async () => {
    const seen: Array<{ ref: string; line?: number }> = [];
    const client: ContextClientLike = {
      agentsWhyPeek: async (p) => {
        seen.push(p);
        return PEEK as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>;
      },
      searchRanked: async () => [],
    };
    await blameSection(buildSnapshot({ generation: 3, editor }), deps(client));
    expect(seen).toEqual([{ ref: "src/a.ts", line: 41 }]);
  });

  test("says so when the repo is not indexed yet, rather than showing an empty box", async () => {
    const empty = { ...PEEK, author: null, commitSha: null, commitSubject: null, pr: null };
    const section = await blameSection(buildSnapshot({ generation: 4, editor }), deps(stub(empty)));
    expect(section.rows).toEqual([]);
    expect(section.empty).toBe("No history for this line yet — has `nimbus init` indexed this repo?");
  });

  test("sits out while disconnected instead of failing", async () => {
    const section = await blameSection(buildSnapshot({ generation: 5, editor }), deps(undefined));
    expect(section.empty).toBe("Needs the Nimbus Gateway.");
  });

  test("says so when there is no file", async () => {
    const section = await blameSection(buildSnapshot({ generation: 6 }), deps(stub(PEEK)));
    expect(section.empty).toBe("No file open.");
  });

  test("reports a failed lookup as an error row rather than throwing", async () => {
    const client: ContextClientLike = {
      agentsWhyPeek: async () => {
        throw new Error("socket closed");
      },
      searchRanked: async () => [],
    };
    const section = await blameSection(buildSnapshot({ generation: 7, editor }), deps(client));
    expect(section.rows[0]?.label).toContain("socket closed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-signals-blame.test.ts`
Expected: FAIL — `blameSection` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/context/signals.ts`, widen the id union to
`"problems" | "git" | "blame" | "related"` and add:

```ts
import { peekFields } from "../briefs/peek.js";
import { errMsg } from "../logging.js";

// Blame for the cursor line. This call reaches no model — it is a synchronous
// git-and-index lookup — which is why it is safe on every cursor rest and why
// it is the documented exemption from the egress gate.
export async function blameSection(
  snapshot: ContextSnapshot,
  deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "blame" as const, title: "History" };
  if (snapshot.path === undefined || snapshot.line === undefined) {
    return { ...base, rows: [], empty: "No file open." };
  }
  const client = deps.client();
  if (client === undefined) return { ...base, rows: [], empty: "Needs the Nimbus Gateway." };
  try {
    const peek = await client.agentsWhyPeek({ ref: snapshot.path, line: snapshot.line });
    const fields = peekFields(peek, deps.now());
    if (fields === undefined) {
      return {
        ...base,
        rows: [],
        empty: "No history for this line yet — has `nimbus init` indexed this repo?",
      };
    }
    const head = [fields.author, fields.relativeTime, fields.shortSha].filter(
      (part): part is string => part !== undefined,
    );
    const rows: SignalRow[] = [];
    if (head.length > 0) rows.push({ label: head.join(" · "), iconId: "person" });
    if (fields.commitSubject !== undefined) {
      rows.push({ label: fields.commitSubject, iconId: "git-commit" });
    }
    // Labels only, no links: this panel's renderer emits text nodes, and adding
    // anchors would widen what the webview may contain for one row.
    if (fields.pr !== undefined) rows.push({ label: fields.pr.label, iconId: "git-pull-request" });
    if (fields.ticket !== undefined) rows.push({ label: fields.ticket.label, iconId: "tag" });
    return { ...base, rows };
  } catch (e: unknown) {
    return { ...base, rows: [{ label: `Blame unavailable: ${errMsg(e)}`, iconId: "error" }] };
  }
}
```

Register it in `SIGNAL_CATALOG`, after `git`:

```ts
  {
    id: "blame",
    needsGateway: true,
    collect: blameSection,
    // Keyed on the line, so moving WITHIN a line — or scrolling, which fires no
    // cursor event at all — costs nothing.
    cacheKey: (s) => (s.path === undefined || s.line === undefined ? undefined : `${s.path}:${s.line}`),
  },
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run test/unit/context-signals-blame.test.ts test/unit/context-signals.test.ts`
Expected: PASS. Update the `SIGNAL_CATALOG` id assertion in
`context-signals.test.ts` to `["problems", "git", "blame"]` and its
`needsGateway` assertion to expect false only for the two local signals.

- [ ] **Step 5: Commit**

```bash
bun run test && bun run typecheck && bun run lint
git add src/context/signals.ts test/unit/context-signals-blame.test.ts test/unit/context-signals.test.ts
git commit -m "feat(context): show who last touched the line under the cursor"
```

---

### Task 4: The related-items signal

**Files:**
- Modify: `src/context/signals.ts`
- Test: `test/unit/context-signals-related.test.ts`

**Interfaces:**
- Consumes: `ContextClientLike`, `SignalDeps`, `SignalSection` (Task 2).
- Produces: `relatedSection(snapshot, deps): Promise<SignalSection>` and a
  `"related"` entry in `SIGNAL_CATALOG`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-signals-related.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  type ContextClientLike,
  relatedSection,
  type SignalDeps,
} from "../../src/context/signals.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 0,
  selection: "",
  isDirty: false,
};

type Item = Awaited<ReturnType<ContextClientLike["searchRanked"]>>[number];

const item = (name: string, service: string): Item =>
  ({ name, service, indexPrimaryKey: `${service}:${name}`, score: 1 }) as unknown as Item;

function deps(client: ContextClientLike | undefined, limit = 5): SignalDeps {
  return { client: () => client, now: () => 0, searchLimit: () => limit };
}

const stub = (items: readonly Item[], seen?: Array<Record<string, unknown>>): ContextClientLike => ({
  agentsWhyPeek: async () => ({}) as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
  searchRanked: async (params) => {
    if (seen !== undefined && params !== undefined) seen.push(params);
    return items;
  },
});

describe("relatedSection", () => {
  test("lists ranked neighbours with their service", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 1, editor }),
      deps(stub([item("b.ts", "github")])),
    );
    expect(section.rows[0]?.label).toBe("b.ts");
    expect(section.rows[0]?.detail).toBe("github");
  });

  test("excludes the file itself — it is not its own neighbour", async () => {
    const section = await relatedSection(
      buildSnapshot({ generation: 2, editor }),
      deps(stub([item("src/a.ts", "github"), item("b.ts", "github")])),
    );
    expect(section.rows.map((r) => r.label)).toEqual(["b.ts"]);
  });

  test("queries the selection when there is one, the path otherwise", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await relatedSection(buildSnapshot({ generation: 3, editor }), deps(stub([], seen)));
    await relatedSection(
      buildSnapshot({ generation: 4, editor: { ...editor, selection: "parseWidget" } }),
      deps(stub([], seen)),
    );
    expect(seen[0]?.["name"]).toBe("src/a.ts");
    expect(seen[1]?.["name"]).toBe("parseWidget");
  });

  test("passes the configured limit through", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await relatedSection(buildSnapshot({ generation: 5, editor }), deps(stub([], seen), 3));
    expect(seen[0]?.["limit"]).toBe(3);
  });

  test("sits out while disconnected", async () => {
    const section = await relatedSection(buildSnapshot({ generation: 6, editor }), deps(undefined));
    expect(section.empty).toBe("Needs the Nimbus Gateway.");
  });

  test("says so when the index has nothing", async () => {
    const section = await relatedSection(buildSnapshot({ generation: 7, editor }), deps(stub([])));
    expect(section.empty).toBe("Nothing related in the local index.");
  });

  test("reports a failed search as an error row rather than throwing", async () => {
    const client: ContextClientLike = {
      agentsWhyPeek: async () => ({}) as Awaited<ReturnType<ContextClientLike["agentsWhyPeek"]>>,
      searchRanked: async () => {
        throw new Error("socket closed");
      },
    };
    const section = await relatedSection(buildSnapshot({ generation: 8, editor }), deps(client));
    expect(section.rows[0]?.label).toContain("socket closed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-signals-related.test.ts`
Expected: FAIL — `relatedSection` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/context/signals.ts`:

```ts
// Ranked neighbours from the LOCAL index. Reaches no model, exactly as Find
// related and the diagnostics' prior-occurrences search do; it still needs the
// Gateway socket, and is only ever as good as what has been indexed.
export async function relatedSection(
  snapshot: ContextSnapshot,
  deps: SignalDeps,
): Promise<SignalSection> {
  const base = { id: "related" as const, title: "Related" };
  const query = snapshot.selection ?? snapshot.path;
  if (query === undefined) return { ...base, rows: [], empty: "No file open." };
  const client = deps.client();
  if (client === undefined) return { ...base, rows: [], empty: "Needs the Nimbus Gateway." };
  try {
    const items = await client.searchRanked({ name: query, limit: deps.searchLimit() });
    const rows: SignalRow[] = items
      // Self-exclusion, the same rule Find related applies: an item is not its
      // own neighbour, and leaving it in wastes the top slot.
      .filter((i) => i.name !== snapshot.path)
      .map((i) => ({
        label: i.name,
        ...(i.service.length > 0 ? { detail: i.service } : {}),
        iconId: "file",
      }));
    if (rows.length === 0) {
      return { ...base, rows, empty: "Nothing related in the local index." };
    }
    return { ...base, rows };
  } catch (e: unknown) {
    return { ...base, rows: [{ label: `Search unavailable: ${errMsg(e)}`, iconId: "error" }] };
  }
}
```

Register it last in `SIGNAL_CATALOG`:

```ts
  {
    id: "related",
    needsGateway: true,
    collect: relatedSection,
    // Keyed on the query itself, so it is one call per file switch rather than
    // one per keystroke. The selection is already clamped to 300 chars in the
    // snapshot, so this key is bounded.
    cacheKey: (s) => s.selection ?? s.path,
  },
```

- [ ] **Step 4: Run the tests and commit**

Update `context-signals.test.ts`'s catalog assertion to
`["problems", "git", "blame", "related"]`.

```bash
bunx vitest run test/unit/context-signals-related.test.ts
bun run test && bun run typecheck && bun run lint
git add src/context/signals.ts test/unit/context-signals-related.test.ts test/unit/context-signals.test.ts
git commit -m "feat(context): surface the local index neighbours of the open file"
```

---

### Task 5: The controller

**Files:**
- Create: `src/context/controller.ts`
- Test: `test/unit/context-controller.test.ts`

**Interfaces:**
- Consumes: `ContextSnapshot`; `SignalSpec`, `SignalDeps`, `SignalSection`,
  `SignalId` (Tasks 2-4); `ExtensionToContextView` (extended in Task 6);
  `SidebarConnection` from `src/sidebar/tree-view.js`; `Logger`.
- Produces: `createController(deps): ContextController` with
  `collect(snapshot)`, `invalidatePath(path)`, `invalidateSignal(id)`,
  `invalidateAll()`, `dispose()`. Task 8 wires it in.

This is the task that earns its keep. Everything that makes two RPCs per
collection affordable lives here, and none of it touches `vscode`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-controller.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { createController } from "../../src/context/controller.js";
import type { SignalSection, SignalSpec } from "../../src/context/signals.js";
import { buildSnapshot, type ContextSnapshot } from "../../src/context/snapshot.js";
import type { ConnectionState } from "../../src/connection/connection-manager.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 1,
  selection: "",
  isDirty: false,
};

const snap = (generation: number, line = 1): ContextSnapshot =>
  buildSnapshot({ generation, editor: { ...editor, line } });

const silentLog = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

function harness(opts: {
  collect: (snapshot: ContextSnapshot) => Promise<SignalSection>;
  needsGateway?: boolean;
  connected?: boolean;
}) {
  const posted: Array<{ type: string; section?: SignalSection }> = [];
  const listeners: Array<(s: ConnectionState) => void> = [];
  const spec: SignalSpec = {
    id: "blame",
    needsGateway: opts.needsGateway ?? true,
    collect: (s) => opts.collect(s),
    cacheKey: (s) => (s.line === undefined ? undefined : `${s.path}:${s.line}`),
  };
  const controller = createController({
    signals: [spec],
    signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
    connection: {
      current: () =>
        ((opts.connected ?? true) ? { kind: "connected" } : { kind: "disconnected" }) as ConnectionState,
      onState: (l) => {
        listeners.push(l);
        return { dispose: () => undefined };
      },
    },
    post: (m) => posted.push(m as { type: string; section?: SignalSection }),
    isVisible: () => true,
    log: silentLog as unknown as Parameters<typeof createController>[0]["log"],
  });
  const fire = (s: ConnectionState): void => {
    for (const l of listeners) l(s);
  };
  return { controller, posted, fire };
}

const section = (rows: number): SignalSection => ({
  id: "blame",
  title: "History",
  rows: Array.from({ length: rows }, (_, i) => ({ label: `row ${i}` })),
});

describe("createController", () => {
  test("posts a render first, then a section per collector", async () => {
    const h = harness({ collect: async () => section(1) });
    await h.controller.collect(snap(1));
    expect(h.posted[0]?.type).toBe("render");
    expect(h.posted.at(-1)?.type).toBe("section");
  });

  test("marks a Gateway-backed section loading in the first render", async () => {
    const h = harness({ collect: async () => section(1) });
    const done = h.controller.collect(snap(1));
    const first = h.posted[0] as unknown as { sections: SignalSection[] };
    expect(first.sections[0]?.loading).toBe(true);
    await done;
  });

  test("serves a repeat collection for the same key from cache", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    await h.controller.collect(snap(2));
    expect(calls).toBe(1);
  });

  test("collects again when the cache key changes", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1, 1));
    await h.controller.collect(snap(2, 9));
    expect(calls).toBe(2);
  });

  test("coalesces concurrent collections of the same key into one call", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        await Promise.resolve();
        return section(1);
      },
    });
    await Promise.all([h.controller.collect(snap(1)), h.controller.collect(snap(1))]);
    expect(calls).toBe(1);
  });

  test("drops a result whose generation is no longer current", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const h = harness({
      collect: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return section(1);
      },
    });
    const slow = h.controller.collect(snap(1, 1));
    await h.controller.collect(snap(2, 2));
    release?.();
    await slow;
    const sections = h.posted.filter((p) => p.type === "section");
    expect(sections).toHaveLength(1);
  });

  test("does not collect at all while the view is hidden", async () => {
    let calls = 0;
    const posted: unknown[] = [];
    const controller = createController({
      signals: [
        {
          id: "blame",
          needsGateway: true,
          collect: async () => {
            calls += 1;
            return section(1);
          },
          cacheKey: () => "k",
        },
      ],
      signalDeps: { client: () => undefined, now: () => 0, searchLimit: () => 20 },
      connection: { current: () => ({ kind: "connected" }) as ConnectionState, onState: () => ({ dispose: () => undefined }) },
      post: (m) => posted.push(m),
      isVisible: () => false,
      log: silentLog as never,
    });
    await controller.collect(snap(1));
    expect(calls).toBe(0);
    expect(posted).toEqual([]);
  });

  test("skips a Gateway signal entirely while disconnected", async () => {
    let calls = 0;
    const h = harness({
      connected: false,
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    expect(calls).toBe(0);
    const rendered = h.posted[0] as unknown as { sections: SignalSection[] };
    expect(rendered.sections[0]?.empty).toBe("Needs the Nimbus Gateway.");
  });

  test("invalidatePath drops cached entries for that path", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    h.controller.invalidatePath("src/a.ts");
    await h.controller.collect(snap(2));
    expect(calls).toBe(2);
  });

  test("re-collects when the connection comes back", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        return section(1);
      },
    });
    await h.controller.collect(snap(1));
    h.fire({ kind: "connected" } as ConnectionState);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBeGreaterThan(1);
  });

  test("refreshes when the connection drops, so stale answers do not linger", async () => {
    const h = harness({ collect: async () => section(1) });
    await h.controller.collect(snap(1));
    const before = h.posted.length;
    h.fire({ kind: "disconnected" } as ConnectionState);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.posted.length).toBeGreaterThan(before);
  });

  test("posts an error section rather than leaving one loading forever", async () => {
    const h = harness({
      collect: async () => {
        throw new Error("collector exploded");
      },
    });
    await h.controller.collect(snap(1));
    const last = h.posted.at(-1);
    expect(last?.type).toBe("section");
    expect(last?.section?.rows[0]?.label).toContain("collector exploded");
    expect(last?.section?.loading).toBeUndefined();
  });

  test("posts an error section when a collector throws synchronously", async () => {
    const h = harness({
      collect: () => {
        throw new Error("thrown before any await");
      },
    });
    await h.controller.collect(snap(1));
    expect(h.posted.at(-1)?.section?.rows[0]?.label).toContain("thrown before any await");
  });

  test("clears the in-flight entry after a failure, so the next collection retries", async () => {
    let calls = 0;
    const h = harness({
      collect: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    await h.controller.collect(snap(1));
    await h.controller.collect(snap(2));
    // Two attempts, not one: a failed collection must not be cached as
    // in-flight, or the key would be permanently poisoned.
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-controller.test.ts`
Expected: FAIL — cannot resolve `../../src/context/controller.js`.

- [ ] **Step 3: Write the implementation**

Create `src/context/controller.ts`:

```ts
import type { Logger } from "../logging.js";
import { errMsg } from "../logging.js";
import type { SidebarConnection } from "../sidebar/tree-view.js";
import { offersFor } from "./offers.js";
import type { ExtensionToContextView } from "./protocol.js";
import type { SignalDeps, SignalId, SignalSection, SignalSpec } from "./signals.js";
import type { ContextSnapshot } from "./snapshot.js";

// Everything that makes a Gateway-backed signal affordable: an LRU cache keyed
// by what each signal actually depends on, in-flight coalescing, a generation
// fence, and invalidation. Pure — no vscode, no timers. Debounce stays in the
// glue file, where the events are.
//
// SidebarConnection is reused rather than re-declared: it is the two-member
// slice (current + onState) every sidebar view already programs against, and
// the real ConnectionManager satisfies it structurally.

const DEFAULT_CACHE_LIMIT = 50;

export interface ControllerDeps {
  readonly signals: readonly SignalSpec[];
  readonly signalDeps: SignalDeps;
  readonly connection: SidebarConnection;
  readonly post: (message: ExtensionToContextView) => void;
  readonly isVisible: () => boolean;
  readonly log: Logger;
  readonly cacheLimit?: number;
}

export interface ContextController {
  collect(snapshot: ContextSnapshot): Promise<void>;
  /** Drop every cached entry whose key mentions this path — used on save. */
  invalidatePath(path: string): void;
  invalidateSignal(id: SignalId): void;
  invalidateAll(): void;
  dispose(): void;
}

export function createController(deps: ControllerDeps): ContextController {
  const limit = deps.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  // One cache per signal so a noisy signal cannot evict a quiet one.
  const caches = new Map<SignalId, Map<string, SignalSection>>();
  const inFlight = new Map<string, Promise<SignalSection>>();
  let generation = 0;
  let lastSnapshot: ContextSnapshot | undefined;

  const cacheFor = (id: SignalId): Map<string, SignalSection> => {
    const existing = caches.get(id);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, SignalSection>();
    caches.set(id, fresh);
    return fresh;
  };

  const remember = (id: SignalId, key: string, section: SignalSection): void => {
    const cache = cacheFor(id);
    cache.delete(key);
    cache.set(key, section);
    // Insertion order is LRU order here: re-setting moves an entry to the end,
    // so the first key is always the least recently written.
    while (cache.size > limit) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  const disconnectedSection = (spec: SignalSpec): SignalSection => ({
    id: spec.id,
    title: titleOf(spec.id),
    rows: [],
    empty: "Needs the Nimbus Gateway.",
  });

  const loadingSection = (spec: SignalSpec): SignalSection => ({
    id: spec.id,
    title: titleOf(spec.id),
    rows: [],
    loading: true,
  });

  const runOne = async (spec: SignalSpec, snapshot: ContextSnapshot, mine: number): Promise<void> => {
    const key = spec.cacheKey(snapshot);
    const flightKey = `${spec.id}:${key ?? ""}`;
    try {
      let pending = key === undefined ? undefined : inFlight.get(flightKey);
      if (pending === undefined) {
        // Called INSIDE the try on purpose. A collector that throws
        // synchronously would otherwise escape before the cleanup below, so its
        // in-flight entry would survive forever and every later collection for
        // the same key would await a promise that can only reject.
        pending = spec.collect(snapshot, deps.signalDeps);
        if (key !== undefined) inFlight.set(flightKey, pending);
      }
      const section = await pending;
      // Only a successful section is worth remembering.
      if (key !== undefined) remember(spec.id, key, section);
      // The fence: a later snapshot has overtaken this one, so this answer is
      // about a line or file the user has already left.
      if (mine !== generation) return;
      deps.post({ type: "section", generation: mine, section });
    } catch (e: unknown) {
      deps.log.warn(`context signal ${spec.id} failed: ${errMsg(e)}`);
      // Never leave a section on "Loading…". The two collectors catch their own
      // RPC failures, but anything thrown outside that — or by a future signal
      // whose author forgets — would hang that section for the rest of the
      // session, with only a log line to explain it.
      if (mine === generation) {
        deps.post({
          type: "section",
          generation: mine,
          section: {
            id: spec.id,
            title: titleOf(spec.id),
            rows: [{ label: `Unavailable: ${errMsg(e)}`, iconId: "error" }],
          },
        });
      }
    } finally {
      if (key !== undefined) inFlight.delete(flightKey);
    }
  };

  const collect = async (snapshot: ContextSnapshot): Promise<void> => {
    if (!deps.isVisible()) return;
    generation += 1;
    const mine = generation;
    lastSnapshot = snapshot;
    const connected = deps.connection.current().kind === "connected";

    const initial: SignalSection[] = [];
    const toRun: SignalSpec[] = [];
    for (const spec of deps.signals) {
      if (spec.needsGateway && !connected) {
        initial.push(disconnectedSection(spec));
        continue;
      }
      const key = spec.cacheKey(snapshot);
      const cached = key === undefined ? undefined : cacheFor(spec.id).get(key);
      if (cached !== undefined) {
        initial.push(cached);
        continue;
      }
      initial.push(loadingSection(spec));
      toRun.push(spec);
    }

    deps.post({
      type: "render",
      generation: mine,
      sections: initial,
      offers: offersFor(snapshot),
      isDirty: snapshot.isDirty,
    });

    await Promise.all(toRun.map((spec) => runOne(spec, snapshot, mine)));
  };

  const refresh = (reason: string): void => {
    const snapshot = lastSnapshot;
    if (snapshot === undefined || !deps.isVisible()) return;
    void collect(snapshot).catch((e: unknown) => deps.log.warn(`context ${reason}: ${errMsg(e)}`));
  };

  const sub = deps.connection.onState((state) => {
    // Nothing cached survives a state change in either direction: the index can
    // change while we are away.
    caches.clear();
    // Both halves refresh, and for symmetrical reasons. Losing the Gateway must
    // replace stale blame and related answers with "Needs the Nimbus Gateway"
    // rather than leaving results on screen that read as current; regaining it
    // must fill them back in without waiting for the user to move the cursor.
    refresh(
      state.kind === "connected"
        ? "re-collect after reconnect failed"
        : "clear after disconnect failed",
    );
  });

  return {
    collect,
    invalidatePath: (path) => {
      for (const cache of caches.values()) {
        for (const key of [...cache.keys()]) if (key.includes(path)) cache.delete(key);
      }
    },
    invalidateSignal: (id) => cacheFor(id).clear(),
    invalidateAll: () => caches.clear(),
    dispose: () => {
      sub.dispose();
      caches.clear();
      inFlight.clear();
    },
  };
}

// The title a section carries before its collector has produced one.
function titleOf(id: SignalId): string {
  switch (id) {
    case "problems":
      return "Problems";
    case "git":
      return "Git";
    case "blame":
      return "History";
    case "related":
      return "Related";
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run test/unit/context-controller.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
bun run test && bun run typecheck && bun run lint
git add src/context/controller.ts test/unit/context-controller.test.ts
git commit -m "feat(context): cache, coalesce and fence the panel's collections"
```

---

### Task 6: Per-section posting in the protocol and the webview

**Files:**
- Modify: `src/context/protocol.ts`
- Modify: `src/context/webview/main.ts`
- Modify: `src/context/webview/render.ts`
- Test: `test/unit/context-render.test.ts`, `test/unit/context-webview-listener.test.ts`

**Interfaces:**
- Consumes: `SignalSection` (Task 2).
- Produces: an `ExtensionToContextView` variant
  `{ type: "section"; generation: number; section: SignalSection }`; the webview
  keeps sections by id and repaints on each.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/context-render.test.ts`:

```ts
describe("renderSections loading state", () => {
  test("renders a loading line for a section still in flight", () => {
    const html = renderSections([{ id: "blame", title: "History", rows: [], loading: true }]);
    expect(html).toContain("Loading…");
  });

  test("prefers rows over the loading line once they arrive", () => {
    const html = renderSections([
      { id: "blame", title: "History", rows: [{ label: "Ada" }], loading: true },
    ]);
    expect(html).toContain("Ada");
    expect(html).not.toContain("Loading…");
  });
});
```

Add to `test/unit/context-webview-listener.test.ts` (jsdom):

```ts
describe("per-section updates", () => {
  test("a section message replaces only that section", () => {
    dispatch(TRUSTED_ORIGIN, {
      type: "render",
      generation: 1,
      sections: [
        { id: "problems", title: "Problems", rows: [{ label: "P" }] },
        { id: "blame", title: "History", rows: [], loading: true },
      ],
      offers: [],
      isDirty: false,
    });
    dispatch(TRUSTED_ORIGIN, {
      type: "section",
      generation: 1,
      section: { id: "blame", title: "History", rows: [{ label: "Ada" }] },
    });
    const html = document.getElementById("signals")?.innerHTML ?? "";
    expect(html).toContain("Ada");
    expect(html).toContain("P");
  });

  test("ignores a section from a superseded generation", () => {
    dispatch(TRUSTED_ORIGIN, {
      type: "render",
      generation: 2,
      sections: [{ id: "blame", title: "History", rows: [], loading: true }],
      offers: [],
      isDirty: false,
    });
    dispatch(TRUSTED_ORIGIN, {
      type: "section",
      generation: 1,
      section: { id: "blame", title: "History", rows: [{ label: "stale" }] },
    });
    expect(document.getElementById("signals")?.innerHTML ?? "").not.toContain("stale");
  });
});
```

Reuse whatever `dispatch` helper and trusted-origin constant that file already
defines; do not introduce a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/context-render.test.ts test/unit/context-webview-listener.test.ts`
Expected: FAIL — no loading line, and `section` messages are dropped as an
unknown type.

- [ ] **Step 3: Extend the protocol**

In `src/context/protocol.ts`, add to `ExtensionToContextView`:

```ts
  | { type: "section"; generation: number; section: SignalSection }
```

- [ ] **Step 4: Render the loading state**

In `src/context/webview/render.ts`, inside `renderSections`, replace the body
selection so a loading section with no rows says so:

```ts
      const body =
        section.rows.length > 0
          ? `<ul class="rows">${section.rows.map((r) => renderRow(r.label, r.detail)).join("")}</ul>`
          : `<p class="empty">${escapeHtml(
              section.loading === true ? "Loading…" : (section.empty ?? "Nothing to show."),
            )}</p>`;
```

Keep `renderRow`'s existing signature — this repo's rows carry no icon markup.

- [ ] **Step 5: Keep sections by id in the webview**

In `src/context/webview/main.ts`, add module state and handle the new message:

```ts
// Sections arrive independently: the local ones ride the first render, and each
// Gateway-backed one lands when its RPC resolves. Keeping them by id means a
// late blame answer repaints one section rather than the whole panel.
let sections: SignalSection[] = [];
let currentGeneration = -1;
```

and in the listener, after the `render` branch sets state:

```ts
  if (typed.type === "section") {
    // Fenced: a section from a superseded collection describes a line or file
    // the user has already left.
    if (typed.generation !== currentGeneration) return;
    sections = sections.map((s) => (s.id === typed.section.id ? typed.section : s));
    paint("signals", renderSignals({ sections, isDirty: currentIsDirty }));
    return;
  }
  if (typed.type !== "render") return;
  currentGeneration = typed.generation;
  currentIsDirty = typed.isDirty;
  sections = [...typed.sections];
  paint("signals", renderSignals({ sections, isDirty: currentIsDirty }));
  paint("offers", renderOffers(typed.offers));
```

declaring `let currentIsDirty = false;` beside the other module state, and
importing `SignalSection` as a type from `../signals.js`.

- [ ] **Step 6: Run the tests and commit**

```bash
bunx vitest run test/unit/context-render.test.ts test/unit/context-webview-listener.test.ts
bun run test && bun run typecheck && bun run lint && bun run build
git add src/context/protocol.ts src/context/webview test/unit/context-render.test.ts test/unit/context-webview-listener.test.ts
git commit -m "feat(context): post each section as it resolves instead of one batch"
```

---

### Task 7: Git depth — the change event and the changed-file count

**Files:**
- Modify: `src/scm/git-types.ts`
- Modify: `src/scm/real-git.ts`
- Modify: `test/unit/scm-repo-select.test.ts`, `test/unit/scm-commands.test.ts` (fakes)
- Modify: `src/context/real-context-view.ts` (`gitSummary`)

**Interfaces:**
- Produces: `GitRepositoryLike.onDidChange(listener: () => void): DisposableLike`.
  Task 8 subscribes to it. `gitSummary` starts populating `changedPaths`.

PR 1 deliberately left `onDidChange` off the seam because nothing subscribed to
it, and left `changedPaths` unread because filling it needs an async call per
collection. Both now have a consumer.

- [ ] **Step 1: Add the verb to the seam**

In `src/scm/git-types.ts`, add the import and the member:

```ts
import type { DisposableLike } from "../vscode-shim.js";
```

inside `GitRepositoryLike`, after `branch()`:

```ts
  /**
   * Fires when the repository's state changes — branch switch, stage, checkout.
   * Without it, a branch switch made while the user sits still leaves the
   * context panel showing the previous branch until some other event happens.
   */
  onDidChange(listener: () => void): DisposableLike;
```

and to `GitApiLike`, beside `repositories()`:

```ts
  /**
   * Fires when the git extension opens or discovers a repository. Repositories
   * populate ASYNCHRONOUSLY — the extension can be active while still scanning —
   * so a consumer that subscribes only to what `repositories()` returns at
   * activation can attach to nothing at all and never hear about a branch
   * switch again.
   */
  onDidOpenRepository(listener: () => void): DisposableLike;
```

- [ ] **Step 2: Adapt the real git extension**

In `src/scm/real-git.ts`, extend `RawRepository.state` with the event the git
extension already exposes:

```ts
    onDidChange(listener: () => void): { dispose(): void };
```

and add to the object `adaptRepository` returns:

```ts
    onDidChange: (listener: () => void) => raw.state.onDidChange(listener),
```

Then extend `RawGitApi` with the extension's own repository event, and forward it
from `createRealGitApi`'s returned object:

```ts
interface RawGitApi {
  repositories: RawRepository[];
  onDidOpenRepository(listener: () => void): { dispose(): void };
}
```

```ts
      return {
        repositories: () => api.repositories.map(adaptRepository),
        onDidOpenRepository: (listener: () => void) => api.onDidOpenRepository(listener),
      };
```

- [ ] **Step 3: Update the test fakes**

In `test/unit/scm-repo-select.test.ts` and `test/unit/scm-commands.test.ts`, add
to each `fakeRepo`, after `branch`:

```ts
    onDidChange: () => ({ dispose: () => undefined }),
```

And in `test/unit/scm-commands.test.ts:69`, the `GitApiLike` fake now needs the
new member:

```ts
  const api: GitApiLike = {
    repositories: () => repos,
    onDidOpenRepository: () => ({ dispose: () => undefined }),
  };
```

- [ ] **Step 4: Populate the changed-file count**

In `src/context/real-context-view.ts`, replace `gitSummary`'s body so it reads
the working-tree changes, and delete the comment saying `changedPaths` stays
unread:

```ts
  const gitSummary = async (fileName: string | undefined): Promise<GitSummary | undefined> => {
    const repos = (await deps.git())?.repositories() ?? [];
    // fileName is the editor's absolute path — a local filesystem lookup, not
    // a payload; the repo-relative toRelativeRef value is still what reaches
    // the snapshot below.
    const repo = repoContaining(repos, fileName);
    if (repo === undefined) return undefined;
    try {
      const changed = await repo.changedFiles("all");
      return { branch: repo.branch(), changedPaths: changed.map((c) => c.path) };
    } catch (e: unknown) {
      // A failed diff must not cost the branch row, which is already in hand.
      deps.log.warn(`context panel could not read changed files: ${errMsg(e)}`);
      return { branch: repo.branch(), changedPaths: undefined };
    }
  };
```

- [ ] **Step 5: Run the tests and commit**

```bash
bun run test && bun run typecheck && bun run lint
git add src/scm/git-types.ts src/scm/real-git.ts src/context/real-context-view.ts test/unit/scm-repo-select.test.ts test/unit/scm-commands.test.ts
git commit -m "feat(scm): report repository changes, and count them in the context panel"
```

---

### Task 8: Wire the controller in

**Files:**
- Modify: `src/context/real-context-view.ts`
- Modify: `vitest.config.ts` (no change expected — confirm the glue is still excluded)
- Test: `test/unit/manifest-context.test.ts` (no change expected)

**Interfaces:**
- Consumes: everything from Tasks 2-7.
- Produces: a `registerContextView` that takes a client accessor and a
  connection, and delegates collection to the controller.

- [ ] **Step 1: Widen the registration dependencies**

In `src/context/real-context-view.ts`, extend the parameter object:

```ts
export function registerContextView(deps: {
  log: Logger;
  git: () => Promise<GitApiLike | undefined>;
  /** Undefined while disconnected — Gateway-backed signals then sit out. */
  client: () => ContextClientLike | undefined;
  connection: SidebarConnection;
  searchLimit: () => number;
}): vscode.Disposable {
```

importing `ContextClientLike` from `./signals.js` and `SidebarConnection` from
`../sidebar/tree-view.js`.

- [ ] **Step 2: Replace the inline collection with the controller**

Build the controller once inside `registerContextView`, above `collect`:

```ts
  const controller = createController({
    signals: SIGNAL_CATALOG,
    signalDeps: {
      client: deps.client,
      now: () => Date.now(),
      searchLimit: deps.searchLimit,
    },
    connection: deps.connection,
    post: (message) => {
      if (view === undefined) return;
      void view.webview.postMessage(message);
    },
    isVisible: () => view?.visible === true,
    log: deps.log,
  });
```

and reduce `collect` to building the snapshot and handing it over — the
generation counter, the fence and the posting all move into the controller:

```ts
  const collect = async (): Promise<void> => {
    if (view === undefined || !view.visible) return;
    const editor = vscode.window.activeTextEditor;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const git = await gitSummary(editor?.document.fileName);
    if (view === undefined) return;
    const snapshot = buildSnapshot({
      // The controller owns the generation counter now; the snapshot carries
      // whatever it is told, and 0 here means "the controller will stamp it".
      generation: 0,
      ...(editor === undefined
        ? {}
        : {
            editor: {
              path: toRelativeRef(editor.document.fileName, roots),
              scheme: editor.document.uri.scheme,
              languageId: editor.document.languageId,
              line: editor.selection.active.line,
              selection: selectionText(editor),
              isDirty: editor.document.isDirty,
            },
          }),
      ...(git === undefined ? {} : { git }),
      ...(editor === undefined ? {} : { diagnostics: diagnosticsFor(editor.document.uri) }),
    });
    await controller.collect(snapshot);
  };
```

Delete the now-unused `generation`/`mine` locals and the `SIGNAL_CATALOG.map`
posting block.

- [ ] **Step 3: Wire the invalidation triggers**

Replace the plain save subscription and add a git one. Inside
`registerContextView`, before the returned disposable:

```ts
  // Save: the indexer may pick the file up, so `related` can legitimately
  // change. Drop that path's entries, then collect.
  const onSave = (document: vscode.TextDocument): void => {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    controller.invalidatePath(toRelativeRef(document.fileName, roots));
    recollect();
  };

  // Git state: branch switches and staging change what the git section says.
  //
  // Re-attached rather than attached once. The git extension discovers
  // repositories asynchronously, so the set can still be empty when this first
  // runs — subscribing only to what is there at activation is how this trigger
  // ends up never firing at all. Re-attaching on every open also covers a repo
  // closing: its listener is disposed with the rest.
  const gitSubs: Array<{ dispose(): void }> = [];
  const attachGitListeners = async (): Promise<void> => {
    const api = await deps.git();
    for (const previous of gitSubs.splice(0)) previous.dispose();
    for (const repo of api?.repositories() ?? []) {
      gitSubs.push(
        repo.onDidChange(() => {
          controller.invalidateSignal("git");
          recollect();
        }),
      );
    }
  };

  let openSub: { dispose(): void } | undefined;
  void deps.git().then((api) => {
    openSub = api?.onDidOpenRepository(() => {
      void attachGitListeners().then(() => {
        controller.invalidateSignal("git");
        recollect();
      });
    });
    void attachGitListeners();
  });
```

and in the returned `vscode.Disposable.from(...)`, replace the save entry and add
the new disposables:

```ts
    vscode.workspace.onDidSaveTextDocument((document) => onSave(document)),
    { dispose: () => controller.dispose() },
    {
      dispose: () => {
        openSub?.dispose();
        for (const s of gitSubs.splice(0)) s.dispose();
      },
    },
```

- [ ] **Step 4: Update the activation site**

In `src/extension.ts`, extend the `registerContextView` call with the three new
dependencies, using the locals `activate` already has:

```ts
  ctx.subscriptions.push(
    registerContextView({
      log,
      git: gitApi,
      // The panel's two calls reach no model, so they take the RAW client —
      // routing them through the egress gate would be wrong, and the
      // choke-point test allows both by name.
      client: () => {
        const client = nimbus();
        if (client === undefined) return undefined;
        return {
          agentsWhyPeek: (p) => client.agentsWhyPeek(p),
          searchRanked: (params) => client.searchRanked(params),
        };
      },
      connection,
      searchLimit: () => settings.searchLimit(),
    }),
  );
```

Both locals already exist: `connection` is created at `src/extension.ts:233` and
is the same value every sidebar view receives (the real `ConnectionManager`
satisfies `SidebarConnection` structurally), and `settings` is the object
carrying `searchLimit()`. Introduce no new names.

Note that `client` here deliberately adapts the raw `NimbusClient` into the
narrow `ContextClientLike` rather than passing it whole — the panel may reach
exactly two methods, and this is where that is enforced.

- [ ] **Step 5: Run the whole gate**

```bash
bun run test && bun run typecheck && bun run lint && bun run build \
  && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Expected: every command passes.

- [ ] **Step 6: Drive it in a real editor**

Press F5 and confirm by eye. **This includes PR 1's outstanding checklist**,
which has never been run — see
`docs/superpowers/plans/2026-08-16-ambient-context-panel-pr1.md`, Task 7 Step 9,
all sixteen points. Then, for this PR's additions:

1. With the Gateway connected, put the cursor on a line with history: a
   **History** section shows author, relative time, short sha, subject, and PR
   or ticket where they exist.
2. Move to another line in the same file: History updates. Move **within** one
   line: it must not refetch (watch the output channel).
3. Open a file whose repo has not been indexed: History says so and names
   `nimbus init` rather than showing an empty box.
4. A **Related** section lists local-index neighbours with their service, and
   never lists the open file itself.
5. Select an identifier: Related re-queries on the selection. Clear the
   selection: it returns to the path query.
6. Stop the Gateway: both Gateway sections say they need it, and Problems and
   Git keep working. Restart it: both recover **without** touching the editor.
7. Type quickly for several seconds: the panel stays responsive, and neither
   Gateway section flickers per keystroke.
8. Save a file: Related refreshes.
9. Switch branches in a terminal while the editor sits idle: the Git section
   updates without your touching the editor, and the changed-file count is now
   present and correct against `git status`. Then **close the window, open a
   fresh one on the same repo, and switch branches again before touching
   anything** — that is the case where repositories are still being discovered
   when the panel first subscribes, and where a once-only subscription would
   silently never fire.
10. Stop the Gateway while the panel is visible and **do not touch the editor**:
    the History and Related sections must change to "Needs the Nimbus Gateway"
    on their own, not keep showing answers that are no longer current.

- [ ] **Step 7: Commit**

```bash
git add src/context/real-context-view.ts src/extension.ts
git commit -m "feat(context): drive the panel through the controller"
```

---

## Self-Review

**Spec coverage.** The four signals — `problems` and `git` shipped in PR 1;
`blame` is Task 3, `related` Task 4. Sections posting individually rather than
as a batch — Tasks 5 and 6. The generation fence — Task 5 (controller) and
Task 6 (webview, which now also fences). A failed collector failing alone —
Tasks 3, 4 (per-collector error rows) and 5 (the controller logs and continues).
Cache keyed on what each RPC depends on, with the LRU bound — Task 5. In-flight
coalescing — Task 5. Disconnected means skip, not fail — Tasks 3, 4, 5. The four
invalidation triggers — save and git in Task 8, disconnect and reconnect in
Task 5. The `peek.ts` split — Task 1. The git seam's `onDidChange` — Task 7.
`changedPaths` — Task 7. Debounce, visibility pause and the dirty marker shipped
in PR 1 and are untouched here.

**Deferred to PR 3, as the spec assigns them:** `nimbus.context.enabled` and
`docs/settings.md`; the diagnostic and SCM action routes; branch pre-fill for the
prompted briefs; the ExTester spec.

**Three corrections from the 2026-08-16 plan review, recorded so they are not
undone.** A collector that throws now posts an error section instead of leaving
one on "Loading…" forever, and `spec.collect` is called *inside* the try so a
synchronous throw cannot strand its in-flight entry and poison that cache key
permanently. The connection listener refreshes in *both* directions, so losing
the Gateway replaces stale answers rather than leaving them on screen looking
current. And the git listeners re-attach on `onDidOpenRepository`, because
repositories populate asynchronously and a once-only subscription can attach to
an empty set and never fire.

**Two things a reviewer should expect and will not find.** Blame's PR and ticket
render as labels without links — this panel's renderer emits text nodes only, and
adding anchor rendering is a wider change than one row justifies. And the LRU
limit is 50 per signal, a starting figure rather than a measured one; the spec
records it as the one open question, and nothing here measures it.

**One doc pass this PR earns but does not include:** #111 described a panel with
two local signals and no Gateway call. Once this lands, the `CLAUDE.md` surface
paragraph and the README bullet both need updating, and the ROADMAP row can move
much closer to done. Fold that into the PR description so it is not forgotten.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-16-ambient-context-panel-pr2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration.

**2. Inline Execution** — execute the tasks in this session with checkpoints for review.

**Which approach?**
