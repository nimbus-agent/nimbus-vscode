# Built-in Briefs — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach four of the seven unreached built-in briefs (`why`, `ghost`, `conflicts`, `huddle`) from the editor, behind the egress gate, and make the Agents sidebar show the product's built-ins instead of "No agents configured".

**Architecture:** A new `src/briefs/` package following the `src/scm/` shape — pure core (`catalog.ts`, `render.ts`, `params.ts`) plus one `vscode`-touching glue file (`commands.ts`). Brief RPCs route through `src/egress/gated-client.ts`, the existing choke point, under a new `"brief"` `EgressKind` that prompts and is skippable per workspace. The sidebar gains a two-group tree using `SidebarItem.children`, which `createDataView` already supports.

**Tech Stack:** TypeScript (strict, no `any`), Vitest, Biome, esbuild, `@nimbus-dev/client` `^0.14.0` (types re-exported from `@nimbus-dev/sdk`).

**Spec:** `docs/superpowers/specs/2026-08-10-built-in-briefs-design.md`

## Global Constraints

Every task's requirements implicitly include all of these.

- TypeScript **strict**, and **no `any`** — use `unknown` for external data. Biome enforces `noExplicitAny`, `noNonNullAssertion`, and `noConsole` in `src/`.
- **Never `console.*`** — log through the injected `Logger` from `src/logging.ts`.
- `tsconfig` has **`exactOptionalPropertyTypes`**. Never assign `undefined` to an optional property; build objects incrementally or use a conditional spread (`...(x !== undefined ? { x } : {})`).
- **All `vscode` access goes through `src/vscode-shim.ts`.** No file in `src/briefs/` except `commands.ts` may import from it, and none may `import "vscode"` directly.
- **Relative ESM imports carry a `.js` extension** (`./catalog.js`), matching every existing import in this repo.
- **`src/egress/gated-client.ts` is the only file in `src/` allowed to call a raw client's agent methods.** `test/unit/egress-choke-point.test.ts` enforces this.
- Never reach into the Nimbus gateway. The only Nimbus dependency is `@nimbus-dev/client`.
- Local gate before any commit that ends a task: `bun run typecheck && bun run lint && bun run test`.
- Commit messages use Conventional Commits (the repo squash-merges and Release Please reads the title).

## Scope boundary — what is NOT in this PR

Stated so an implementer does not "helpfully" add them:

- **No `whyPeek`, no hover provider.** PR 2. The catalog therefore has no `whyPeek` entry yet, and the exemption guard test lands with it in PR 2.
- **No `janitor`, no `preflight`.** PR 3. They need input prompts and the `nimbus.briefs.defaultNamespace` setting.
- **No new `nimbus.*` settings at all.** So `bun run check-settings-docs` needs nothing new. If you find yourself adding a setting, you have left the plan.
- **`ops-commands.ts` keeps calling `agentsImpact` / `agentsExpert` / `agentsCatchup` raw.** Retro-routing them through the seam is PR 3. Consequently the choke-point guard added in Task 5 covers **only the four calls this PR introduces** — see that task for why a wider list would be a guard that lies.

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `src/briefs/catalog.ts` | The briefs as data: id, label, icon, command id, required context | create |
| `src/briefs/render.ts` | `renderWhy` / `renderGhost` / `renderConflicts` / `renderHuddle` → markdown, plus the shared `gapsFooter` | create |
| `src/briefs/params.ts` | Editor context → typed params; guarantees no absolute path escapes | create |
| `src/briefs/commands.ts` | The only `vscode`-touching file: resolves context, calls the gated seam, opens the tab | create |
| `src/egress/preflight.ts` | `EgressKind` gains `"brief"` | modify |
| `src/egress/skip-store.ts` | `SkippableKind` gains `"brief"` | modify |
| `src/egress/gate.ts` | `SKIP_LABEL` and `skippableKind()` learn `"brief"` | modify |
| `src/egress/gated-client.ts` | `gateRawBriefs()` — owns every `.agentsX(` call shape | modify |
| `src/vscode-shim.ts` | `TextEditorLike.selection` gains `active: { line: number }` | modify |
| `src/sidebar/agents.ts` | `builtInBriefRows()` + `agentsTreeRows()` grouping | modify |
| `src/sidebar/agents-view.ts` | Compose the two groups | modify |
| `src/chat-participant/ops-commands.ts` | Import the lifted `gapsFooter` instead of its own | modify |
| `src/extension.ts` | Wire the seam and register four commands | modify |
| `package.json` | Four commands, four `editor/context` entries, palette entries | modify |
| `test/unit/briefs-catalog.test.ts` | Catalog invariants | create |
| `test/unit/briefs-render.test.ts` | Renderer output | create |
| `test/unit/briefs-params.test.ts` | Path safety | create |
| `test/unit/briefs-commands.test.ts` | Command behaviour, gate interaction, errors | create |
| `test/unit/manifest-briefs.test.ts` | Manifest contributions | create |
| `test/unit/egress-choke-point.test.ts` | Guard the new call shapes | modify |
| `test/unit/egress-gate.test.ts` | `"brief"` prompts and is skippable | modify |
| `test/unit/agents.test.ts` | Grouped rows | modify |
| `docs/architecture.md`, `CLAUDE.md` | Record `src/briefs/` | modify |

---

### Task 1: The brief catalog

The single source of truth for what a brief is called, which icon it gets, and which command runs it. Pure data — no `vscode`, no client.

**Files:**
- Create: `src/briefs/catalog.ts`
- Test: `test/unit/briefs-catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type BriefId = "why" | "ghost" | "conflicts" | "huddle"`; `type BriefContext = "fileAndLine" | "file" | "none"`; `interface BriefSpec { readonly id: BriefId; readonly label: string; readonly iconId: string; readonly command: string; readonly context: BriefContext; readonly gated: boolean }`; `const BRIEF_CATALOG: readonly BriefSpec[]`; `function briefSpec(id: BriefId): BriefSpec`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/briefs-catalog.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG, type BriefId, briefSpec } from "../../src/briefs/catalog.js";

describe("brief catalog", () => {
  test("carries exactly the four briefs PR 1 implements", () => {
    expect(BRIEF_CATALOG.map((b) => b.id)).toEqual(["why", "ghost", "conflicts", "huddle"]);
  });

  test("every entry is gated — whyPeek, the only exemption, is not in this PR", () => {
    expect(BRIEF_CATALOG.filter((b) => !b.gated)).toEqual([]);
  });

  test("command ids are unique and namespaced", () => {
    const commands = BRIEF_CATALOG.map((b) => b.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const c of commands) expect(c.startsWith("nimbus.brief.")).toBe(true);
  });

  test("labels are human sentences, not agent names", () => {
    expect(briefSpec("why").label).toBe("Why is this here?");
    expect(briefSpec("ghost").label).toBe("Who knew this code?");
    expect(briefSpec("conflicts").label).toBe("Who else is touching this?");
    expect(briefSpec("huddle").label).toBe("Team huddle");
  });

  test("context matches what each RPC actually requires", () => {
    expect(briefSpec("why").context).toBe("fileAndLine");
    expect(briefSpec("ghost").context).toBe("file");
    expect(briefSpec("conflicts").context).toBe("file");
    expect(briefSpec("huddle").context).toBe("none");
  });

  test("briefSpec throws on an unknown id rather than returning undefined", () => {
    expect(() => briefSpec("nope" as BriefId)).toThrow(/unknown brief/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/briefs-catalog.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/briefs/catalog.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/briefs/catalog.ts`:

```ts
// The built-in briefs this extension surfaces, as data. One source of truth for
// the label, icon and command id, so the sidebar row, the editor menu entry and
// the egress manifest can never disagree about what a brief is called.
//
// PR 1 carries four. `whyPeek` (PR 2) and `janitor`/`preflight` (PR 3) join
// later; see docs/superpowers/specs/2026-08-10-built-in-briefs-design.md.

export type BriefId = "why" | "ghost" | "conflicts" | "huddle";

/** What the caller must supply before the brief can run. */
export type BriefContext =
  /** agentsWhy — needs the file and the cursor line. */
  | "fileAndLine"
  /** agentsGhost / agentsConflicts — need the file only. */
  | "file"
  /** agentsHuddle — every parameter is optional. */
  | "none";

export interface BriefSpec {
  readonly id: BriefId;
  /** Shown in the sidebar row, the editor menu, and the egress manifest action. */
  readonly label: string;
  /** A vscode ThemeIcon (codicon) id. */
  readonly iconId: string;
  readonly command: string;
  readonly context: BriefContext;
  /**
   * Whether this call routes through the egress gate. True for every
   * model-composed brief. The one false entry will be `whyPeek` in PR 2: it is
   * synchronous, takes no timeoutMs, and carries no `brief` string or
   * AgentBriefBase, so it never reaches a model.
   */
  readonly gated: boolean;
}

export const BRIEF_CATALOG: readonly BriefSpec[] = [
  {
    id: "why",
    label: "Why is this here?",
    iconId: "history",
    command: "nimbus.brief.why",
    context: "fileAndLine",
    gated: true,
  },
  {
    id: "ghost",
    label: "Who knew this code?",
    iconId: "person",
    command: "nimbus.brief.ghost",
    context: "file",
    gated: true,
  },
  {
    id: "conflicts",
    label: "Who else is touching this?",
    iconId: "git-merge",
    command: "nimbus.brief.conflicts",
    context: "file",
    gated: true,
  },
  {
    id: "huddle",
    label: "Team huddle",
    iconId: "organization",
    command: "nimbus.brief.huddle",
    context: "none",
    gated: true,
  },
];

// Throws rather than returning undefined: every caller has a compile-time
// BriefId, so a miss here is a catalog bug, not a runtime condition to handle.
export function briefSpec(id: BriefId): BriefSpec {
  const spec = BRIEF_CATALOG.find((b) => b.id === id);
  if (spec === undefined) throw new Error(`unknown brief: ${id}`);
  return spec;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/unit/briefs-catalog.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/catalog.ts test/unit/briefs-catalog.test.ts
git commit -m "feat(briefs): add the built-in brief catalog"
```

---

### Task 2: Renderers, and the lifted `gapsFooter`

Pure `brief → markdown`. `gapsFooter` moves out of `ops-commands.ts` so both the participant and the editor surfaces render data gaps identically.

**Files:**
- Create: `src/briefs/render.ts`
- Modify: `src/chat-participant/ops-commands.ts:18-23` (delete the local `Gapped`/`gapsFooter`, import instead)
- Test: `test/unit/briefs-render.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `function gapsFooter(brief: { gaps: readonly { detail: string }[] }): string`; `function renderWhy(brief: WhyBrief): string`; `function renderGhost(brief: GhostBrief): string`; `function renderConflicts(brief: ConflictBrief, now: number): string`; `function renderHuddle(brief: HuddleBrief, now: number): string`.

`now` is injected into the two renderers that print relative times, exactly as `formatRelativeTime(now, timestamp)` requires — the repo keeps time formatting deterministic for tests.

- [ ] **Step 1: Write the failing test**

Create `test/unit/briefs-render.test.ts`:

```ts
import type { ConflictBrief, GhostBrief, HuddleBrief, WhyBrief } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";

import {
  gapsFooter,
  renderConflicts,
  renderGhost,
  renderHuddle,
  renderWhy,
} from "../../src/briefs/render.js";

const BASE = { agentVersion: 1, generatedAt: 0, latencyMs: 12, gaps: [] } as const;
const NOW = 1_000_000_000_000;

function why(over: Partial<WhyBrief> = {}): WhyBrief {
  return {
    ...BASE,
    kind: "why",
    query: { ref: "src/auth/session.ts", line: 42 },
    subject: null,
    findings: [],
    ...over,
  } as WhyBrief;
}

describe("gapsFooter", () => {
  test("is empty when there are no gaps", () => {
    expect(gapsFooter({ gaps: [] })).toBe("");
  });

  test("joins every gap detail", () => {
    expect(gapsFooter({ gaps: [{ detail: "no chat connector" }, { detail: "empty index" }] })).toBe(
      "\n\n_Data gaps: no chat connector; empty index_",
    );
  });
});

describe("renderWhy", () => {
  test("says so plainly when nothing was found", () => {
    const out = renderWhy(why());
    expect(out).toContain("No history found for `src/auth/session.ts:42`");
  });

  test("groups findings by lane and links those with a url", () => {
    const out = renderWhy(
      why({
        findings: [
          {
            lane: "pull_request",
            title: "Fix retry loop",
            detail: "PR #412",
            url: "https://example.test/pr/412",
            occurredAt: null,
            entityId: null,
          },
          {
            lane: "ticket",
            title: "NIM-88",
            detail: "Session drops under load",
            url: null,
            occurredAt: null,
            entityId: null,
          },
        ],
      }),
    );
    expect(out).toContain("### Pull request");
    expect(out).toContain("[Fix retry loop](https://example.test/pr/412) — PR #412");
    expect(out).toContain("### Ticket");
    expect(out).toContain("**NIM-88** — Session drops under load");
  });

  test("never echoes the subject's absolute repoRoot", () => {
    const out = renderWhy(
      why({
        subject: {
          repoRoot: "/home/dev/secret-project",
          filePath: "src/auth/session.ts",
          lineNo: 42,
          symbol: "refreshToken",
        },
      }),
    );
    expect(out).toContain("refreshToken");
    expect(out).not.toContain("/home/dev/secret-project");
  });

  test("appends the gaps footer", () => {
    expect(renderWhy(why({ gaps: [{ category: "empty_index", detail: "index is empty" }] }))).toContain(
      "_Data gaps: index is empty_",
    );
  });
});

describe("renderGhost", () => {
  const ghost = (findings: GhostBrief["findings"]): GhostBrief =>
    ({
      ...BASE,
      kind: "ghost",
      query: { file: "src/auth/session.ts" },
      startEntityId: null,
      findings,
    }) as GhostBrief;

  test("says so plainly when nothing was found", () => {
    expect(renderGhost(ghost([]))).toContain(
      "No knowledge-holder signals found for `src/auth/session.ts`",
    );
  });

  test("names the expert, the rank and who to contact", () => {
    const out = renderGhost(
      ghost([
        {
          peerId: "peer-1",
          expert: "Robin Hale",
          rank: "high",
          context: [],
          suggestedContact: "#team-auth",
        },
      ]),
    );
    expect(out).toContain("**Robin Hale** — high confidence, contact #team-auth");
  });

  test("falls back to 'unattributed' when the expert is null", () => {
    const out = renderGhost(
      ghost([
        { peerId: "peer-2", expert: null, rank: "low", context: [], suggestedContact: "#general" },
      ]),
    );
    expect(out).toContain("**unattributed** — low confidence, contact #general");
  });
});

describe("renderConflicts", () => {
  const conflicts = (collisions: ConflictBrief["collisions"]): ConflictBrief =>
    ({
      ...BASE,
      kind: "conflict",
      query: { file: "src/auth/session.ts" },
      startEntityId: null,
      collisions,
    }) as ConflictBrief;

  test("says so plainly when nobody else is touching it", () => {
    expect(renderConflicts(conflicts([]), NOW)).toContain(
      "Nobody else is touching `src/auth/session.ts`",
    );
  });

  test("names who, what kind of collision, and how long ago", () => {
    const out = renderConflicts(
      conflicts([
        {
          peerId: "peer-1",
          who: "Sam Okafor",
          service: "auth",
          collisionType: "open_pr",
          title: "Rework session refresh",
          snippet: "…",
          modifiedAt: NOW - 3 * 60 * 60 * 1000,
        },
      ]),
      NOW,
    );
    expect(out).toContain("**Sam Okafor** — open pr in auth, 3h ago: Rework session refresh");
  });
});

describe("renderHuddle", () => {
  const huddle = (contributions: HuddleBrief["contributions"]): HuddleBrief =>
    ({ ...BASE, kind: "huddle", query: { sinceMs: 86_400_000 }, contributions }) as HuddleBrief;

  test("says so plainly when the window is empty", () => {
    expect(renderHuddle(huddle([]), NOW)).toContain("Nothing to huddle about");
  });

  test("counts each contributor's PRs, tickets and incidents", () => {
    const out = renderHuddle(
      huddle([
        {
          peerId: "peer-1",
          who: "Robin Hale",
          prs: [{ title: "Fix retry", snippet: "", service: "auth", modifiedAt: NOW }],
          tickets: [],
          incidents: [
            { title: "Auth outage", snippet: "", service: "auth", modifiedAt: NOW - 7_200_000 },
          ],
        },
      ]),
      NOW,
    );
    expect(out).toContain("**Robin Hale** — 1 PR, 1 incident");
    expect(out).toContain("Fix retry");
    expect(out).toContain("Auth outage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/briefs-render.test.ts`
Expected: FAIL — cannot resolve `../../src/briefs/render.js`.

- [ ] **Step 3: Write the implementation**

Create `src/briefs/render.ts`:

```ts
import type { ConflictBrief, GhostBrief, HuddleBrief, WhyBrief } from "@nimbus-dev/client";

import { formatRelativeTime } from "../sidebar/relative-time.js";

// Pure brief → markdown. Sink-agnostic by design: the editor surfaces pipe these
// strings into a read-only tab, the chat participant pipes the same strings into
// sink.markdown. One renderer, two sinks.

const LANE_HEADINGS: Record<WhyBrief["findings"][number]["lane"], string> = {
  authorship: "Authorship",
  pull_request: "Pull request",
  ticket: "Ticket",
  discussion: "Discussion",
  driver: "Driver",
  downstream: "Downstream",
};

// Shared with the chat participant's ops commands so a data gap reads the same
// wherever a brief is rendered. A thin brief must never read as a confident one.
export function gapsFooter(brief: { gaps: readonly { detail: string }[] }): string {
  if (brief.gaps.length === 0) return "";
  return `\n\n_Data gaps: ${brief.gaps.map((g) => g.detail).join("; ")}_`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function renderWhy(brief: WhyBrief): string {
  const line = brief.query.line === null ? "" : `:${brief.query.line}`;
  const target = `\`${brief.query.ref}${line}\``;
  // subject.repoRoot is an absolute path on this machine. It is displayed
  // locally, not sent, but echoing it into a tab the user may paste elsewhere
  // leaks it just the same — so only symbol and filePath are rendered.
  const symbol =
    brief.subject?.symbol === null || brief.subject?.symbol === undefined
      ? ""
      : ` (\`${brief.subject.symbol}\`)`;
  if (brief.findings.length === 0) {
    return `No history found for ${target}${symbol}.${gapsFooter(brief)}`;
  }
  const lanes = new Map<string, string[]>();
  for (const f of brief.findings) {
    const heading = LANE_HEADINGS[f.lane];
    const label = f.url === null ? `**${f.title}**` : `[${f.title}](${f.url})`;
    const entry = f.detail.length > 0 ? `- ${label} — ${f.detail}` : `- ${label}`;
    lanes.set(heading, [...(lanes.get(heading) ?? []), entry]);
  }
  const sections = [...lanes].map(([heading, entries]) => `### ${heading}\n${entries.join("\n")}`);
  return `Why ${target}${symbol}:\n\n${sections.join("\n\n")}${gapsFooter(brief)}`;
}

export function renderGhost(brief: GhostBrief): string {
  const target = `\`${brief.query.file}\``;
  if (brief.findings.length === 0) {
    return `No knowledge-holder signals found for ${target} in the local index.${gapsFooter(brief)}`;
  }
  const lines = brief.findings.map((f) => {
    const who = f.expert ?? "unattributed";
    const context =
      f.context.length === 0 ? "" : ` — ${plural(f.context.length, "related item")}`;
    return `- **${who}** — ${f.rank} confidence, contact ${f.suggestedContact}${context}`;
  });
  return `Who knew ${target}:\n${lines.join("\n")}${gapsFooter(brief)}`;
}

export function renderConflicts(brief: ConflictBrief, now: number): string {
  const target = `\`${brief.query.file}\``;
  if (brief.collisions.length === 0) {
    return `Nobody else is touching ${target} right now.${gapsFooter(brief)}`;
  }
  const lines = brief.collisions.map((c) => {
    const who = c.who ?? "unattributed";
    const kind = c.collisionType.replace(/_/g, " ");
    const when = formatRelativeTime(now, c.modifiedAt);
    return `- **${who}** — ${kind} in ${c.service}, ${when}: ${c.title}`;
  });
  return `Also touching ${target}:\n${lines.join("\n")}${gapsFooter(brief)}`;
}

export function renderHuddle(brief: HuddleBrief, now: number): string {
  if (brief.contributions.length === 0) {
    return `Nothing to huddle about in this window.${gapsFooter(brief)}`;
  }
  const blocks = brief.contributions.map((c) => {
    const who = c.who ?? "unattributed";
    const counts: string[] = [];
    if (c.prs.length > 0) counts.push(plural(c.prs.length, "PR"));
    if (c.tickets.length > 0) counts.push(plural(c.tickets.length, "ticket"));
    if (c.incidents.length > 0) counts.push(plural(c.incidents.length, "incident"));
    const items = [...c.prs, ...c.tickets, ...c.incidents].map(
      (i) => `  - ${i.title} (${i.service}, ${formatRelativeTime(now, i.modifiedAt)})`,
    );
    const header = `- **${who}** — ${counts.length === 0 ? "no activity" : counts.join(", ")}`;
    return items.length === 0 ? header : `${header}\n${items.join("\n")}`;
  });
  return `Team huddle:\n${blocks.join("\n")}${gapsFooter(brief)}`;
}
```

- [ ] **Step 4: Point `ops-commands.ts` at the shared footer**

In `src/chat-participant/ops-commands.ts`, delete these lines (currently 18-23):

```ts
type Gapped = { gaps: Array<{ detail: string }> };

function gapsFooter(brief: Gapped): string {
  if (brief.gaps.length === 0) return "";
  return `\n\n_Data gaps: ${brief.gaps.map((g) => g.detail).join("; ")}_`;
}
```

and add to the import block at the top of the file:

```ts
import { gapsFooter } from "../briefs/render.js";
```

Nothing else in that file changes — the call sites already read `gapsFooter(brief)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/briefs-render.test.ts test/unit/ops-commands.test.ts`
Expected: PASS. `ops-commands.test.ts` must still pass unchanged — that is the proof the lift was behaviour-preserving.

- [ ] **Step 6: Commit**

```bash
git add src/briefs/render.ts src/chat-participant/ops-commands.ts test/unit/briefs-render.test.ts
git commit -m "feat(briefs): render why, ghost, conflicts and huddle to markdown"
```

---

### Task 3: Cursor position on the shim, and safe params

`agentsWhy` needs `{ref, line}`, and `TextEditorLike` currently exposes only `selection.isEmpty` — there is no cursor. This task widens the shim and adds the module that guarantees no absolute path becomes a parameter.

**Files:**
- Modify: `src/vscode-shim.ts:82-85`
- Modify: `test/unit/extension.test.ts:307`, `test/unit/scm-commands.test.ts:576` (the only two fixtures that build a `selection`)
- Create: `src/briefs/params.ts`
- Test: `test/unit/briefs-params.test.ts`

**Interfaces:**
- Consumes: `BriefId` from Task 1.
- Produces: `interface EditorTarget { ref: string; line: number }`; `function toRelativeRef(fileName: string, roots: readonly string[]): string`; `function whyParams(t: EditorTarget): { ref: string; line: number }`; `function fileParams(t: EditorTarget): { file: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/briefs-params.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { fileParams, toRelativeRef, whyParams } from "../../src/briefs/params.js";

describe("toRelativeRef", () => {
  const roots = ["/home/dev/proj"];

  test("strips a matching workspace root", () => {
    expect(toRelativeRef("/home/dev/proj/src/auth/session.ts", roots)).toBe("src/auth/session.ts");
  });

  test("normalises Windows separators so the Gateway sees one shape", () => {
    expect(toRelativeRef("C:\\work\\proj\\src\\a.ts", ["C:\\work\\proj"])).toBe("src/a.ts");
  });

  test("falls back to the basename when no root matches — never an absolute path", () => {
    expect(toRelativeRef("/etc/hosts", roots)).toBe("hosts");
    expect(toRelativeRef("C:\\Users\\dev\\notes.md", roots)).toBe("notes.md");
  });

  test("picks the longest matching root, so a nested folder wins", () => {
    expect(
      toRelativeRef("/home/dev/proj/pkg/src/a.ts", ["/home/dev/proj", "/home/dev/proj/pkg"]),
    ).toBe("src/a.ts");
  });

  test("never returns a leading separator", () => {
    expect(toRelativeRef("/home/dev/proj/a.ts", roots).startsWith("/")).toBe(false);
  });

  test("an empty root list still yields a basename", () => {
    expect(toRelativeRef("/home/dev/proj/src/a.ts", [])).toBe("a.ts");
  });
});

describe("params", () => {
  test("whyParams carries the ref and the line", () => {
    expect(whyParams({ ref: "src/a.ts", line: 42 })).toEqual({ ref: "src/a.ts", line: 42 });
  });

  test("fileParams carries the file only", () => {
    expect(fileParams({ ref: "src/a.ts", line: 42 })).toEqual({ file: "src/a.ts" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/briefs-params.test.ts`
Expected: FAIL — cannot resolve `../../src/briefs/params.js`.

- [ ] **Step 3: Write the implementation**

Create `src/briefs/params.ts`:

```ts
// Editor context → brief parameters.
//
// The one invariant this module exists to hold: an absolute path never becomes
// a parameter. A repo-relative ref is more useful to the Gateway than a bare
// basename, and it carries no home directory — but when no workspace root
// matches, the basename is the safe floor.

export interface EditorTarget {
  /** Already relative — the output of toRelativeRef. */
  ref: string;
  /** Zero-based, as VS Code reports the cursor line. */
  line: number;
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/");
}

function basename(p: string): string {
  const segments = normalise(p).split("/");
  return segments.at(-1) ?? p;
}

export function toRelativeRef(fileName: string, roots: readonly string[]): string {
  const file = normalise(fileName);
  // Longest root first: with nested folders open, the innermost is the useful
  // one, and a shorter parent would otherwise win by appearing earlier.
  const sorted = [...roots].map(normalise).sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (file.startsWith(prefix)) return file.slice(prefix.length);
  }
  return basename(file);
}

export function whyParams(t: EditorTarget): { ref: string; line: number } {
  return { ref: t.ref, line: t.line };
}

export function fileParams(t: EditorTarget): { file: string } {
  return { file: t.ref };
}
```

- [ ] **Step 4: Widen the shim**

In `src/vscode-shim.ts`, replace lines 82-85:

```ts
export interface TextEditorLike {
  document: { getText(range?: unknown): string; fileName: string; languageId: string };
  selection: { isEmpty: boolean };
}
```

with:

```ts
export interface TextEditorLike {
  document: { getText(range?: unknown): string; fileName: string; languageId: string };
  // `active` is the cursor end of the selection — zero-based, straight from
  // vscode.Selection. agentsWhy({ref, line}) needs it; nothing else does yet.
  selection: { isEmpty: boolean; active: { line: number } };
}
```

- [ ] **Step 5: Update the two fixtures that build a selection**

`test/unit/extension.test.ts:307` — change:

```ts
            selection: { isEmpty: opts.activeEditor.empty ?? false },
```

to:

```ts
            selection: {
              isEmpty: opts.activeEditor.empty ?? false,
              active: { line: opts.activeEditor.line ?? 0 },
            },
```

Then find the type of that `opts.activeEditor` object literal in the same file and add an optional `line?: number` field to it.

`test/unit/scm-commands.test.ts:576` — change:

```ts
        selection: { isEmpty: selectionText === undefined },
```

to:

```ts
        selection: { isEmpty: selectionText === undefined, active: { line: 0 } },
```

- [ ] **Step 6: Run the full suite plus typecheck**

Run: `bun run typecheck && bun run test`
Expected: PASS. If typecheck reports another `TextEditorLike` literal missing `active`, add `active: { line: 0 }` to it — the grep in Step 5 covered the two that exist today.

- [ ] **Step 7: Commit**

```bash
git add src/briefs/params.ts src/vscode-shim.ts test/unit/briefs-params.test.ts test/unit/extension.test.ts test/unit/scm-commands.test.ts
git commit -m "feat(briefs): derive brief params from the editor without leaking paths"
```

---

### Task 4: The `"brief"` egress kind

Brief calls become a first-class, prompting, skippable egress surface. This is a decision-table change plus one wrapper — no new gate logic.

**Files:**
- Modify: `src/egress/preflight.ts:5`
- Modify: `src/egress/skip-store.ts:5-12`
- Modify: `src/egress/gate.ts:15-18,24-30`
- Modify: `src/egress/gated-client.ts` (append)
- Test: `test/unit/egress-gate.test.ts` (add), `test/unit/egress-gated-client.test.ts` (add)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface RawBriefClient`; `interface GatedBriefs { why(p, meta, title); ghost(p, meta, title); conflicts(p, meta, title); huddle(p, meta, title) }`; `function gateRawBriefs(client: RawBriefClient, gate: EgressGate, withProgress?: ProgressRunner): GatedBriefs`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/egress-gate.test.ts` (inside the top-level `describe`, or as a new one — match the file's existing style and reuse its harness helper for building a gate):

```ts
describe("the brief kind", () => {
  test("prompts, like the other context-assembling surfaces", async () => {
    const h = harness({ answer: "Send" });
    const decision = await h.gate.check("brief", '{"ref":"src/a.ts","line":42}', {
      action: "Why is this here? (agents.why)",
      files: [{ name: "src/a.ts:42", note: "the extension sends this path, not the file's contents" }],
      omissions: [],
    });
    expect(decision).toBe("send");
    expect(h.modals.length).toBe(1);
  });

  test("offers an Always-send button labelled for the surface", async () => {
    const h = harness({ answer: "Always send Agent Briefs here" });
    await h.gate.check("brief", "{}", { action: "Team huddle", files: [], omissions: [] });
    expect(h.skips.isSkipped("brief")).toBe(true);
  });

  test("a stored skip suppresses the modal", async () => {
    const h = harness({ answer: "Send" });
    await h.skips.setSkipped("brief");
    const decision = await h.gate.check("brief", "{}", {
      action: "Team huddle",
      files: [],
      omissions: [],
    });
    expect(decision).toBe("send");
    expect(h.modals.length).toBe(0);
  });

  test("fails closed when the modal is dismissed", async () => {
    const h = harness({ answer: undefined });
    const decision = await h.gate.check("brief", "{}", {
      action: "Team huddle",
      files: [],
      omissions: [],
    });
    expect(decision).toBe("cancel");
  });
});
```

Append to `test/unit/egress-gated-client.test.ts`:

```ts
describe("gateRawBriefs", () => {
  const brief = { agentVersion: 1, generatedAt: 0, latencyMs: 1, gaps: [] };

  function fakeClient(calls: unknown[]) {
    return {
      agentsWhy: async (p: unknown) => {
        calls.push(["why", p]);
        return { ...brief, kind: "why", query: { ref: "a", line: null }, subject: null, findings: [] };
      },
      agentsGhost: async (p: unknown) => {
        calls.push(["ghost", p]);
        return { ...brief, kind: "ghost", query: { file: "a" }, startEntityId: null, findings: [] };
      },
      agentsConflicts: async (p: unknown) => {
        calls.push(["conflicts", p]);
        return { ...brief, kind: "conflict", query: { file: "a" }, startEntityId: null, collisions: [] };
      },
      agentsHuddle: async (p: unknown) => {
        calls.push(["huddle", p]);
        return { ...brief, kind: "huddle", query: { sinceMs: 1 }, contributions: [] };
      },
    } as never;
  }

  test("sends the params as the verbatim prompt, pretty-printed", async () => {
    const seen: Array<{ kind: string; prompt: string }> = [];
    const gate = {
      check: async (kind: string, prompt: string) => {
        seen.push({ kind, prompt });
        return "send" as const;
      },
      record: () => undefined,
      lastPayload: () => undefined,
    } as never;
    const briefs = gateRawBriefs(fakeClient([]), gate);
    await briefs.why({ ref: "src/a.ts", line: 42 }, { action: "Why", files: [], omissions: [] }, "…");
    expect(seen[0]?.kind).toBe("brief");
    expect(seen[0]?.prompt).toBe('{\n  "ref": "src/a.ts",\n  "line": 42\n}');
  });

  test("throws EgressCancelled and never calls the client when the gate cancels", async () => {
    const calls: unknown[] = [];
    const gate = {
      check: async () => "cancel" as const,
      record: () => undefined,
      lastPayload: () => undefined,
    } as never;
    const briefs = gateRawBriefs(fakeClient(calls), gate);
    await expect(
      briefs.ghost({ file: "src/a.ts" }, { action: "Ghost", files: [], omissions: [] }, "…"),
    ).rejects.toThrow(EgressCancelled);
    expect(calls).toEqual([]);
  });

  test("shows progress only after the gate clears", async () => {
    const order: string[] = [];
    const gate = {
      check: async () => {
        order.push("gate");
        return "send" as const;
      },
      record: () => undefined,
      lastPayload: () => undefined,
    } as never;
    const briefs = gateRawBriefs(fakeClient([]), gate, async (_t, body) => {
      order.push("progress");
      return body();
    });
    await briefs.huddle({}, { action: "Huddle", files: [], omissions: [] }, "…");
    expect(order).toEqual(["gate", "progress"]);
  });
});
```

Add `gateRawBriefs` to that file's import from `../../src/egress/gated-client.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/egress-gate.test.ts test/unit/egress-gated-client.test.ts`
Expected: FAIL — `gateRawBriefs` is not exported; `"brief"` is not assignable to `EgressKind`.

- [ ] **Step 3: Widen the three type-level tables**

`src/egress/preflight.ts:5`:

```ts
export type EgressKind = "quickAsk" | "scm" | "ask" | "participant" | "lmTool" | "brief";
```

`src/egress/skip-store.ts:5-12` — replace the type and the KEYS map:

```ts
// The surfaces where the EXTENSION chooses what is sent and therefore prompts:
// the two context-assembling ones, plus the built-in briefs, whose parameters
// the extension derives from the editor rather than from something the user
// typed.
export type SkippableKind = "quickAsk" | "scm" | "brief";

const KEYS: Record<SkippableKind, string> = {
  quickAsk: "nimbus.preflight.skip.quickAsk",
  scm: "nimbus.preflight.skip.scm",
  brief: "nimbus.preflight.skip.brief",
};
```

`src/egress/gate.ts:15-18`:

```ts
export const SKIP_LABEL: Record<SkippableKind, string> = {
  quickAsk: "Quick Ask",
  scm: "Source Control",
  brief: "Agent Briefs",
};
```

`src/egress/gate.ts:24-30` — replace the comment and function:

```ts
// Only the surfaces where the EXTENSION decides what is sent prompt. Ask and
// the participant are text the user just typed; the LM tool is confirmed
// upstream by its own inline card. Briefs prompt because the extension derives
// their parameters from the editor, not from a user keystroke.
function skippableKind(kind: EgressKind): SkippableKind | undefined {
  if (kind === "quickAsk" || kind === "scm" || kind === "brief") return kind;
  return undefined;
}
```

- [ ] **Step 4: Add the brief wrapper**

Append to `src/egress/gated-client.ts`:

```ts
// ---------------------------------------------------------------------------
// Briefs.
//
// The `agents*` family is agent-bound too: the Gateway composes a `brief`
// string from a model. The params are structured rather than assembled prose,
// but a `file`/`ref` is exactly what the leak-check scans for, so these route
// through the same seam and the same gate.
//
// Keeping the `.agentsX(` call shapes in THIS file is what lets
// egress-choke-point.test.ts allowlist consumers that only ever hold the
// injected GatedBriefs seam.

export interface RawBriefClient {
  agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>;
  agentsGhost(p: GhostParams, o?: { timeoutMs?: number }): Promise<GhostBrief>;
  agentsConflicts(p: ConflictsParams, o?: { timeoutMs?: number }): Promise<ConflictBrief>;
  agentsHuddle(p?: HuddleParams, o?: { timeoutMs?: number }): Promise<HuddleBrief>;
}

/** A brief call that has already passed the gate. Throws EgressCancelled if not. */
export type GatedBrief<P, B> = (p: P, meta: EgressMeta, progressTitle: string) => Promise<B>;

export interface GatedBriefs {
  why: GatedBrief<WhyParams, WhyBrief>;
  ghost: GatedBrief<GhostParams, GhostBrief>;
  conflicts: GatedBrief<ConflictsParams, ConflictBrief>;
  huddle: GatedBrief<HuddleParams, HuddleBrief>;
}

export function gateRawBriefs(
  client: RawBriefClient,
  gate: EgressGate,
  withProgress: ProgressRunner = (_title, body) => body(),
): GatedBriefs {
  // The seam stringifies, so no call site can send a shape the manifest did not
  // show. Pretty-printed because the modal's "Show full text" renders it raw.
  const run = async <P, B>(
    call: (p: P) => Promise<B>,
    p: P,
    meta: EgressMeta,
    progressTitle: string,
  ): Promise<B> => {
    if ((await gate.check("brief", JSON.stringify(p, null, 2), meta)) === "cancel") {
      throw new EgressCancelled();
    }
    return withProgress(progressTitle, () => call(p));
  };

  return {
    why: (p, meta, title) => run((q: WhyParams) => client.agentsWhy(q), p, meta, title),
    ghost: (p, meta, title) => run((q: GhostParams) => client.agentsGhost(q), p, meta, title),
    conflicts: (p, meta, title) =>
      run((q: ConflictsParams) => client.agentsConflicts(q), p, meta, title),
    huddle: (p, meta, title) => run((q: HuddleParams) => client.agentsHuddle(q), p, meta, title),
  };
}
```

Add to the top of the same file:

```ts
import type {
  ConflictBrief,
  ConflictsParams,
  GhostBrief,
  GhostParams,
  HuddleBrief,
  HuddleParams,
  WhyBrief,
  WhyParams,
} from "@nimbus-dev/client";
```

If `ConflictsParams` / `GhostParams` / `HuddleParams` / `WhyParams` are not re-exported from the package root, import them from `@nimbus-dev/client/dist/agents.js` types via `import type { ... } from "@nimbus-dev/client"` first and only fall back if typecheck rejects it — verify with `bun run typecheck` before assuming.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run typecheck && bunx vitest run test/unit/egress-gate.test.ts test/unit/egress-gated-client.test.ts test/unit/egress-skip-store.test.ts test/unit/egress-preflight.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/egress/ test/unit/egress-gate.test.ts test/unit/egress-gated-client.test.ts
git commit -m "feat(egress): add the brief kind and route agents* through the choke point"
```

---

### Task 5: Grow the choke-point guard

**Files:**
- Modify: `test/unit/egress-choke-point.test.ts`

**Interfaces:**
- Consumes: `gateRawBriefs` from Task 4.
- Produces: nothing consumed by later tasks.

**Why the list is only four calls.** `ops-commands.ts` still calls `agentsImpact`, `agentsExpert` and `agentsCatchup` on a raw client; routing them is PR 3. Listing them here would force adding `ops-commands.ts` to `ALLOWED` while it is still ungated — a guard that passes for the wrong reason. Guard what this PR actually routes; PR 3 widens both the list and `ALLOWED` together.

- [ ] **Step 1: Write the failing test**

In `test/unit/egress-choke-point.test.ts`, after the existing `CALLS` constant, add:

```ts
// The agents* briefs this PR routes through the gate. Deliberately NOT the full
// family: ops-commands.ts still calls agentsImpact/agentsExpert/agentsCatchup
// raw, and PR 3 routes them and extends this list in the same change. A name
// listed here before it is routed would only force a bogus ALLOWED entry.
const GATED_BRIEF_CALLS = [
  ".agentsWhy(",
  ".agentsGhost(",
  ".agentsConflicts(",
  ".agentsHuddle(",
];
```

and add these tests inside the existing `describe`:

```ts
  for (const call of GATED_BRIEF_CALLS) {
    test(`${call} appears only in the choke point`, () => {
      const offenders = listTsFiles(SRC)
        .map(norm)
        .filter((f) => readFileSync(join(REPO, f), "utf8").includes(call))
        .filter((f) => !f.endsWith("egress/gated-client.ts"));
      expect(offenders).toEqual([]);
    });
  }

  test("extension.ts never touches the raw client's brief methods", () => {
    const src = readFileSync(join(SRC, "extension.ts"), "utf8");
    for (const member of GATED_BRIEF_CALLS.map((c) => c.slice(0, -1))) {
      expect(src).not.toContain(member);
    }
  });

  test("the choke point really does contain every gated brief call shape", () => {
    const gated = readFileSync(join(SRC, "egress", "gated-client.ts"), "utf8");
    for (const call of GATED_BRIEF_CALLS) expect(gated).toContain(call);
  });
```

- [ ] **Step 2: Run the test**

Run: `bunx vitest run test/unit/egress-choke-point.test.ts`
Expected: PASS immediately — Task 4 already put every call shape inside `gated-client.ts`. If any test fails, a brief call leaked outside the choke point; move it, do not widen the allowlist.

- [ ] **Step 3: Prove the guard actually bites**

Temporarily add `const x = client.agentsWhy({ ref: "a" });` to `src/extension.ts`, run `bunx vitest run test/unit/egress-choke-point.test.ts`, and confirm it FAILS. Then remove the line and confirm it passes again. A guard never seen failing is not known to work.

- [ ] **Step 4: Commit**

```bash
git add test/unit/egress-choke-point.test.ts
git commit -m "test(egress): guard the four gated brief call shapes"
```

---

### Task 6: The brief commands

The glue: resolve editor context, call the gated seam, render, open a tab. Modelled directly on `src/scm/commands.ts` — same `contain` error wrapper, same injected-deps shape.

**Files:**
- Create: `src/briefs/commands.ts`
- Test: `test/unit/briefs-commands.test.ts`

**Interfaces:**
- Consumes: `BriefId`, `briefSpec` (Task 1); `renderWhy`/`renderGhost`/`renderConflicts`/`renderHuddle` (Task 2); `toRelativeRef`, `whyParams`, `fileParams`, `EditorTarget` (Task 3); `GatedBriefs` (Task 4).
- Produces: `interface BriefCommandDeps`; `interface BriefCommands { why(args?: EditorTarget): Promise<void>; ghost(args?: EditorTarget): Promise<void>; conflicts(args?: EditorTarget): Promise<void>; huddle(): Promise<void> }`; `function createBriefCommands(deps: BriefCommandDeps): BriefCommands`.

The optional `args` is the contract the spec requires: given a target it uses it, and only when called bare does it read the active editor. PR 2's hover link passes `{ref, line}` so the full brief answers about the line the user clicked.

- [ ] **Step 1: Write the failing test**

Create `test/unit/briefs-commands.test.ts`:

```ts
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
  test("why reads the cursor line and sends a repo-relative ref", async () => {
    const h = harness();
    await createBriefCommands(h.deps).why();
    expect(h.calls[0]?.brief).toBe("why");
    expect(h.calls[0]?.params).toEqual({ ref: "src/a.ts", line: 6 });
  });

  test("why prefers pre-resolved args over the active editor", async () => {
    const h = harness();
    await createBriefCommands(h.deps).why({ ref: "src/other.ts", line: 99 });
    expect(h.calls[0]?.params).toEqual({ ref: "src/other.ts", line: 99 });
  });

  test("the manifest names the path and says contents are not sent", async () => {
    const h = harness();
    await createBriefCommands(h.deps).ghost();
    expect(h.calls[0]?.meta).toEqual({
      action: "Who knew this code? (agents.ghost)",
      files: [
        { name: "src/a.ts", note: "the extension sends this path, not the file's contents" },
      ],
      omissions: [],
    });
  });

  test("huddle needs no editor and sends no files", async () => {
    const h = harness({ activeEditor: () => undefined });
    await createBriefCommands(h.deps).huddle();
    expect(h.calls[0]?.brief).toBe("huddle");
    expect(h.calls[0]?.meta).toEqual({ action: "Team huddle (agents.huddle)", files: [], omissions: [] });
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
    const h = harness({
      // Answer "Retry" once, then dismiss, so the recursion terminates.
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
      { ref: "src/a.ts", line: 3 },
      { ref: "src/a.ts", line: 3 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/briefs-commands.test.ts`
Expected: FAIL — cannot resolve `../../src/briefs/commands.js`.

- [ ] **Step 3: Write the implementation**

Create `src/briefs/commands.ts`:

```ts
import type { GatedBriefs } from "../egress/gated-client.js";
import { isEgressCancelled } from "../egress/gated-client.js";
import type { EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import type { MessageOptionsLike, TextEditorLike } from "../vscode-shim.js";
import { type BriefId, briefSpec } from "./catalog.js";
import { type EditorTarget, fileParams, toRelativeRef, whyParams } from "./params.js";
import { renderConflicts, renderGhost, renderHuddle, renderWhy } from "./render.js";

// What the manifest says about a brief's file. The extension sends a path; what
// the Gateway does after is the egress ledger's business, not a claim this
// surface is entitled to make. See the design doc's "Egress" section.
export const BRIEF_FILE_NOTE = "the extension sends this path, not the file's contents";

const RETRY = "Retry";

export interface BriefCommandDeps {
  /** undefined = disconnected. */
  briefs(): GatedBriefs | undefined;
  activeEditor(): TextEditorLike | undefined;
  /** Workspace folder paths, for relativising the editor's file name. */
  roots(): readonly string[];
  /** Injected so relative times in rendered briefs stay deterministic in tests. */
  now(): number;
  openReadonly(title: string, content: string): Promise<void>;
  window: {
    showErrorMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
    showInformationMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
  };
  log: Logger;
}

export interface BriefCommands {
  why(args?: EditorTarget): Promise<void>;
  ghost(args?: EditorTarget): Promise<void>;
  conflicts(args?: EditorTarget): Promise<void>;
  huddle(): Promise<void>;
}

function meta(id: BriefId, target: EditorTarget | undefined): EgressMeta {
  const spec = briefSpec(id);
  const action = `${spec.label} (agents.${id})`;
  if (target === undefined) return { action, files: [], omissions: [] };
  const name = spec.context === "fileAndLine" ? `${target.ref}:${target.line}` : target.ref;
  return { action, files: [{ name, note: BRIEF_FILE_NOTE }], omissions: [] };
}

export function createBriefCommands(deps: BriefCommandDeps): BriefCommands {
  // Resolve pre-supplied args first: that is what lets one command serve the
  // editor menu, the sidebar row, and (in PR 2) the hover's [Why?] link without
  // re-deriving a location the caller already knows.
  const target = (args?: EditorTarget): EditorTarget | undefined => {
    if (args !== undefined) return args;
    const editor = deps.activeEditor();
    if (editor === undefined) return undefined;
    return {
      ref: toRelativeRef(editor.document.fileName, deps.roots()),
      line: editor.selection.active.line,
    };
  };

  // One place for the whole failure story: cancelled is silent, everything else
  // shows the message verbatim with a Retry that re-runs the SAME resolved
  // args. Retry goes back through the gate — it is a new send and gets no
  // bypass for having been attempted once.
  const contain = async (id: BriefId, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (e) {
      if (isEgressCancelled(e)) {
        deps.log.debug(`nimbus.brief.${id} cancelled at the pre-flight preview`);
        return;
      }
      deps.log.error(`nimbus.brief.${id} failed: ${errMsg(e)}`);
      const answer = await deps.window.showErrorMessage(
        `Nimbus ${briefSpec(id).label} failed: ${errMsg(e)}`,
        {},
        RETRY,
      );
      if (answer === RETRY) await contain(id, body);
    }
  };

  const connected = (): GatedBriefs | undefined => {
    const briefs = deps.briefs();
    if (briefs === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to the Gateway.");
    }
    return briefs;
  };

  const needTarget = (id: BriefId, args?: EditorTarget): EditorTarget | undefined => {
    const t = target(args);
    if (t === undefined) {
      void deps.window.showInformationMessage(
        `Nimbus: Open a file to run "${briefSpec(id).label}".`,
      );
    }
    return t;
  };

  const show = async (id: BriefId, content: string): Promise<void> => {
    await deps.openReadonly(`Nimbus — ${briefSpec(id).label}.md`, content);
  };

  return {
    why: (args) =>
      contain("why", async () => {
        const t = needTarget("why", args);
        if (t === undefined) return;
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.why(whyParams(t), meta("why", t), "Nimbus: asking why…");
        await show("why", renderWhy(brief));
      }),

    ghost: (args) =>
      contain("ghost", async () => {
        const t = needTarget("ghost", args);
        if (t === undefined) return;
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.ghost(
          fileParams(t),
          meta("ghost", t),
          "Nimbus: finding who knew this…",
        );
        await show("ghost", renderGhost(brief));
      }),

    conflicts: (args) =>
      contain("conflicts", async () => {
        const t = needTarget("conflicts", args);
        if (t === undefined) return;
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.conflicts(
          fileParams(t),
          meta("conflicts", t),
          "Nimbus: checking for collisions…",
        );
        await show("conflicts", renderConflicts(brief, deps.now()));
      }),

    huddle: () =>
      contain("huddle", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.huddle({}, meta("huddle", undefined), "Nimbus: gathering the huddle…");
        await show("huddle", renderHuddle(brief, deps.now()));
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bunx vitest run test/unit/briefs-commands.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/commands.ts test/unit/briefs-commands.test.ts
git commit -m "feat(briefs): add the four editor brief commands"
```

---

### Task 7: Manifest contributions

**Files:**
- Modify: `package.json` (`contributes.commands`, `contributes.menus.editor/context`, `contributes.menus.commandPalette`)
- Create: `test/unit/manifest-briefs.test.ts`

**Interfaces:**
- Consumes: the four command ids from Task 1's catalog.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/unit/manifest-briefs.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG } from "../../src/briefs/catalog.js";

type Command = { command: string; title: string; category?: string };
type MenuEntry = { command: string; when?: string; group?: string };

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes?: {
    commands?: Command[];
    menus?: { "editor/context"?: MenuEntry[]; commandPalette?: MenuEntry[] };
  };
};

const commands = manifest.contributes?.commands ?? [];
const editorContext = manifest.contributes?.menus?.["editor/context"] ?? [];
const palette = manifest.contributes?.menus?.commandPalette ?? [];

describe("extension manifest: briefs", () => {
  test("every catalog brief is a contributed command under the Nimbus category", () => {
    for (const spec of BRIEF_CATALOG) {
      const entry = commands.find((c) => c.command === spec.command);
      expect(entry, `${spec.command} must be contributed`).toBeDefined();
      expect(entry?.title).toBe(spec.label);
      expect(entry?.category).toBe("Nimbus");
    }
  });

  test("the file-scoped briefs appear in the editor context menu", () => {
    for (const spec of BRIEF_CATALOG.filter((b) => b.context !== "none")) {
      const entry = editorContext.find((e) => e.command === spec.command);
      expect(entry, `${spec.command} must be in editor/context`).toBeDefined();
      expect(entry?.when).toBe("editorTextFocus");
    }
  });

  test("huddle needs no editor, so it is not in the editor context menu", () => {
    expect(editorContext.find((e) => e.command === "nimbus.brief.huddle")).toBeUndefined();
  });

  // Opening the palette moves focus off the editor, so a focus clause would
  // hide the command exactly when it is being searched for. Same rule
  // manifest-command-palette.test.ts already enforces globally.
  test("palette entries for briefs never gate on keyboard focus", () => {
    for (const spec of BRIEF_CATALOG) {
      const entry = palette.find((e) => e.command === spec.command);
      if (entry?.when !== undefined) expect(entry.when).not.toContain("Focus");
    }
  });

  test("the file-scoped briefs are palette-gated on an open editor", () => {
    for (const spec of BRIEF_CATALOG.filter((b) => b.context !== "none")) {
      expect(palette.find((e) => e.command === spec.command)?.when).toBe("editorIsOpen");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/manifest-briefs.test.ts`
Expected: FAIL — `nimbus.brief.why must be contributed`.

- [ ] **Step 3: Add the commands**

In `package.json`, inside `contributes.commands`, after the `nimbus.generateDocstrings` entry, add:

```json
      {
        "command": "nimbus.brief.why",
        "title": "Why is this here?",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.brief.ghost",
        "title": "Who knew this code?",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.brief.conflicts",
        "title": "Who else is touching this?",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.brief.huddle",
        "title": "Team huddle",
        "category": "Nimbus"
      }
```

- [ ] **Step 4: Add the menu entries**

In `contributes.menus["editor/context"]`, after the existing `nimbus@` entries, add (renumber the `group` suffixes so they continue the existing sequence — read the array first and continue from its highest `nimbus@N`):

```json
        {
          "command": "nimbus.brief.why",
          "when": "editorTextFocus",
          "group": "nimbus@7"
        },
        {
          "command": "nimbus.brief.ghost",
          "when": "editorTextFocus",
          "group": "nimbus@8"
        },
        {
          "command": "nimbus.brief.conflicts",
          "when": "editorTextFocus",
          "group": "nimbus@9"
        }
```

In `contributes.menus.commandPalette`, add:

```json
        {
          "command": "nimbus.brief.why",
          "when": "editorIsOpen"
        },
        {
          "command": "nimbus.brief.ghost",
          "when": "editorIsOpen"
        },
        {
          "command": "nimbus.brief.conflicts",
          "when": "editorIsOpen"
        }
```

`nimbus.brief.huddle` gets no palette entry: with no `when` clause it is always available, which is correct for a zero-argument command.

- [ ] **Step 5: Run the manifest tests**

Run: `bunx vitest run test/unit/manifest-briefs.test.ts test/unit/manifest-command-palette.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json test/unit/manifest-briefs.test.ts
git commit -m "feat(briefs): contribute the four brief commands and menu entries"
```

---

### Task 8: Wire it in `extension.ts`

**Files:**
- Modify: `src/extension.ts` (imports; the seam near the `createScmCommands` block at ~603; the `register(...)` block at ~1197)

**Interfaces:**
- Consumes: `createBriefCommands` (Task 6), `gateRawBriefs` (Task 4).
- Produces: four registered commands.

- [ ] **Step 1: Add the imports**

Near the existing `import { createScmCommands } from "./scm/commands.js";`, add:

```ts
import { createBriefCommands } from "./briefs/commands.js";
```

and add `gateRawBriefs` to the existing named import from `./egress/gated-client.js`.

- [ ] **Step 2: Build the commands next to the SCM block**

Immediately after the `const scm = createScmCommands({...});` block (~line 603-620), add:

```ts
  const briefCommands = createBriefCommands({
    briefs: () => {
      const client = nimbus();
      return client === undefined ? undefined : gateRawBriefs(client, egressGate, runWithProgress);
    },
    activeEditor: () => deps.window.activeTextEditor,
    roots: () => workspaceRoots(),
    now: () => Date.now(),
    openReadonly: openReadonlyJson,
    window: deps.window,
    log,
  });
```

`workspaceRoots()` supplies the leak-check needles elsewhere in this file — find the existing helper that feeds `roots:` into `createEgressGate` (search for `roots:` in `src/extension.ts`) and reuse it verbatim rather than writing a second one. If it is an inline arrow, extract it to a named `const workspaceRoots = () => ...` above both call sites and use it in both.

- [ ] **Step 3: Register the commands**

After the existing `register("nimbus.generateDocstrings", ...)` line (~1200), add:

```ts
  register("nimbus.brief.why", (args?: { ref: string; line: number }) => briefCommands.why(args));
  register("nimbus.brief.ghost", (args?: { ref: string; line: number }) =>
    briefCommands.ghost(args),
  );
  register("nimbus.brief.conflicts", (args?: { ref: string; line: number }) =>
    briefCommands.conflicts(args),
  );
  register("nimbus.brief.huddle", () => briefCommands.huddle());
```

- [ ] **Step 4: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS, including `egress-choke-point.test.ts` — `extension.ts` names `gateRawBriefs` but never writes `.agentsWhy` and friends.

- [ ] **Step 5: Build and verify the bundle invariants**

Run: `bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs`
Expected: all PASS. `check-settings-docs` passes unchanged because this PR adds no settings.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat(briefs): register the brief commands and wire the gated seam"
```

---

### Task 9: The Agents view shows the built-ins

**Files:**
- Modify: `src/sidebar/agents.ts` (append)
- Modify: `src/sidebar/agents-view.ts`
- Test: `test/unit/agents.test.ts` (append)

**Interfaces:**
- Consumes: `BRIEF_CATALOG` (Task 1), `agentsToRows` (existing).
- Produces: `function builtInBriefRows(): SidebarItem[]`; `function agentsTreeRows(agents: Agent[], activeAgentId?: string): SidebarItem[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents.test.ts`:

```ts
describe("agentsTreeRows", () => {
  test("renders two labelled groups", () => {
    const rows = agentsTreeRows([{ id: "a", label: "my-reviewer" }]);
    expect(rows.map((r) => r.label)).toEqual(["Built-in briefs", "Configured agents"]);
  });

  test("the built-in group lists every catalog brief and each row runs its command", () => {
    const group = agentsTreeRows([])[0];
    expect(group?.children?.map((c) => c.label)).toEqual(BRIEF_CATALOG.map((b) => b.label));
    for (const [i, child] of (group?.children ?? []).entries()) {
      expect(child.command?.command).toBe(BRIEF_CATALOG[i]?.command);
      expect(child.command?.arguments).toBeUndefined();
    }
  });

  test("both groups render collapsible, because both have children", () => {
    const rows = agentsTreeRows([{ id: "a", label: "my-reviewer" }]);
    for (const row of rows) expect((row.children ?? []).length).toBeGreaterThan(0);
  });

  test("with no configured agents the second group keeps settings discoverable", () => {
    const configured = agentsTreeRows([])[1];
    expect(configured?.children?.length).toBe(1);
    expect(configured?.children?.[0]?.label).toBe("Configure agents in settings…");
    expect(configured?.children?.[0]?.command?.command).toBe("workbench.action.openSettings");
  });

  test("configured agents keep their existing chat click and active marker", () => {
    const configured = agentsTreeRows([{ id: "a", label: "my-reviewer" }], "a")[1];
    const row = configured?.children?.[0];
    expect(row?.command?.command).toBe("nimbus.openAgentChat");
    expect(row?.description).toContain("(active)");
  });
});
```

Add to that file's imports:

```ts
import { BRIEF_CATALOG } from "../../src/briefs/catalog.js";
import { agentsTreeRows } from "../../src/sidebar/agents.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/agents.test.ts`
Expected: FAIL — `agentsTreeRows` is not exported.

- [ ] **Step 3: Write the implementation**

Add this import at the **top** of `src/sidebar/agents.ts`, above the existing
`./parse-helpers.js` import (Biome enforces import ordering — run `bun run lint`
if unsure of placement):

```ts
import { BRIEF_CATALOG } from "../briefs/catalog.js";
```

Then append to the same file:

```ts
// The built-in briefs, as sidebar rows. Rows carry no command arguments: a tree
// row holds no editor context, so each command falls back to the active editor
// exactly as its palette entry does.
export function builtInBriefRows(): SidebarItem[] {
  return BRIEF_CATALOG.map((spec) => ({
    label: spec.label,
    iconId: spec.iconId,
    contextValue: "nimbusBrief",
    tooltip: `Runs agents.${spec.id} on the Nimbus Gateway.`,
    command: { command: spec.command, title: spec.label },
  }));
}

// Two labelled groups, because the view holds two different concepts: one-shot
// brief runs and chat scopes. They behave differently on click, so the tree
// says which is which rather than mixing them into one flat list.
export function agentsTreeRows(agents: Agent[], activeAgentId?: string): SidebarItem[] {
  const configured =
    agents.length > 0
      ? agentsToRows(agents, activeAgentId)
      : [
          {
            label: "Configure agents in settings…",
            iconId: "gear",
            command: {
              command: "workbench.action.openSettings",
              title: "Open Settings",
              arguments: ["nimbus.agents"],
            },
          },
        ];
  return [
    { label: "Built-in briefs", iconId: "hubot", children: builtInBriefRows() },
    { label: "Configured agents", iconId: "account", children: configured },
  ];
}
```

- [ ] **Step 4: Point the view at the grouped rows**

Replace the body of `src/sidebar/agents-view.ts`:

```ts
import { type Agent, agentsTreeRows } from "./agents.js";
import { createDataView, type SidebarConnection, type SidebarView } from "./tree-view.js";

// Agent runner (design surface #3). Two groups: the built-in briefs the client
// types, and the chat scopes from the nimbus.agents setting. The settings-coupled
// `loadAgents` and the `activeAgentId` getter are injected from the composition
// root, keeping this view pure.
//
// The view is never empty: the built-in group always has rows, which is the
// point — the view named after the product's core used to render
// "No agents configured" on a fresh install.
export function createAgentsView(deps: {
  connection: SidebarConnection;
  loadAgents: () => Agent[];
  activeAgentId: () => string | undefined;
}): SidebarView {
  return createDataView({
    connection: deps.connection,
    loadData: async () => agentsTreeRows(deps.loadAgents(), deps.activeAgentId()),
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `bun run typecheck && bunx vitest run test/unit/agents.test.ts test/unit/extension.test.ts`
Expected: PASS. If an existing test asserted the "No agents configured" row, update it — that row is deliberately gone, and the assertion should now be that the built-in group is present.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/agents.ts src/sidebar/agents-view.ts test/unit/agents.test.ts
git commit -m "feat(sidebar): group the Agents view into built-in briefs and configured agents"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md` (the *Layout* bullet and the *Surface today* paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Record the new package in `docs/architecture.md`**

Find the section that lists `src/` subpackages (`src/scm/`, `src/lm-tools/`, `src/egress/`) and add an entry in the same style:

```markdown
- `src/briefs/` — the built-in agent briefs. Pure core (`catalog.ts` — the
  briefs as data; `render.ts` — brief → markdown, shared with the chat
  participant; `params.ts` — editor context → params, and the module that
  guarantees no absolute path becomes a parameter) plus `commands.ts`, the only
  file here that touches the `vscode` shim. Every brief call routes through
  `src/egress/gated-client.ts` under the `"brief"` egress kind, which prompts
  and is skippable per workspace.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the *Layout* bullet, after the `src/lm-tools/` clause, add:

```
`src/briefs/` (the built-in briefs — pure `catalog.ts` / `render.ts` / `params.ts` plus `commands.ts`, routed through the egress gate under the `"brief"` kind);
```

In the *Surface today* paragraph, after the Quick Ask clause, add:

```
the **built-in briefs** (`Why is this here?`, `Who knew this code?`, `Who else is touching this?` from the editor context menu, `Team huddle` from the palette — `agentsWhy` / `agentsGhost` / `agentsConflicts` / `agentsHuddle`, each behind the pre-flight gate);
```

and change the Agents-view mention in the sidebar clause from `Agents` to `Agents (built-in briefs + the configured `nimbus.agents` chat scopes)`.

- [ ] **Step 3: Run the full local gate one final time**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs`
Expected: all PASS.

- [ ] **Step 4: Verify in an Extension Development Host**

This PR adds UI, so run the `verify-extension` skill. At minimum, confirm by hand:

1. The Nimbus Agents view shows **Built-in briefs** with four rows on a fresh profile — not "No agents configured".
2. Right-click in an editor → *Why is this here?* → the pre-flight modal appears, naming `agents.why` and the repo-relative path with the line.
3. *Show full text* renders the pretty-printed JSON params.
4. Cancel → nothing happens, no error toast.
5. Send → a read-only tab opens titled `Nimbus — Why is this here?.md`.
6. Run it again → the modal appears again. Tick *Always send Agent Briefs here* → the third run sends with no modal.
7. `Nimbus: Show Last Outbound Payload` shows the brief params.
8. With the Gateway stopped, run *Team huddle* → "not connected", no crash.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md CLAUDE.md
git commit -m "docs: record src/briefs and the brief egress kind"
```

---

## Self-Review Notes

Checked against the spec:

- **Covered:** module layout (Tasks 1-3, 6); hover-free surfaces (Tasks 6-7); the `"brief"` egress kind, decision table, manifest note, and generic wrapper (Task 4); choke-point growth (Task 5); two-group sidebar with the settings row (Task 9); error table with verbatim detail, distinct timeout message, silent cancel, and Retry-through-the-gate (Task 6); `MockNimbusClient`-shaped fixtures and the absolute-path test (Tasks 2-3); docs (Task 10).
- **Deliberately deferred, matching the spec's PR split:** `whyPeek` and the hover, the catalog exemption guard, `janitor`/`preflight`, both new settings, and retro-routing the participant's three briefs. The choke-point list is correspondingly narrow — see Task 5's rationale.
- **Not yet exercised:** `AgentTimeoutError` gets no dedicated branch in Task 6, because `errMsg(e)` already surfaces its message verbatim and the class carries its own text. If PR 2's hover work shows users cannot tell a timeout from a gateway error, add the branch then rather than speculatively now.
