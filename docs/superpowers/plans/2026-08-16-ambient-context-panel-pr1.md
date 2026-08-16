# Ambient Context Panel — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the ambient context panel's shell and its two local signals — a
sidebar `WebviewView` that renders the diagnostics and git state of whatever the
user is looking at, plus the briefs that fit that context, with no Gateway call
anywhere in the surface.

**Architecture:** A pure `src/context/` core (snapshot → signals → offers →
protocol) with exactly one `vscode`-touching file, `real-context-view.ts`,
mirroring how `src/diagnostics/` pairs pure modules with `real-provider.ts`. The
webview renders HTML strings the host hands it and decides nothing; it posts
`{ command, args }` back, which the host validates against an allowlist before
`executeCommand`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Vitest,
esbuild, Biome, VS Code extension API.

**Spec:** `docs/superpowers/specs/2026-08-16-ambient-context-panel-design.md`
(revised 2026-08-16 after review; read it alongside this plan).

## Global Constraints

- **No `any`.** External/untrusted data is `unknown` and narrowed. Biome enforces
  `noExplicitAny`, `noNonNullAssertion`, and `noConsole` in `src/`.
- **Log through the output channel** (`src/logging.ts`), never `console`.
- **`exactOptionalPropertyTypes` is on.** Never assign `undefined` to an
  optional (`?`) field — use a conditional spread, as `src/sidebar/agents.ts`
  does. A required field typed `T | undefined` may hold `undefined`.
- **Relative imports carry the `.js` extension**, and type-only imports use
  `import type`.
- **`vscode` is reached only through `src/vscode-shim.ts` or a dedicated
  `real-*.ts` glue file.** In this PR, `src/context/real-context-view.ts` is
  that file, and it is the only file here allowed to `import * as vscode`.
- **`src/context/` must never name `agentInvoke` or `askStream`.**
  `test/unit/egress-choke-point.test.ts` enforces this repo-wide.
- **Comments must not spell a dotted `agents*` call followed by a paren.** That
  same test scans comments; write `agents*` in prose.
- **No Gateway RPC in this PR.** Both signals here are local. `blame` and
  `related` arrive in PR 2.
- **Verification gate** before claiming done: `bun run test`, `bun run typecheck`,
  `bun run lint`, `bun run build`, `bun run check-bundle`,
  `bun run check-vsix-contents`, `bun run check-settings-docs`.
- **Commit messages are Conventional Commits** — the repo squash-merges and
  Release Please reads the title.

**Deliberate deviation from the spec's phasing, and why:** the spec assigns
"action wiring" to PR 3, but PR 1 already renders clickable offers, so the
command allowlist and argument validation (Task 4) must land here — shipping a
webview that can post an unvalidated command id, even briefly, is not
acceptable. PR 3 extends the allowlist to the diagnostic and SCM routes.

**Partly in this PR:** the cadence section's **debounce** (Task 6), but not the
rest of `controller.ts`. The first draft of this plan deferred debouncing whole,
on the reasoning that it exists to bound *RPC* cost and PR 1 makes no RPCs. That
reasoning was too narrow: `onDidChangeTextEditorSelection` fires on every
keystroke, and each collection re-resolves the git extension and re-maps every
repository through `adaptRepository` (`src/scm/real-git.ts:85`), so undebounced
collection allocates per keystroke even with no RPC in sight. Debounce lands
here, at the spec's tiers. Cache, coalescing, the general generation fence and
the invalidation triggers stay in PR 2, where the Gateway signals make them earn
their keep.

---

### Task 1: Context snapshot

**Files:**
- Create: `src/context/snapshot.ts`
- Modify: `src/diagnostics/normalize.ts:71` (export the existing `clampOnWord`)
- Test: `test/unit/context-snapshot.test.ts`

**Interfaces:**
- Consumes: `NORMALIZED_QUERY_MAX_CHARS` and `clampOnWord` from
  `src/diagnostics/normalize.ts`.
- Produces: `ContextSnapshot`, `SnapshotInput`, `EditorInput`,
  `DiagnosticSummary`, `GitSummary`, `SELECTION_MAX_CHARS`, and
  `buildSnapshot(input: SnapshotInput): ContextSnapshot`. Every later task
  consumes `ContextSnapshot`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-snapshot.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { buildSnapshot, SELECTION_MAX_CHARS } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 41,
  selection: "",
  isDirty: false,
};

describe("buildSnapshot", () => {
  test("carries the editor fields through for a file-scheme editor", () => {
    const snap = buildSnapshot({ generation: 1, editor });
    expect(snap.generation).toBe(1);
    expect(snap.path).toBe("src/a.ts");
    expect(snap.languageId).toBe("typescript");
    expect(snap.line).toBe(41);
    expect(snap.selection).toBeUndefined();
    expect(snap.isDirty).toBe(false);
    expect(snap.diagnostics).toEqual([]);
  });

  test("treats a non-file editor as no editor at all", () => {
    const snap = buildSnapshot({
      generation: 2,
      editor: { ...editor, scheme: "untitled", selection: "x", isDirty: true },
    });
    expect(snap.path).toBeUndefined();
    expect(snap.languageId).toBeUndefined();
    expect(snap.line).toBeUndefined();
    expect(snap.selection).toBeUndefined();
    expect(snap.isDirty).toBe(false);
  });

  test("clamps a long selection to the index-query limit, on a word boundary", () => {
    const snap = buildSnapshot({
      generation: 3,
      editor: { ...editor, selection: "alpha ".repeat(200) },
    });
    const selection = snap.selection ?? "";
    expect(selection.length).toBeLessThanOrEqual(SELECTION_MAX_CHARS);
    expect(selection.endsWith("alpha")).toBe(true);
  });

  test("treats a whitespace-only selection as no selection", () => {
    const snap = buildSnapshot({ generation: 4, editor: { ...editor, selection: "   \n\t" } });
    expect(snap.selection).toBeUndefined();
  });

  test("reports unsaved edits so the panel can mark them", () => {
    const snap = buildSnapshot({ generation: 5, editor: { ...editor, isDirty: true } });
    expect(snap.isDirty).toBe(true);
  });

  test("keeps the git summary and diagnostics it is handed", () => {
    const snap = buildSnapshot({
      generation: 6,
      editor,
      git: { branch: "main", changedPaths: ["src/a.ts"] },
      diagnostics: [{ message: "boom", severity: 0, line: 3 }],
    });
    expect(snap.git).toEqual({ branch: "main", changedPaths: ["src/a.ts"] });
    expect(snap.diagnostics).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-snapshot.test.ts`
Expected: FAIL — cannot resolve `../../src/context/snapshot.js`.

- [ ] **Step 3: Export `clampOnWord`**

In `src/diagnostics/normalize.ts`, change line 71 from `function clampOnWord(` to
`export function clampOnWord(`. Leave the existing comment above it in place.

- [ ] **Step 4: Write the implementation**

Create `src/context/snapshot.ts`:

```ts
import { clampOnWord, NORMALIZED_QUERY_MAX_CHARS } from "../diagnostics/normalize.js";

// What is on screen, as plain data. No I/O and no vscode types: the caller
// reads the editor, this module decides what the context IS.

/**
 * Selection is bound for the LOCAL INDEX, not for a model, so it takes the
 * index-query limit rather than the 50 000-char model-context one. Reusing the
 * diagnostics limit keeps one number for "text we turn into a search".
 */
export const SELECTION_MAX_CHARS = NORMALIZED_QUERY_MAX_CHARS;

export interface DiagnosticSummary {
  readonly message: string;
  /** vscode.DiagnosticSeverity: Error=0, Warning=1, Information=2, Hint=3. */
  readonly severity: number;
  /** Zero-based, as VS Code reports it. */
  readonly line: number;
}

export interface GitSummary {
  /** Undefined on a detached HEAD, or before the git extension resolves state. */
  readonly branch: string | undefined;
  /** Repo-relative, as git reports them — safe to display. */
  readonly changedPaths: readonly string[];
}

export interface EditorInput {
  /** Already relative — the output of toRelativeRef. Never absolute. */
  readonly path: string;
  readonly scheme: string;
  readonly languageId: string;
  /** Zero-based cursor line. */
  readonly line: number;
  readonly selection: string;
  readonly isDirty: boolean;
}

export interface SnapshotInput {
  readonly generation: number;
  readonly editor?: EditorInput;
  readonly git?: GitSummary;
  readonly diagnostics?: readonly DiagnosticSummary[];
}

export interface ContextSnapshot {
  /** Monotonic; PR 2's fence uses it to discard late collector replies. */
  readonly generation: number;
  readonly path: string | undefined;
  readonly languageId: string | undefined;
  readonly line: number | undefined;
  /** Already clamped to SELECTION_MAX_CHARS. Undefined when nothing is selected. */
  readonly selection: string | undefined;
  readonly isDirty: boolean;
  readonly git: GitSummary | undefined;
  readonly diagnostics: readonly DiagnosticSummary[];
}

export function buildSnapshot(input: SnapshotInput): ContextSnapshot {
  // Non-file schemes — output panes, settings, untitled buffers, our own
  // read-only reply tabs — carry no repo-grounded context, so they are treated
  // as no editor at all. Mirrors the `{ scheme: "file" }` selector the
  // diagnostic code-action provider uses.
  const editor = input.editor?.scheme === "file" ? input.editor : undefined;
  const selection =
    editor === undefined ? "" : clampOnWord(editor.selection.trim(), SELECTION_MAX_CHARS);
  return {
    generation: input.generation,
    path: editor?.path,
    languageId: editor?.languageId,
    line: editor?.line,
    selection: selection.length > 0 ? selection : undefined,
    isDirty: editor?.isDirty ?? false,
    git: input.git,
    diagnostics: input.diagnostics ?? [],
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run test/unit/context-snapshot.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun run test && bun run typecheck`
Expected: all pass — exporting `clampOnWord` cannot break existing callers.

- [ ] **Step 7: Commit**

```bash
git add src/context/snapshot.ts src/diagnostics/normalize.ts test/unit/context-snapshot.test.ts
git commit -m "feat(context): model the on-screen context as a snapshot"
```

---

### Task 2: Catalog-derived offers

**Files:**
- Create: `src/context/offers.ts`
- Test: `test/unit/context-offers.test.ts`

**Interfaces:**
- Consumes: `ContextSnapshot` (Task 1); `BRIEF_CATALOG`, `BriefId` from
  `src/briefs/catalog.js`; `EditorTarget` from `src/briefs/params.js`.
- Produces: `Offer` and `offersFor(snapshot: ContextSnapshot): Offer[]`.
  `Offer.target` is the `EditorTarget` shape `{ ref: string; line: number }`
  that `nimbus.brief.why` / `.ghost` / `.conflicts` already accept.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-offers.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { BRIEF_CATALOG } from "../../src/briefs/catalog.js";
import { offersFor } from "../../src/context/offers.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const withFile = buildSnapshot({
  generation: 1,
  editor: {
    path: "src/a.ts",
    scheme: "file",
    languageId: "typescript",
    line: 41,
    selection: "",
    isDirty: false,
  },
});
const withoutFile = buildSnapshot({ generation: 2 });

describe("offersFor", () => {
  test("offers every brief when a file and a cursor line are known", () => {
    expect(offersFor(withFile)).toHaveLength(BRIEF_CATALOG.length);
  });

  test("pre-fills the editor target for the briefs that take one", () => {
    const why = offersFor(withFile).find((o) => o.briefId === "why");
    expect(why?.target).toEqual({ ref: "src/a.ts", line: 41 });
    expect(why?.command).toBe("nimbus.brief.why");
  });

  test("omits the editor-backed briefs when there is no file", () => {
    const ids = offersFor(withoutFile).map((o) => o.briefId);
    expect(ids).toEqual(["huddle", "janitor", "preflight"]);
  });

  test("leaves the prompted briefs without a target — they ask for their own input", () => {
    const janitor = offersFor(withFile).find((o) => o.briefId === "janitor");
    expect(janitor?.target).toBeUndefined();
  });

  test("never invents a command outside the catalog", () => {
    const known = new Set(BRIEF_CATALOG.map((b) => b.command));
    for (const offer of offersFor(withFile)) expect(known.has(offer.command)).toBe(true);
  });

  test("preserves catalog order so the panel is stable between renders", () => {
    expect(offersFor(withFile).map((o) => o.briefId)).toEqual(BRIEF_CATALOG.map((b) => b.id));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-offers.test.ts`
Expected: FAIL — cannot resolve `../../src/context/offers.js`.

- [ ] **Step 3: Write the implementation**

Create `src/context/offers.ts`:

```ts
import { BRIEF_CATALOG, type BriefId, type BriefSpec } from "../briefs/catalog.js";
import type { EditorTarget } from "../briefs/params.js";
import type { ContextSnapshot } from "./snapshot.js";

// Which briefs the panel can offer for the context it currently has, derived
// from the catalog rather than a hand-kept list: a brief added to BRIEF_CATALOG
// is offered here for free, and can never be labelled differently than it is in
// the sidebar or the editor menu.

export interface Offer {
  readonly briefId: BriefId;
  readonly label: string;
  readonly iconId: string;
  readonly command: string;
  /** Present only for briefs whose command accepts an EditorTarget. */
  readonly target?: EditorTarget;
}

function offerFor(spec: BriefSpec, snapshot: ContextSnapshot): Offer | undefined {
  const base = { briefId: spec.id, label: spec.label, iconId: spec.iconId, command: spec.command };
  switch (spec.context) {
    case "fileAndLine":
    case "file": {
      // Both take the same EditorTarget; a file-only brief simply ignores the
      // line. Offering either without a path would hand the command nothing it
      // could not already work out from the active editor itself.
      if (snapshot.path === undefined || snapshot.line === undefined) return undefined;
      return { ...base, target: { ref: snapshot.path, line: snapshot.line } };
    }
    case "none":
    case "prompted":
      // Prompted briefs ask for a resource ref or a ref plus namespace, neither
      // of which is an editor path. Pre-filling the branch is a PR 3 concern.
      return base;
  }
}

export function offersFor(snapshot: ContextSnapshot): Offer[] {
  const offers: Offer[] = [];
  for (const spec of BRIEF_CATALOG) {
    const offer = offerFor(spec, snapshot);
    if (offer !== undefined) offers.push(offer);
  }
  return offers;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/context-offers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/context/offers.ts test/unit/context-offers.test.ts
git commit -m "feat(context): derive the briefs that fit the current context"
```

---

### Task 3: The two local signals, and the git seam they need

**Files:**
- Create: `src/context/signals.ts`
- Modify: `src/scm/git-types.ts` (add `branch()`)
- Modify: `src/scm/real-git.ts:20-31` (`RawRepository`) and its `adaptRepository`
- Modify: `test/unit/scm-repo-select.test.ts:6-15` (fake factory)
- Modify: `test/unit/scm-commands.test.ts:35-46` (fake factory)
- Test: `test/unit/context-signals.test.ts`

**Interfaces:**
- Consumes: `ContextSnapshot`, `DiagnosticSummary` (Task 1).
- Produces: `SignalId` (`"problems" | "git"`), `SignalRow`, `SignalSection`,
  `SignalSpec`, `SIGNAL_CATALOG`, `problemsSection`, `gitSection`. Tasks 4-7
  consume `SignalSection`. `GitRepositoryLike` gains
  `branch(): string | undefined`.

**Deferred to PR 2 on review:** the seam's `onDidChange(listener)` verb. PR 1
never subscribes to it — the panel re-collects on editor, selection, diagnostic
and save events, which covers every case except a branch switch made while the
user sits perfectly still. Adding an API member no caller uses is exactly the
kind of groundwork that rots, so it lands in PR 2 beside the invalidation
trigger that consumes it. The consequence to accept meanwhile: after a branch
switch with no editor activity, the Git section is stale until the next event.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-signals.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { gitSection, problemsSection, SIGNAL_CATALOG } from "../../src/context/signals.js";
import { buildSnapshot } from "../../src/context/snapshot.js";

const editor = {
  path: "src/a.ts",
  scheme: "file",
  languageId: "typescript",
  line: 0,
  selection: "",
  isDirty: false,
};

describe("problemsSection", () => {
  test("lists errors and warnings, lowest line first, one-based for the reader", () => {
    const snap = buildSnapshot({
      generation: 1,
      editor,
      diagnostics: [
        { message: "second", severity: 1, line: 9 },
        { message: "first", severity: 0, line: 2 },
      ],
    });
    const section = problemsSection(snap);
    expect(section.rows.map((r) => r.label)).toEqual(["Line 3: first", "Line 10: second"]);
  });

  test("drops Information and Hint, exactly as the lightbulb actions do", () => {
    const snap = buildSnapshot({
      generation: 2,
      editor,
      diagnostics: [
        { message: "fyi", severity: 2, line: 1 },
        { message: "hint", severity: 3, line: 2 },
      ],
    });
    expect(problemsSection(snap).rows).toEqual([]);
    expect(problemsSection(snap).empty).toBe("No errors or warnings in this file.");
  });

  test("says so when there is no file at all", () => {
    expect(problemsSection(buildSnapshot({ generation: 3 })).empty).toBe("No file open.");
  });
});

describe("gitSection", () => {
  test("shows the branch and the changed-file count", () => {
    const snap = buildSnapshot({
      generation: 4,
      editor,
      git: { branch: "feat/x", changedPaths: ["src/a.ts", "src/b.ts"] },
    });
    expect(gitSection(snap).rows.map((r) => r.label)).toEqual(["feat/x", "2 changed files"]);
  });

  test("uses the singular for one changed file", () => {
    const snap = buildSnapshot({
      generation: 5,
      editor,
      git: { branch: "main", changedPaths: ["src/a.ts"] },
    });
    expect(gitSection(snap).rows[1]?.label).toBe("1 changed file");
  });

  test("reports a detached HEAD rather than pretending there is a branch", () => {
    const snap = buildSnapshot({
      generation: 6,
      editor,
      git: { branch: undefined, changedPaths: [] },
    });
    expect(gitSection(snap).rows[0]?.label).toBe("Detached HEAD");
  });

  test("says so when there is no repository", () => {
    expect(gitSection(buildSnapshot({ generation: 7, editor })).empty).toBe(
      "No git repository here.",
    );
  });
});

describe("SIGNAL_CATALOG", () => {
  test("covers both local signals and claims no Gateway", () => {
    expect(SIGNAL_CATALOG.map((s) => s.id)).toEqual(["problems", "git"]);
    expect(SIGNAL_CATALOG.every((s) => s.needsGateway === false)).toBe(true);
  });

  test("each entry collects the section its id names", () => {
    const snap = buildSnapshot({ generation: 8, editor });
    for (const spec of SIGNAL_CATALOG) expect(spec.collect(snap).id).toBe(spec.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-signals.test.ts`
Expected: FAIL — cannot resolve `../../src/context/signals.js`.

- [ ] **Step 3: Write the signals implementation**

Create `src/context/signals.ts`:

```ts
import type { ContextSnapshot } from "./snapshot.js";

// The signals the panel reads, as DATA — the same shape BRIEF_CATALOG uses, so
// adding a fifth signal is one entry rather than an edit in four files. Both
// entries here are local reads; the two Gateway-backed signals arrive in PR 2.

export type SignalId = "problems" | "git";

export interface SignalRow {
  readonly label: string;
  readonly detail?: string;
  readonly iconId?: string;
}

export interface SignalSection {
  readonly id: SignalId;
  readonly title: string;
  readonly rows: readonly SignalRow[];
  /** Shown instead of rows when there are none. Absent when rows is non-empty. */
  readonly empty?: string;
}

// Errors and warnings only. Information and Hint are excluded for the same
// reason the lightbulb never offers them: they are not problems the user asked
// for help with.
const WARNING = 1;

export function problemsSection(snapshot: ContextSnapshot): SignalSection {
  const base = { id: "problems" as const, title: "Problems" };
  if (snapshot.path === undefined) return { ...base, rows: [], empty: "No file open." };
  const rows = snapshot.diagnostics
    .filter((d) => d.severity <= WARNING)
    .slice()
    .sort((a, b) => a.line - b.line)
    // Lines are zero-based inside the extension and one-based everywhere a
    // human reads them, gutters included.
    .map((d) => ({ label: `Line ${d.line + 1}: ${d.message}`, iconId: d.severity === 0 ? "error" : "warning" }));
  if (rows.length === 0) return { ...base, rows, empty: "No errors or warnings in this file." };
  return { ...base, rows };
}

export function gitSection(snapshot: ContextSnapshot): SignalSection {
  const base = { id: "git" as const, title: "Git" };
  const git = snapshot.git;
  if (git === undefined) return { ...base, rows: [], empty: "No git repository here." };
  const count = git.changedPaths.length;
  return {
    ...base,
    rows: [
      { label: git.branch ?? "Detached HEAD", iconId: "git-branch" },
      { label: `${count} changed ${count === 1 ? "file" : "files"}`, iconId: "diff" },
    ],
  };
}

export interface SignalSpec {
  readonly id: SignalId;
  readonly title: string;
  /** Whether collecting this signal needs the Gateway socket. */
  readonly needsGateway: boolean;
  readonly collect: (snapshot: ContextSnapshot) => SignalSection;
}

export const SIGNAL_CATALOG: readonly SignalSpec[] = [
  { id: "problems", title: "Problems", needsGateway: false, collect: problemsSection },
  { id: "git", title: "Git", needsGateway: false, collect: gitSection },
];
```

- [ ] **Step 4: Run the signals test to verify it passes**

Run: `bunx vitest run test/unit/context-signals.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the branch verb to the git seam**

In `src/scm/git-types.ts`, inside `GitRepositoryLike`, after `log(...)`:

```ts
  /** Current branch name; undefined on a detached HEAD. */
  branch(): string | undefined;
```

- [ ] **Step 6: Adapt the real git extension**

In `src/scm/real-git.ts`, extend `RawRepository.state` to declare the field the
git extension already exposes:

```ts
  state: { HEAD?: { name?: string }; untrackedChanges?: RawChange[]; workingTreeChanges?: RawChange[] };
```

and add to the object `adaptRepository` returns:

```ts
    branch: () => raw.state.HEAD?.name,
```

- [ ] **Step 7: Update the two test fakes**

In `test/unit/scm-repo-select.test.ts`, inside `fakeRepo`, after `inputBox`:

```ts
    branch: () => "main",
```

In `test/unit/scm-commands.test.ts`, inside `fakeRepo`, after `inputBox`:

```ts
    branch: () => "main",
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `bun run test && bun run typecheck`
Expected: all pass. `real-git.ts` is excluded from coverage (see
`vitest.config.ts`), so no test is added for it — it is thin glue whose
correctness is proved by the Extension Development Host pass in Task 6.

- [ ] **Step 9: Commit**

```bash
git add src/context/signals.ts src/scm/git-types.ts src/scm/real-git.ts \
  test/unit/context-signals.test.ts test/unit/scm-repo-select.test.ts \
  test/unit/scm-commands.test.ts
git commit -m "feat(context): collect problems and git state, and let the git seam report a branch"
```

---

### Task 4: Protocol, command allowlist and argument validation


**Files:**
- Create: `src/context/protocol.ts`
- Test: `test/unit/context-protocol.test.ts`

**Interfaces:**
- Consumes: `SignalSection` (Task 3), `Offer` (Task 2), `BRIEF_CATALOG`.
- Produces: `ExtensionToContextView`, `ContextViewToExtension`,
  `allowedCommandIds(): ReadonlySet<string>`, and
  `validateInbound(raw: unknown): InboundResult` where `InboundResult` is
  `{ kind: "ready" } | { kind: "run"; command: string; args: readonly unknown[] } | { kind: "rejected"; reason: string }`.
  Task 6 calls `validateInbound` before `executeCommand`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-protocol.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { allowedCommandIds, validateInbound } from "../../src/context/protocol.js";

describe("allowedCommandIds", () => {
  test("covers every brief command the panel can offer", () => {
    expect(allowedCommandIds().has("nimbus.brief.why")).toBe(true);
    expect(allowedCommandIds().has("nimbus.brief.preflight")).toBe(true);
  });

  test("does not admit a command the panel never offers", () => {
    expect(allowedCommandIds().has("workbench.action.terminal.sendSequence")).toBe(false);
  });
});

describe("validateInbound", () => {
  test("accepts the ready handshake", () => {
    expect(validateInbound({ type: "ready" })).toEqual({ kind: "ready" });
  });

  test("accepts an allowlisted command with no arguments", () => {
    expect(validateInbound({ type: "run", command: "nimbus.brief.huddle" })).toEqual({
      kind: "run",
      command: "nimbus.brief.huddle",
      args: [],
    });
  });

  test("accepts an allowlisted command with a well-formed editor target", () => {
    const msg = { type: "run", command: "nimbus.brief.why", args: [{ ref: "src/a.ts", line: 4 }] };
    expect(validateInbound(msg)).toEqual({
      kind: "run",
      command: "nimbus.brief.why",
      args: [{ ref: "src/a.ts", line: 4 }],
    });
  });

  test("rejects a command outside the allowlist", () => {
    const result = validateInbound({ type: "run", command: "workbench.action.reloadWindow" });
    expect(result.kind).toBe("rejected");
  });

  test("rejects an allowlisted command whose argument is malformed", () => {
    const result = validateInbound({
      type: "run",
      command: "nimbus.brief.why",
      args: [{ ref: "src/a.ts", line: "four" }],
    });
    expect(result.kind).toBe("rejected");
  });

  test("rejects more arguments than the command takes", () => {
    const result = validateInbound({
      type: "run",
      command: "nimbus.brief.why",
      args: [{ ref: "a", line: 1 }, { ref: "b", line: 2 }],
    });
    expect(result.kind).toBe("rejected");
  });

  test("rejects anything that is not a known message shape", () => {
    expect(validateInbound(null).kind).toBe("rejected");
    expect(validateInbound("run").kind).toBe("rejected");
    expect(validateInbound({ type: "explode" }).kind).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-protocol.test.ts`
Expected: FAIL — cannot resolve `../../src/context/protocol.js`.

- [ ] **Step 3: Write the implementation**

Create `src/context/protocol.ts`:

```ts
import { BRIEF_CATALOG } from "../briefs/catalog.js";
import type { Offer } from "./offers.js";
import type { SignalSection } from "./signals.js";

// The host↔webview contract, mirroring chat-protocol.ts — plus the validation
// that makes it safe. A webview is untrusted input: nothing it posts may reach
// executeCommand without passing both the id allowlist and an argument check.

export type ExtensionToContextView =
  | {
      type: "render";
      generation: number;
      sections: readonly SignalSection[];
      offers: readonly Offer[];
      isDirty: boolean;
    }
  | { type: "paused"; reason: "hidden" | "disabled" };

export type ContextViewToExtension =
  | { type: "ready" }
  | { type: "run"; command: string; args?: readonly unknown[] };

export type InboundResult =
  | { kind: "ready" }
  | { kind: "run"; command: string; args: readonly unknown[] }
  | { kind: "rejected"; reason: string };

export function allowedCommandIds(): ReadonlySet<string> {
  return new Set(BRIEF_CATALOG.map((spec) => spec.command));
}

// Briefs whose command signature accepts one optional EditorTarget. Every other
// allowlisted command takes none, so anything it is handed is refused.
const TAKES_EDITOR_TARGET = new Set(["nimbus.brief.why", "nimbus.brief.ghost", "nimbus.brief.conflicts"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEditorTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value["ref"] === "string" && typeof value["line"] === "number";
}

function validateArgs(command: string, args: readonly unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  if (!TAKES_EDITOR_TARGET.has(command)) return `${command} takes no arguments`;
  if (args.length > 1) return `${command} takes at most one argument`;
  if (!isEditorTarget(args[0])) return `${command} needs { ref: string, line: number }`;
  return undefined;
}

export function validateInbound(raw: unknown): InboundResult {
  if (!isRecord(raw)) return { kind: "rejected", reason: "message is not an object" };
  if (raw["type"] === "ready") return { kind: "ready" };
  if (raw["type"] !== "run") return { kind: "rejected", reason: `unknown message type` };

  const command = raw["command"];
  if (typeof command !== "string") return { kind: "rejected", reason: "command is not a string" };
  if (!allowedCommandIds().has(command)) {
    return { kind: "rejected", reason: `command not allowlisted: ${command}` };
  }

  const rawArgs = raw["args"];
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    return { kind: "rejected", reason: "args is not an array" };
  }
  const args: readonly unknown[] = rawArgs ?? [];
  const problem = validateArgs(command, args);
  if (problem !== undefined) return { kind: "rejected", reason: problem };
  return { kind: "run", command, args };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/context-protocol.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/context/protocol.ts test/unit/context-protocol.test.ts
git commit -m "feat(context): validate every command the webview posts"
```

---

### Task 5: The webview bundle

**Files:**
- Create: `src/context/webview/render.ts`
- Create: `src/context/webview/main.ts`
- Create: `src/context/webview/styles.css`
- Modify: `esbuild.mjs` (a bundle entry in both branches, plus a `copyFileSync`)
- Modify: `scripts/check-vsix-contents.mjs:60` (the "must exist" list)
- Test: `test/unit/context-render.test.ts`

**Interfaces:**
- Consumes: `SignalSection` (Task 3), `Offer` (Task 2), `ExtensionToContextView`
  (Task 4).
- Produces: `escapeHtml`, `renderSections`, `renderOffers`, `renderPanel` — all
  returning HTML strings. `media/context.js` and `media/context.css` are the
  build outputs Task 6's HTML references.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-render.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { escapeHtml, renderOffers, renderPanel, renderSections } from "../../src/context/webview/render.js";

const section = {
  id: "problems" as const,
  title: "Problems",
  rows: [{ label: "Line 3: boom", iconId: "error" }],
};

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">'y&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;y&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("renderSections", () => {
  test("renders a row per finding", () => {
    const html = renderSections([section]);
    expect(html).toContain("Problems");
    expect(html).toContain("Line 3: boom");
  });

  test("renders the empty text instead of rows when there are none", () => {
    const html = renderSections([{ id: "git", title: "Git", rows: [], empty: "No git repository here." }]);
    expect(html).toContain("No git repository here.");
  });

  test("escapes a diagnostic message rather than trusting it as markup", () => {
    const nasty = { ...section, rows: [{ label: "<img src=x onerror=alert(1)>" }] };
    expect(renderSections([nasty])).not.toContain("<img");
  });
});

describe("renderOffers", () => {
  test("carries the command and its pre-filled target on the button", () => {
    const html = renderOffers([
      {
        briefId: "why",
        label: "Why is this here?",
        iconId: "history",
        command: "nimbus.brief.why",
        target: { ref: "src/a.ts", line: 4 },
      },
    ]);
    expect(html).toContain("nimbus.brief.why");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("Why is this here?");
  });

  test("renders nothing but a note when no brief fits", () => {
    expect(renderOffers([])).toContain("Open a file");
  });
});

describe("renderPanel", () => {
  test("marks unsaved edits so blame is never read as authoritative", () => {
    expect(renderPanel({ sections: [section], offers: [], isDirty: true })).toContain("Unsaved edits");
  });

  test("says nothing about unsaved edits for a clean file", () => {
    expect(renderPanel({ sections: [section], offers: [], isDirty: false })).not.toContain(
      "Unsaved edits",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-render.test.ts`
Expected: FAIL — cannot resolve `../../src/context/webview/render.js`.

- [ ] **Step 3: Write the renderer**

Create `src/context/webview/render.ts`:

```ts
import type { Offer } from "../offers.js";
import type { SignalSection } from "../signals.js";

// Pure HTML-string rendering for the context panel.
//
// escapeHtml is defined here rather than imported from the chat webview's
// render module on purpose: that module pulls in marked and DOMPurify, ~20 KB
// of markdown machinery this panel has no use for, and both bundles ship in the
// .vsix.

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRow(label: string, detail: string | undefined, iconId: string | undefined): string {
  const icon = iconId === undefined ? "" : `<span class="codicon codicon-${escapeHtml(iconId)}"></span>`;
  const sub = detail === undefined ? "" : `<span class="detail">${escapeHtml(detail)}</span>`;
  return `<li class="row">${icon}<span class="label">${escapeHtml(label)}</span>${sub}</li>`;
}

export function renderSections(sections: readonly SignalSection[]): string {
  return sections
    .map((section) => {
      const body =
        section.rows.length === 0
          ? `<p class="empty">${escapeHtml(section.empty ?? "Nothing to show.")}</p>`
          : `<ul class="rows">${section.rows
              .map((r) => renderRow(r.label, r.detail, r.iconId))
              .join("")}</ul>`;
      return `<section class="signal" data-signal="${escapeHtml(section.id)}"><h2>${escapeHtml(
        section.title,
      )}</h2>${body}</section>`;
    })
    .join("");
}

export function renderOffers(offers: readonly Offer[]): string {
  if (offers.length === 0) {
    return `<section class="offers"><p class="empty">Open a file to see the briefs that fit it.</p></section>`;
  }
  const buttons = offers
    .map((offer) => {
      // The target rides in a data attribute rather than an inline handler: the
      // CSP allows no inline script, and main.ts reads it back on click.
      const target = offer.target === undefined ? "" : ` data-target="${escapeHtml(JSON.stringify(offer.target))}"`;
      return `<button class="offer" data-command="${escapeHtml(offer.command)}"${target}><span class="codicon codicon-${escapeHtml(
        offer.iconId,
      )}"></span>${escapeHtml(offer.label)}</button>`;
    })
    .join("");
  return `<section class="offers"><h2>Ask about this</h2>${buttons}</section>`;
}

export function renderPanel(input: {
  sections: readonly SignalSection[];
  offers: readonly Offer[];
  isDirty: boolean;
}): string {
  const dirty = input.isDirty
    ? `<p class="dirty">Unsaved edits — history may not line up with what is on screen.</p>`
    : "";
  return `${dirty}${renderSections(input.sections)}${renderOffers(input.offers)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/context-render.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the webview entry**

Create `src/context/webview/main.ts`:

```ts
import type { ContextViewToExtension, ExtensionToContextView } from "../protocol.js";
import { renderPanel } from "./render.js";

// The browser half of the context panel. It decides nothing: it renders what
// the host sends and posts back the command a clicked offer names.

interface VsCodeApi {
  postMessage(message: ContextViewToExtension): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function mount(): HTMLElement | null {
  return document.getElementById("root");
}

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button.offer");
  if (!(button instanceof HTMLElement)) return;
  const command = button.dataset["command"];
  if (command === undefined) return;
  const raw = button.dataset["target"];
  const args = raw === undefined ? [] : [JSON.parse(raw) as unknown];
  vscode.postMessage({ type: "run", command, args });
}

window.addEventListener("message", (event: MessageEvent<ExtensionToContextView>) => {
  const root = mount();
  if (root === null) return;
  const message = event.data;
  if (message.type === "paused") {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = renderPanel({
    sections: message.sections,
    offers: message.offers,
    isDirty: message.isDirty,
  });
});

document.addEventListener("click", onClick);
vscode.postMessage({ type: "ready" });
```

- [ ] **Step 6: Write the stylesheet**

Create `src/context/webview/styles.css`:

```css
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  padding: 0.5rem;
}
h2 {
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.75;
  margin: 0.9rem 0 0.35rem;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  padding: 0.15rem 0;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail,
.empty {
  opacity: 0.7;
}
.dirty {
  color: var(--vscode-editorWarning-foreground);
  margin: 0 0 0.5rem;
}
.offer {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  width: 100%;
  margin: 0.15rem 0;
  padding: 0.3rem 0.4rem;
  text-align: left;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  border: none;
  cursor: pointer;
}
.offer:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
```

- [ ] **Step 7: Add the bundle to the build**

In `esbuild.mjs`, inside the `if (isWatch)` branch, after `webCtx`, add a third
context and start it:

```js
  const ctxCtx = await context({
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "NimbusContextView",
    sourcemap: isDev,
    minify: true,
    treeShaking: true,
    entryPoints: ["src/context/webview/main.ts"],
    outfile: "media/context.js",
    logLevel: "info",
  });
```

and add `await ctxCtx.watch();` beside the other two. In the `else` branch, add
the same object as a third `await build({...})` call.

Then, beside the existing stylesheet copy at the bottom of the file:

```js
copyFileSync("src/context/webview/styles.css", "media/context.css");
```

**Do not skip that line.** CSS is copied, not bundled — an esbuild entry alone
produces `media/context.js` with no stylesheet, and every guard still passes.

- [ ] **Step 8: Extend the packaging guard**

In `scripts/check-vsix-contents.mjs`, extend the "must exist" list on line 60:

```js
const missing = [
  "dist/extension.js",
  "media/webview.js",
  "media/context.js",
  "media/context.css",
  "package.json",
].filter(
```

`media/` is already covered by `ALLOWED_DIRS` and by `!media/**` in
`.vscodeignore`, so no allowlist change is needed — only this existence check.

- [ ] **Step 9: Build and verify both artifacts exist**

Run: `bun run build && ls media/context.js media/context.css && bun run check-bundle`
Expected: both files listed; check-bundle reports `vscode` as the only external.

- [ ] **Step 10: Commit**

```bash
git add src/context/webview esbuild.mjs scripts/check-vsix-contents.mjs \
  test/unit/context-render.test.ts
git commit -m "feat(context): render the panel in its own webview bundle"
```

---

### Task 6: Debounce

**Files:**
- Create: `src/context/debounce.ts`
- Test: `test/unit/context-debounce.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEBOUNCE_MS` (the spec's tiers) and
  `createDebouncer(delayMs: number, fn: () => void): { trigger(): void; dispose(): void }`.
  Task 7 wraps each event source in one.

Added on review. Every keystroke fires `onDidChangeTextEditorSelection`, and an
undebounced collection re-resolves the git extension and re-maps every
repository per keystroke. The tiers are the spec's, not new numbers, so PR 2's
`controller.ts` absorbs this module rather than replacing it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/context-debounce.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDebouncer, DEBOUNCE_MS } from "../../src/context/debounce.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createDebouncer", () => {
  test("runs once for a burst of triggers", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    for (let i = 0; i < 20; i += 1) d.trigger();
    expect(calls).toBe(0);
    vi.advanceTimersByTime(300);
    expect(calls).toBe(1);
  });

  test("runs again for a later, separate burst", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    d.trigger();
    vi.advanceTimersByTime(300);
    d.trigger();
    vi.advanceTimersByTime(300);
    expect(calls).toBe(2);
  });

  test("each trigger restarts the wait — a fast typist never collects mid-burst", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    for (let i = 0; i < 10; i += 1) {
      d.trigger();
      vi.advanceTimersByTime(299);
    }
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
  });

  test("dispose cancels a pending run", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    d.trigger();
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(0);
  });

  test("carries the spec's three tiers", () => {
    expect(DEBOUNCE_MS).toEqual({ selection: 300, editor: 150, diagnostics: 500 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/context-debounce.test.ts`
Expected: FAIL — cannot resolve `../../src/context/debounce.js`.

- [ ] **Step 3: Write the implementation**

Create `src/context/debounce.ts`:

```ts
// Trailing-edge debounce, one per event source.
//
// The tiers are the design spec's: a cursor moves constantly, an editor switch
// is rapid only while cycling tabs, and a language server re-lints in bursts
// that fire several events for one file.
export const DEBOUNCE_MS = { selection: 300, editor: 150, diagnostics: 500 } as const;

export interface Debouncer {
  trigger(): void;
  dispose(): void;
}

export function createDebouncer(delayMs: number, fn: () => void): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    trigger: () => {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, delayMs);
    },
    dispose: clear,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/context-debounce.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/context/debounce.ts test/unit/context-debounce.test.ts
git commit -m "feat(context): debounce collection at the spec's tiers"
```

---

### Task 7: Register the view and wire it up

**Files:**
- Create: `src/context/real-context-view.ts`
- Modify: `package.json` (`contributes.views.nimbus`)
- Modify: `src/extension.ts` (name the git accessor at ~line 666, use it at ~line 703, register the provider after the sidebar loop at ~line 682)
- Modify: `vitest.config.ts` (coverage exclude for the new glue file)
- Test: `test/unit/manifest-context.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: `registerContextView(deps)`, called once from `activate`.

- [ ] **Step 1: Write the failing manifest test**

Create `test/unit/manifest-context.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/manifest-context.test.ts`
Expected: FAIL — `nimbus.contextView` is not declared.

- [ ] **Step 3: Declare the view**

In `package.json`, make `contributes.views.nimbus` start with the new entry:

```json
        {
          "id": "nimbus.contextView",
          "name": "Context",
          "type": "webview"
        },
```

placed before the existing `nimbus.auditView` entry, leaving the other six
unchanged.

- [ ] **Step 4: Run the manifest test to verify it passes**

Run: `bunx vitest run test/unit/manifest-context.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the vscode glue**

Create `src/context/real-context-view.ts`:

```ts
import { randomUUID } from "node:crypto";

import * as vscode from "vscode";
import { errMsg, type Logger } from "../logging.js";
import { toRelativeRef } from "../briefs/params.js";
import type { GitApiLike } from "../scm/git-types.js";
import { createDebouncer, DEBOUNCE_MS } from "./debounce.js";
import { offersFor } from "./offers.js";
import { validateInbound } from "./protocol.js";
import { SIGNAL_CATALOG } from "./signals.js";
import {
  buildSnapshot,
  SELECTION_MAX_CHARS,
  type DiagnosticSummary,
  type GitSummary,
} from "./snapshot.js";

// Thin vscode-API glue — mirrors real-provider.ts and real-chat-panel.ts. Every
// decision (what the context is, which briefs fit, what may be executed) lives
// in the pure modules beside this file, which carry the tests.
//
// PR 1 re-collects on every event, with no cache: both signals here are local
// reads. PR 2 introduces controller.ts when the Gateway-backed signals arrive
// and cost per collection starts to matter.

const VIEW_ID = "nimbus.contextView";

export function registerContextView(deps: {
  log: Logger;
  // Async and possibly absent: this is the same accessor the SCM trio takes —
  // the built-in git extension may not have activated yet.
  git: () => Promise<GitApiLike | undefined>;
}): vscode.Disposable {
  let generation = 0;
  let view: vscode.WebviewView | undefined;

  const gitSummary = async (): Promise<GitSummary | undefined> => {
    const repo = (await deps.git())?.repositories()[0];
    if (repo === undefined) return undefined;
    // changedPaths stays UNREAD in PR 1: filling it means an async changedFiles
    // call per collection, which belongs with PR 2's controller. Undefined, not
    // [], so gitSection renders no count row rather than claiming zero.
    return { branch: repo.branch(), changedPaths: undefined };
  };

  // Bound the READ, not just the stored value. Ctrl+A on a large file makes
  // getText(selection) copy the whole document before buildSnapshot clamps it to
  // 300 chars. Five lines is far more than the clamp can consume, and the slice
  // covers the one-enormous-line case (a minified bundle).
  const SELECTION_READ_LINES = 5;
  const selectionText = (editor: vscode.TextEditor): string => {
    const sel = editor.selection;
    if (sel.isEmpty) return "";
    const lastLine = Math.min(sel.end.line, sel.start.line + SELECTION_READ_LINES);
    const end =
      lastLine === sel.end.line ? sel.end : editor.document.lineAt(lastLine).range.end;
    return editor.document.getText(new vscode.Range(sel.start, end)).slice(0, SELECTION_MAX_CHARS * 2);
  };

  const diagnosticsFor = (uri: vscode.Uri): DiagnosticSummary[] =>
    vscode.languages.getDiagnostics(uri).map((d) => ({
      message: d.message,
      severity: d.severity,
      line: d.range.start.line,
    }));

  const collect = async (): Promise<void> => {
    if (view === undefined || !view.visible) return;
    generation += 1;
    const mine = generation;
    const editor = vscode.window.activeTextEditor;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const git = await gitSummary();
    // A minimal fence: the git lookup is awaited, so a later collection can
    // overtake this one. PR 2 generalises this across all four signals.
    if (mine !== generation || view === undefined) return;
    const snapshot = buildSnapshot({
      generation: mine,
      ...(editor === undefined
        ? {}
        : {
            editor: {
              // Relative, never absolute: an absolute path names the user's home
              // directory, and this value is rendered.
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
    void view.webview.postMessage({
      type: "render",
      generation: mine,
      sections: SIGNAL_CATALOG.map((spec) => spec.collect(snapshot)),
      offers: offersFor(snapshot),
      isDirty: snapshot.isDirty,
    });
  };

  const recollect = (): void => {
    void collect().catch((e: unknown) => deps.log.warn(`context panel collect failed: ${errMsg(e)}`));
  };

  // One debouncer per event source, at the spec's tiers. Becoming visible and
  // the webview's ready handshake collect immediately: both are single events
  // the user is waiting on, not bursts.
  const onSelection = createDebouncer(DEBOUNCE_MS.selection, recollect);
  const onEditor = createDebouncer(DEBOUNCE_MS.editor, recollect);
  const onDiagnostics = createDebouncer(DEBOUNCE_MS.diagnostics, recollect);

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const mediaRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), "..", "media");
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
      webviewView.webview.html = renderHtml(webviewView.webview, mediaRoot);
      webviewView.webview.onDidReceiveMessage((raw: unknown) => {
        const result = validateInbound(raw);
        if (result.kind === "rejected") {
          deps.log.warn(`context panel refused a message: ${result.reason}`);
          return;
        }
        if (result.kind === "ready") {
          recollect();
          return;
        }
        void vscode.commands.executeCommand(result.command, ...result.args).then(undefined, (e: unknown) => {
          deps.log.error(`context panel command failed: ${errMsg(e)}`);
        });
      });
      // Collection is suspended entirely while the view is hidden; becoming
      // visible collects once for the current context.
      webviewView.onDidChangeVisibility(() => recollect());
    },
  };

  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.window.onDidChangeActiveTextEditor(() => onEditor.trigger()),
    vscode.window.onDidChangeTextEditorSelection(() => onSelection.trigger()),
    vscode.languages.onDidChangeDiagnostics(() => onDiagnostics.trigger()),
    // Save is a deliberate single act, not a burst — collect straight away.
    vscode.workspace.onDidSaveTextDocument(() => recollect()),
    { dispose: () => onSelection.dispose() },
    { dispose: () => onEditor.dispose() },
    { dispose: () => onDiagnostics.dispose() },
  );
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "context.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "context.css"));
  const nonce = randomUUID().replaceAll("-", "");
  const csp =
    `default-src 'none'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `font-src ${webview.cspSource}; ` +
    `script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Nimbus Context</title>
<link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
<main id="root" aria-live="polite"></main>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
```

- [ ] **Step 6: Wire it into activate**

In `src/extension.ts`, add the import beside the other feature imports:

```ts
import { registerContextView } from "./context/real-context-view.js";
```

The git accessor currently has no local name — it is constructed inline at
`src/extension.ts:703` as `deps.git ?? createRealGitApi(log)`. Give it one, so
both consumers share a single accessor. **Declare it above the sidebar block**,
immediately before `const sidebarViews` (line 666) — a `const` declared at 703
could not be used at 682:

```ts
  const gitApi = deps.git ?? createRealGitApi(log);
```

Then at line 703, replace the inline expression with that name:

```ts
  const scm = createScmCommands({
    git: gitApi,
```

leaving the rest of the `createScmCommands` call untouched. Finally, immediately
after the `for (const [viewId, view] of sidebarViews) { ... }` loop that ends at
line 682, add:

```ts
  ctx.subscriptions.push(registerContextView({ log, git: gitApi }));
```

`log` is the logger `activate` already creates at line 162. Introduce no other
new names.

- [ ] **Step 7: Exclude the glue file from coverage**

In `vitest.config.ts`, add to the `coverage.exclude` array, beside the other
`real-*` entries:

```ts
        "src/context/real-context-view.ts",
```

- [ ] **Step 8: Run the whole verification gate**

Run:

```bash
bun run test && bun run typecheck && bun run lint && bun run build \
  && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Expected: every command passes. If `lint` objects to formatting in the new
files, run `bunx biome check --write .` and re-run.

- [ ] **Step 9: Drive it in a real editor**

Press F5 to launch the Extension Development Host, then confirm each of these by
eye — this step is the point of the task, not a formality:

1. The Nimbus activity-bar container opens with **Context** at the top.
2. Opening a `.ts` file shows a Problems section and a Git section with the real
   branch name.
3. Introducing a syntax error adds a row within a second; fixing it removes the row.
4. The offers section lists all six briefs, and clicking **Why is this here?**
   opens the same brief the editor context menu does, for the cursor's line.
5. With no editor open, the panel says so instead of rendering blank.
6. Typing without saving shows the "Unsaved edits" note; saving clears it.
7. Collapsing the Context view and editing elsewhere produces no output-channel
   noise; re-expanding it renders the current file.
8. Typing a long line quickly stays smooth, and the panel updates once you pause
   — not once per character.
9. Selecting the whole of a large file (Ctrl+A) does not stall the editor.

Record anything that fails here as a defect to fix before the commit — a green
unit suite is not evidence this surface works.

**Added after implementation, from the reviews.** These come from reading the
finished code, so they name things the nine points above do not:

10. **Check the Git section against `git status`.** `changedPaths` is genuinely
    empty until PR 2. The count row is now omitted rather than claiming zero —
    confirm you see a branch row and no count, not "0 changed files".
11. **Expect no icons.** No codicon font ships, so the icon spans were removed;
    `iconId` is still carried in the data for a later PR. Rows and buttons should
    read cleanly, with no stray indent where an icon used to be.
12. **Open a multi-root window with two repos on different branches.** The panel
    reads `repositories()[0]`, which is not necessarily the repo containing the
    file on screen. This is a known limitation recorded in the code; PR 2 selects
    by longest `rootPath` prefix. Confirm which branch it shows.
13. **Tab into an offer button, then move the cursor in the editor.** Focus must
    survive the re-render — the panel now skips repainting a mount whose HTML is
    unchanged, and offers sit outside the `aria-live` region. With a screen
    reader on, moving the cursor should not re-announce the panel.
14. **Watch the view's initial height.** A webview view above six tree views can
    resolve to a few pixels tall on a fresh profile. Item 1 checks it is *first*,
    not that it is *usable*.
15. **Hide the Context view entirely** (right-click the container → uncheck
    Context), keep editing for a minute, then check the output channel for
    `context panel collect failed` lines. Expect silence.
16. **Click each of the six offers while disconnected from the Gateway.** All six
    should report not being connected; none should log
    `context panel refused a message`. A refusal there would mean the offer list
    and the command allowlist have drifted apart.

- [ ] **Step 10: Commit**

```bash
git add src/context/real-context-view.ts src/extension.ts package.json \
  vitest.config.ts test/unit/manifest-context.test.ts
git commit -m "feat(context): register the ambient context panel in the sidebar"
```

---

## Self-Review

**Spec coverage for PR 1.** Module layout — Tasks 1-7 create `snapshot.ts`,
`signals.ts`, `offers.ts`, `protocol.ts`, `debounce.ts`, `real-context-view.ts`
and the webview bundle; the rest of `controller.ts` is deferred to PR 2 with a
stated reason. The `problems` and `git` signals — Task 3. Catalog-derived offers
— Task 2. The git seam's `branch()` — Task 3. Debounce at the spec's tiers —
Task 6. The esbuild entry **and the `copyFileSync` for CSS** — Task 5. The
`.vsix` "must exist" additions — Task 5. The command allowlist and argument
validation — Task 4, pulled forward from PR 3 with the deviation stated in
Global Constraints. The selection clamp at the index-query limit — Task 1, with
the read itself bounded in Task 7. `isDirty` and its marker — Tasks 1 and 5.
Degraded states for "no file" and "no repository" — Task 3. The Extension
Development Host pass — Task 7, Step 9.

**Deferred to later PRs, as the spec assigns them:** `blame` and `related`
(PR 2); the rest of the cadence machinery — cache, coalescing, the general
generation fence, the invalidation triggers, and the seam's `onDidChange` verb
(PR 2); the `peek.ts` split (PR 2); `nimbus.context.enabled` and
`docs/settings.md` (PR 3); diagnostic and SCM action routes (PR 3); branch
pre-fill for the prompted briefs (PR 3); the ExTester spec (PR 3).

**Two limits a PR-1 reviewer will notice, to be named in the PR description
rather than left to be found:** the `git` signal reports the branch but leaves
`changedPaths` undefined, and a branch switch made with no editor activity
leaves that section stale until the next event. Both resolve in
PR 2 — the first needs the async collection path `controller.ts` introduces, the
second needs the seam's `onDidChange` verb and the invalidation trigger that
consumes it.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-16-ambient-context-panel-pr1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration.

**2. Inline Execution** — execute the tasks in this session with checkpoints for review.

**Which approach?**
