# Built-in briefs PR 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the last two unreached briefs (`agentsJanitor`, `agentsPreflight`) and route the chat participant's three raw `agents*` calls through the egress seam, so `whyPeek` becomes the only ungated agent call in `src/`.

**Architecture:** Everything rides the seams PR 1 built. `src/briefs/` gains two renderers, two parameter builders, a per-folder namespace memory and two prompted commands; `src/egress/gated-client.ts` gains the two new brief calls (prompting, kind `"brief"`) plus a second constructor for the participant's three (recording, kind `"participant"`). No new RPCs, no client bump.

**Tech Stack:** TypeScript (strict), Vitest, Biome, esbuild, `@nimbus-dev/client` ^0.15.1 (what `package.json` actually declares — `CLAUDE.md` and `docs/ROADMAP.md` still say `0.14.0`, which is stale; correcting that prose is a deferred minor, not this PR's job). Verified against both SDK 1.10.0 (this branch's lock) and 1.16.0 (the in-flight `refresh-sdk-transitive` branch): `agentsJanitor`, `agentsPreflight` and `agentsWhyPeek` are typed in both, and `JanitorParams`, `PreflightParams`, `JanitorBrief` and `PreflightBrief` are identical across them.

**Spec:** [docs/superpowers/specs/2026-08-11-built-in-briefs-pr3-design.md](../specs/2026-08-11-built-in-briefs-pr3-design.md). Read it before starting; it carries the reasoning this plan only executes.

## Global Constraints

- TypeScript **strict**, and **no `any`** — use `unknown` for external data. Biome enforces `noExplicitAny`, `noConsole` (in `src/`), `noNonNullAssertion`.
- Never `console.*` in `src/` — log through `logging.ts`.
- `exactOptionalPropertyTypes` is on. Build optional properties with a conditional spread: `...(x !== undefined ? { x } : {})`. Never assign `undefined` to an optional property.
- The `vscode` API is touched **only** through `src/vscode-shim.ts`. Pure modules (`render.ts`, `params.ts`, `catalog.ts`, `namespace-store.ts`) import nothing from `vscode`.
- Tests live in `test/unit/`, run with `bun run test`. `vscode` is aliased to `test/unit/vscode-stub.ts` by `vitest.config.ts`.
- Never hand-edit `CHANGELOG.md` — Release Please writes it from the Conventional-Commit PR title.
- Every new `nimbus.*` setting must appear in `package.json`, `src/settings.ts`, `docs/settings.md` and `test/unit/settings.test.ts`, or `bun run check-settings-docs` fails.
- Branch is `feat/briefs-pr3`, already created and holding the two design commits. Commit after every task.
- Per-task verification is `bun run test <file>`, `bun run typecheck`, **and `bun run lint`**. Lint is whole-repo Biome and takes seconds; running it per task stops nine tasks' worth of style errors from surfacing at once in Task 10. Test stubs must satisfy Biome too — cast with `as unknown as X` or `as never` in the style the existing test files already use, never `any`.
- The **full** gate (`test`, `typecheck`, `lint`, `build`, `check-bundle`, `check-vsix-contents`, `check-settings-docs`) runs once in Task 10 — use the `verify-extension` skill for it.

## File Structure

**Create**
- `src/briefs/namespace-store.ts` — per-workspace-folder memory of the last Preflight namespace. One getter, one setter, plus the pure folder-selection rule.
- `test/unit/briefs-namespace-store.test.ts`

**Modify**
- `src/briefs/render.ts` — `+renderJanitor`, `+renderPreflight`
- `src/briefs/params.ts` — `+rootFor` (extracted), `+janitorParams`, `+preflightParams`
- `src/briefs/catalog.ts` — `+"janitor" | "preflight"`, `+"prompted"` context, `+needsEditor`
- `src/briefs/commands.ts` — prompts, the two new commands, and the prompt-before-`contain` reordering
- `src/egress/gated-client.ts` — `+janitor`/`+preflight` on the prompting seam; `+gateRawParticipantBriefs`
- `src/chat-participant/participant-types.ts` — `ParticipantClientLike` swaps three `agents*` methods for the seam
- `src/chat-participant/ops-commands.ts` — call the seam; redact the selection path
- `src/vscode-shim.ts` — `TextEditorLike.document` gains `uri: { scheme: string }`
- `src/extension.ts` — wire the store, the setting, the two commands, the file-scheme filter, the participant seam
- `src/settings.ts`, `package.json`, `docs/settings.md` — the new setting
- `test/unit/`: `briefs-render`, `briefs-params`, `briefs-catalog`, `briefs-commands`, `manifest-briefs`, `egress-gated-client`, `egress-choke-point`, `settings`, `extension`, `scm-commands`
- `CLAUDE.md`, `docs/architecture.md`, `docs/ROADMAP.md`, and the two spec docs

---

### Task 1: Janitor and Preflight renderers

**Files:**
- Modify: `src/briefs/render.ts`
- Test: `test/unit/briefs-render.test.ts`

**Interfaces:**
- Consumes: `gapsFooter`, `plural` (already in `render.ts`).
- Produces: `renderJanitor(brief: JanitorBrief): string`, `renderPreflight(brief: PreflightBrief): string`.

**Note on fixtures:** the spec mentions testing against the published mock's fixtures. Only `WHY_BRIEF_FIXTURE` exists (`mock-client.d.ts:180`) — there is no janitor or preflight fixture — so build typed literals exactly as `briefs-render.test.ts` already does for the other four.

**Note on `idleDays`:** the request and the response disagree, and only one of them is optional. `JanitorParams.idleDays` is `number | undefined` — the extension may omit it. `JanitorBrief["query"].idleDays` is a **required** `number`: the Gateway echoes back the window it actually used, resolving its own default when none was sent. So the renderer states the window unconditionally and needs no `undefined` branch. Do not add one — it would be dead code guarding against a shape the type forbids.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/briefs-render.test.ts` (and add `JanitorBrief`, `PreflightBrief` to the type import on line 1, `renderJanitor`, `renderPreflight` to the import from `render.js`):

```ts
function janitor(over: Partial<JanitorBrief> = {}): JanitorBrief {
  return {
    ...BASE,
    kind: "janitor",
    query: { resourceRef: "svc/legacy-billing", idleDays: 90 },
    idle: true,
    proposalSuppressed: false,
    cleanupAction: null,
    peersClear: 0,
    peersTouched: [],
    ...over,
  } as JanitorBrief;
}

function preflight(over: Partial<PreflightBrief> = {}): PreflightBrief {
  return {
    ...BASE,
    kind: "preflight",
    query: { ref: "release-1.4", namespace: "billing" },
    downstreams: [],
    anyFailed: false,
    anyIncomplete: false,
    ...over,
  } as PreflightBrief;
}

describe("renderJanitor", () => {
  test("an idle resource names the window it was idle for", () => {
    expect(renderJanitor(janitor())).toContain("`svc/legacy-billing` looks idle after 90 days");
  });

  test("an active resource does not read as idle", () => {
    const out = renderJanitor(janitor({ idle: false }));
    expect(out).toContain("still active");
    expect(out).not.toContain("looks idle");
  });

  test("a cleanup action is a suggestion, never an action taken", () => {
    const out = renderJanitor(janitor({ cleanupAction: "archive svc/legacy-billing" }));
    expect(out).toContain("`archive svc/legacy-billing`");
    expect(out).toContain("Nimbus never performs this");
  });

  test("a suppressed proposal says so instead of staying silent", () => {
    expect(renderJanitor(janitor({ proposalSuppressed: true }))).toContain(
      "No cleanup proposed",
    );
  });

  test("peers who touched it are named with how long ago", () => {
    const out = renderJanitor(
      janitor({
        idle: false,
        peersClear: 2,
        peersTouched: [{ peerId: "p1", who: "Dana", lastSeenDaysAgo: 3 }],
      }),
    );
    expect(out).toContain("**Dana** — last seen 3 days ago");
    expect(out).toContain("2 peers reported no recent activity");
  });

  test("an unknown last-seen is not rendered as zero days", () => {
    const out = renderJanitor(
      janitor({ peersTouched: [{ peerId: "p1", who: null, lastSeenDaysAgo: null }] }),
    );
    expect(out).toContain("**unattributed** — last seen at an unknown time");
    expect(out).not.toContain("0 days ago");
  });

  test("gap notes reach the footer", () => {
    expect(renderJanitor(janitor({ gaps: [{ detail: "no peer answered" }] }))).toContain(
      "_Data gaps: no peer answered_",
    );
  });
});

describe("renderPreflight", () => {
  test("a failure is stated as not safe to deploy", () => {
    const out = renderPreflight(
      preflight({
        anyFailed: true,
        downstreams: [{ peerId: "p1", who: "checkout", status: "fail", summary: "smoke failed" }],
      }),
    );
    expect(out).toContain("Not safe to deploy");
    expect(out).toContain("**checkout** — FAIL: smoke failed");
  });

  test("an incomplete answer reads as inconclusive, not as a pass", () => {
    const out = renderPreflight(
      preflight({
        anyIncomplete: true,
        downstreams: [
          { peerId: "p1", who: null, status: "not_configured", summary: "no checks defined" },
        ],
      }),
    );
    expect(out).toContain("Inconclusive");
    expect(out).not.toContain("No failures reported");
    expect(out).toContain("not configured (unknown)");
  });

  test("no downstreams says nothing was checked, not that everything passed", () => {
    const out = renderPreflight(preflight());
    expect(out).toContain("nothing was actually checked");
  });

  test("a clean run names the ref and namespace it checked", () => {
    const out = renderPreflight(
      preflight({
        downstreams: [{ peerId: "p1", who: "checkout", status: "pass", summary: "all green" }],
      }),
    );
    expect(out).toContain("No failures reported for `release-1.4` in `billing`");
  });

  test("a declined downstream is named rather than dropped", () => {
    const out = renderPreflight(
      preflight({
        anyIncomplete: true,
        downstreams: [{ peerId: "p9", who: null, status: "declined", summary: "peer opted out" }],
      }),
    );
    expect(out).toContain("**p9** — declined (no answer): peer opted out");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/briefs-render.test.ts`
Expected: FAIL — `renderJanitor is not a function` / `renderPreflight is not a function`.

- [ ] **Step 3: Implement the renderers**

Append to `src/briefs/render.ts`, and add `JanitorBrief`, `PreflightBrief` to the type import on line 1:

```ts
// A downstream that did not answer is NOT a pass. This brief exists to inform
// deploy decisions, and a silent absence of failure is not a green light — so
// the two non-answers name themselves as unknown.
const PREFLIGHT_STATUS: Record<PreflightBrief["downstreams"][number]["status"], string> = {
  pass: "pass",
  fail: "FAIL",
  declined: "declined (no answer)",
  not_configured: "not configured (unknown)",
};

export function renderJanitor(brief: JanitorBrief): string {
  const target = `\`${brief.query.resourceRef}\``;
  const window = plural(brief.query.idleDays, "day");
  const lines: string[] = [
    brief.idle
      ? `${target} looks idle after ${window} with no activity.`
      : `${target} is still active within the last ${window}.`,
  ];

  if (brief.peersTouched.length > 0) {
    lines.push("", "### Recently touched by");
    for (const peer of brief.peersTouched) {
      const when =
        peer.lastSeenDaysAgo === null
          ? "at an unknown time"
          : `${plural(peer.lastSeenDaysAgo, "day")} ago`;
      lines.push(`- **${peer.who ?? "unattributed"}** — last seen ${when}`);
    }
  }
  if (brief.peersClear > 0) {
    lines.push("", `${plural(brief.peersClear, "peer")} reported no recent activity.`);
  }

  // Rendered, never run. Output is a suggestion, never an applied edit — the
  // rule the SCM trio already follows.
  if (brief.cleanupAction !== null) {
    lines.push(
      "",
      `Suggested cleanup: \`${brief.cleanupAction}\``,
      "",
      "_Nimbus never performs this. Run it yourself if you agree._",
    );
  }
  if (brief.proposalSuppressed) {
    lines.push("", "_No cleanup proposed: the agent suppressed it._");
  }
  return `${lines.join("\n")}${gapsFooter(brief)}`;
}

function preflightHeadline(brief: PreflightBrief, target: string): string {
  if (brief.anyFailed) return `Not safe to deploy ${target}: a downstream check failed.`;
  if (brief.anyIncomplete) return `Inconclusive for ${target}: some downstreams did not report.`;
  return `No failures reported for ${target}.`;
}

export function renderPreflight(brief: PreflightBrief): string {
  const target = `\`${brief.query.ref}\` in \`${brief.query.namespace}\``;
  const headline = preflightHeadline(brief, target);
  if (brief.downstreams.length === 0) {
    return `${headline}\n\nNo downstreams answered, so nothing was actually checked.${gapsFooter(brief)}`;
  }
  const lines = brief.downstreams.map(
    (d) => `- **${d.who ?? d.peerId}** — ${PREFLIGHT_STATUS[d.status]}: ${d.summary}`,
  );
  return `${headline}\n${lines.join("\n")}${gapsFooter(brief)}`;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test test/unit/briefs-render.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/render.ts test/unit/briefs-render.test.ts
git commit -m "feat(briefs): render the janitor and preflight briefs"
```

---

### Task 2: The `nimbus.briefs.defaultNamespace` setting

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`), `src/settings.ts`, `docs/settings.md`
- Test: `test/unit/settings.test.ts`

**Interfaces:**
- Produces: `Settings.defaultNamespace(): string` — `""` when unset.

**Why now:** Task 6 reads it for the Preflight prompt's prefill.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/settings.test.ts`, following the file's existing style for a string setting:

```ts
test("defaultNamespace is empty by default", () => {
  const s = createSettings(configWith({}));
  expect(s.defaultNamespace()).toBe("");
});

test("defaultNamespace reads briefs.defaultNamespace", () => {
  const s = createSettings(configWith({ "briefs.defaultNamespace": "billing" }));
  expect(s.defaultNamespace()).toBe("billing");
});
```

If the file's helper is named differently from `configWith`, use whatever `settings.test.ts` already defines for building a `WorkspaceApi` — do not add a second helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test test/unit/settings.test.ts`
Expected: FAIL — `s.defaultNamespace is not a function`.

- [ ] **Step 3: Add the setting**

`src/settings.ts` — add to the `Settings` interface next to `showHoverBlame()`:

```ts
  defaultNamespace(): string;
```

and to the returned object, next to `showHoverBlame`:

```ts
    defaultNamespace: () => cfg().get<string>("briefs.defaultNamespace", ""),
```

`package.json` — add immediately after the `"nimbus.briefs.showHoverBlame"` property:

```json
        "nimbus.briefs.defaultNamespace": {
          "type": "string",
          "default": "",
          "description": "Prefills the namespace prompt for the 'Safe to deploy?' brief. agents.preflight requires a namespace and Nimbus never guesses one — a wrong namespace returns a confident answer about the wrong thing, so this only prefills a prompt you still confirm."
        },
```

`docs/settings.md` — add a section after `### nimbus.briefs.showHoverBlame`:

```markdown
### `nimbus.briefs.defaultNamespace`

`string` (default `""`). Prefills the namespace prompt for **Safe to deploy?** (`agents.preflight`), which requires a namespace the extension has no way to derive. It is only a prefill: the prompt still appears and you still confirm it. Nimbus deliberately does not infer the namespace from the branch name or `package.json` — a wrong namespace does not error, it returns a confident `preflight` answer computed for something you never asked about. A namespace you have already typed in this workspace folder takes precedence over this setting.
```

- [ ] **Step 4: Run the tests and the settings-doc guard**

Run: `bun run test test/unit/settings.test.ts && bun run check-settings-docs`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add package.json src/settings.ts docs/settings.md test/unit/settings.test.ts
git commit -m "feat(briefs): add nimbus.briefs.defaultNamespace"
```

---

### Task 3: Per-folder namespace memory

**Files:**
- Modify: `src/briefs/params.ts` (extract `rootFor`)
- Create: `src/briefs/namespace-store.ts`
- Test: `test/unit/briefs-namespace-store.test.ts`, `test/unit/briefs-params.test.ts`

**Interfaces:**
- Consumes: `MementoLike` from `../vscode-shim.js` (`get<T>(key)`, `update(key, value)`).
- Produces:
  - `rootFor(fileName: string, roots: readonly string[]): string | undefined` (from `params.ts`) — the containing root, returned in its **original** casing, longest first.
  - `memoryFolder(activeFile: string | undefined, roots: readonly string[]): string | undefined`
  - `createNamespaceStore(memento: MementoLike): NamespaceStore` with `recall(folder: string | undefined): string | undefined` and `remember(folder: string | undefined, namespace: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/briefs-namespace-store.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { createNamespaceStore, memoryFolder } from "../../src/briefs/namespace-store.js";
import type { MementoLike } from "../../src/vscode-shim.js";

function memento(): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  } as MementoLike & { store: Map<string, unknown> };
}

describe("memoryFolder", () => {
  test("the sole root is used when there is no editor", () => {
    expect(memoryFolder(undefined, ["/home/dev/a"])).toBe("/home/dev/a");
  });

  test("the active editor picks its own root out of several", () => {
    expect(memoryFolder("/home/dev/b/src/x.ts", ["/home/dev/a", "/home/dev/b"])).toBe(
      "/home/dev/b",
    );
  });

  // The whole point of keying per folder: with no editor and several roots
  // there is no unambiguous project, so nothing is recalled and the prefill
  // falls through to the setting. A namespace from another project is a guess.
  test("no editor and several roots yields no folder", () => {
    expect(memoryFolder(undefined, ["/home/dev/a", "/home/dev/b"])).toBeUndefined();
  });

  test("no roots at all yields no folder", () => {
    expect(memoryFolder("/tmp/scratch.ts", [])).toBeUndefined();
  });
});

describe("namespace store", () => {
  test("a namespace remembered for one folder is not recalled for another", async () => {
    const store = createNamespaceStore(memento());
    await store.remember("/home/dev/a", "billing");
    expect(store.recall("/home/dev/a")).toBe("billing");
    expect(store.recall("/home/dev/b")).toBeUndefined();
  });

  test("an unknown folder recalls nothing", () => {
    expect(createNamespaceStore(memento()).recall(undefined)).toBeUndefined();
  });

  test("nothing is written without a folder", async () => {
    const m = memento();
    await createNamespaceStore(m).remember(undefined, "billing");
    expect(m.store.size).toBe(0);
  });

  test("an empty namespace is never remembered", async () => {
    const m = memento();
    await createNamespaceStore(m).remember("/home/dev/a", "");
    expect(m.store.size).toBe(0);
  });

  // Stored state is external data, exactly as skip-store treats it.
  test("a non-string stored value is ignored rather than returned", () => {
    const m = memento();
    m.store.set("nimbus.briefs.namespace:/home/dev/a", 42);
    expect(createNamespaceStore(m).recall("/home/dev/a")).toBeUndefined();
  });
});
```

Add to `test/unit/briefs-params.test.ts`:

```ts
test("rootFor returns the containing root in its original casing", () => {
  expect(rootFor("c:/proj/src/a.ts", ["C:/Proj"])).toBe("C:/Proj");
});

test("rootFor prefers the innermost of nested roots", () => {
  expect(rootFor("/a/b/c/x.ts", ["/a", "/a/b"])).toBe("/a/b");
});

test("rootFor returns undefined when no root contains the file", () => {
  expect(rootFor("/elsewhere/x.ts", ["/a"])).toBeUndefined();
});
```

(add `rootFor` to that file's import from `../../src/briefs/params.js`)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test test/unit/briefs-namespace-store.test.ts test/unit/briefs-params.test.ts`
Expected: FAIL — module `namespace-store.js` not found, and `rootFor is not a function`.

- [ ] **Step 3: Extract `rootFor` and write the store**

In `src/briefs/params.ts`, replace the body of `toRelativeRef` with a shared helper. The matching rules — longest root first, case-insensitive compare, slice from the original string — are unchanged; only their location moves:

```ts
/**
 * The workspace root containing `fileName`, returned in the ORIGINAL casing the
 * caller passed in, or undefined when none matches. Longest root first: with
 * nested folders open the innermost is the useful one, and a shorter parent
 * would otherwise win by appearing earlier.
 *
 * Compares case-insensitively because on Windows the editor's fileName and the
 * workspace folder can disagree on drive-letter case ("C:/" vs "c:/").
 */
export function rootFor(fileName: string, roots: readonly string[]): string | undefined {
  const file = normalise(fileName).toLowerCase();
  const sorted = [...roots].sort((a, b) => normalise(b).length - normalise(a).length);
  for (const root of sorted) {
    const n = normalise(root);
    const prefix = (n.endsWith("/") ? n : `${n}/`).toLowerCase();
    if (file.startsWith(prefix)) return root;
  }
  return undefined;
}

export function toRelativeRef(fileName: string, roots: readonly string[]): string {
  const file = normalise(fileName);
  const root = rootFor(fileName, roots);
  if (root === undefined) return basename(file);
  const n = normalise(root);
  // Slice from the ORIGINAL string so real casing survives — the Gateway's
  // index may be case-sensitive.
  return file.slice((n.endsWith("/") ? n : `${n}/`).length);
}
```

Create `src/briefs/namespace-store.ts`:

```ts
import { rootFor } from "./params.js";
import type { MementoLike } from "../vscode-shim.js";

// The last namespace the user typed and confirmed for Preflight, keyed PER
// WORKSPACE FOLDER.
//
// workspaceState is shared across the whole VS Code window, so a single key
// would let a Preflight in one project prefill another's prompt. That is not
// "a value the user confirmed here" — it is a guess wearing a confirmation's
// clothes, and a wrong namespace does not error: agents.preflight returns a
// confidently green brief computed for something the user never asked about.
// The design doc rejects deriving the namespace for exactly that reason, so a
// stale cross-project prefill has to be rejected on the same grounds.

const PREFIX = "nimbus.briefs.namespace:";

export interface NamespaceStore {
  recall(folder: string | undefined): string | undefined;
  remember(folder: string | undefined, namespace: string): Promise<void>;
}

/**
 * The folder to key the memory on: the root containing the active editor, else
 * the sole root. With no editor and several roots there is no unambiguous
 * project, so this returns undefined and the caller recalls nothing — failing
 * to the safe side costs one typed namespace.
 */
export function memoryFolder(
  activeFile: string | undefined,
  roots: readonly string[],
): string | undefined {
  const containing = activeFile === undefined ? undefined : rootFor(activeFile, roots);
  if (containing !== undefined) return containing;
  return roots.length === 1 ? roots[0] : undefined;
}

export function createNamespaceStore(memento: MementoLike): NamespaceStore {
  return {
    // Stored state is external data: anything that is not a non-empty string
    // recalls nothing, so a corrupted or hand-edited value fails closed.
    recall: (folder) => {
      if (folder === undefined) return undefined;
      const value = memento.get<unknown>(`${PREFIX}${folder}`);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    remember: async (folder, namespace) => {
      if (folder === undefined || namespace.length === 0) return;
      await memento.update(`${PREFIX}${folder}`, namespace);
    },
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test test/unit/briefs-namespace-store.test.ts test/unit/briefs-params.test.ts && bun run typecheck`
Expected: PASS. The pre-existing `toRelativeRef` tests must still pass — the extraction changed no behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/namespace-store.ts src/briefs/params.ts test/unit/briefs-namespace-store.test.ts test/unit/briefs-params.test.ts
git commit -m "feat(briefs): remember the preflight namespace per workspace folder"
```

---

### Task 4: Parameter builders for the prompted briefs

**Files:**
- Modify: `src/briefs/params.ts`
- Test: `test/unit/briefs-params.test.ts`

**Interfaces:**
- Produces:
  - `janitorParams(t: { resourceRef: string; idleDays?: number }): { resourceRef: string; idleDays?: number }`
  - `preflightParams(t: { ref: string; namespace: string }): { ref: string; namespace: string }`

**Design note:** these do **not** relativise their input. A resource ref may legitimately not be a file (`svc/legacy-billing`), so mangling it through `toRelativeRef` would corrupt it. The prefill is already relative, and if a user types an absolute path anyway, the gate's manifest and its leak check flag it before anything is sent — which is what the gate is for.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/briefs-params.test.ts` (import `janitorParams`, `preflightParams`):

```ts
test("janitorParams omits idleDays entirely when it was not supplied", () => {
  expect(janitorParams({ resourceRef: "svc/legacy" })).toEqual({ resourceRef: "svc/legacy" });
  expect("idleDays" in janitorParams({ resourceRef: "svc/legacy" })).toBe(false);
});

test("janitorParams passes idleDays through when supplied", () => {
  expect(janitorParams({ resourceRef: "svc/legacy", idleDays: 30 })).toEqual({
    resourceRef: "svc/legacy",
    idleDays: 30,
  });
});

test("janitorParams leaves a non-file resource ref untouched", () => {
  expect(janitorParams({ resourceRef: "svc/legacy" }).resourceRef).toBe("svc/legacy");
});

test("preflightParams carries the ref and namespace verbatim", () => {
  expect(preflightParams({ ref: "release-1.4", namespace: "billing" })).toEqual({
    ref: "release-1.4",
    namespace: "billing",
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test test/unit/briefs-params.test.ts`
Expected: FAIL — `janitorParams is not a function`.

- [ ] **Step 3: Implement the builders**

Append to `src/briefs/params.ts`:

```ts
/** What the Janitor prompt collects. `idleDays` omitted = the Gateway's default. */
export interface JanitorTarget {
  resourceRef: string;
  idleDays?: number;
}

/**
 * Deliberately NOT relativised: a resource ref is often not a file at all
 * ("svc/legacy-billing"), so putting it through toRelativeRef would corrupt it.
 * The prompt prefills a relative ref; anything else the user types is their
 * choice, and the gate's manifest shows it — with a leak warning if it carries
 * an absolute path — before it is sent.
 */
export function janitorParams(t: JanitorTarget): { resourceRef: string; idleDays?: number } {
  return {
    resourceRef: t.resourceRef,
    ...(t.idleDays !== undefined ? { idleDays: t.idleDays } : {}),
  };
}

export function preflightParams(t: { ref: string; namespace: string }): {
  ref: string;
  namespace: string;
} {
  return { ref: t.ref, namespace: t.namespace };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test test/unit/briefs-params.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/params.ts test/unit/briefs-params.test.ts
git commit -m "feat(briefs): build janitor and preflight params"
```

---

### Task 5: Route janitor and preflight through the gate

**Files:**
- Modify: `src/egress/gated-client.ts`
- Test: `test/unit/egress-gated-client.test.ts`

**Interfaces:**
- Consumes: `EgressGate`, `EgressMeta`, the existing `run` helper inside `gateRawBriefs`.
- Produces: `RawBriefClient` gains `agentsJanitor` / `agentsPreflight`; `GatedBriefs` gains `janitor: GatedBrief<JanitorParams, JanitorBrief>` and `preflight: GatedBrief<PreflightParams, PreflightBrief>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/egress-gated-client.test.ts`, matching the file's existing harness for `gateRawBriefs`:

```ts
test("janitor passes its params through the gate before sending", async () => {
  const seen: string[] = [];
  const gate = { check: async (_k, prompt) => { seen.push(prompt); return "send"; }, record: () => undefined, lastPayload: () => undefined } as unknown as EgressGate;
  const client = { agentsJanitor: async () => ({ kind: "janitor" }) } as unknown as RawBriefClient;
  await gateRawBriefs(client, gate).janitor(
    { resourceRef: "svc/legacy", idleDays: 30 },
    { action: "Is this idle? (agents.janitor)", files: [], omissions: [] },
    "Nimbus: checking…",
  );
  expect(seen[0]).toContain('"resourceRef": "svc/legacy"');
});

test("a cancelled preflight never reaches the client", async () => {
  let called = false;
  const gate = { check: async () => "cancel", record: () => undefined, lastPayload: () => undefined } as unknown as EgressGate;
  const client = {
    agentsPreflight: async () => { called = true; return { kind: "preflight" }; },
  } as unknown as RawBriefClient;
  await expect(
    gateRawBriefs(client, gate).preflight(
      { ref: "release-1.4", namespace: "billing" },
      { action: "Safe to deploy? (agents.preflight)", files: [], omissions: [] },
      "Nimbus: checking…",
    ),
  ).rejects.toBeInstanceOf(EgressCancelled);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test test/unit/egress-gated-client.test.ts`
Expected: FAIL — `gateRawBriefs(...).janitor is not a function`.

- [ ] **Step 3: Extend the seam**

In `src/egress/gated-client.ts`, add `JanitorBrief`, `JanitorParams`, `PreflightBrief`, `PreflightParams` to the type import from `@nimbus-dev/client`, then:

```ts
export interface RawBriefClient {
  agentsWhy(p: WhyParams, o?: { timeoutMs?: number }): Promise<WhyBrief>;
  agentsGhost(p: GhostParams, o?: { timeoutMs?: number }): Promise<GhostBrief>;
  agentsConflicts(p: ConflictsParams, o?: { timeoutMs?: number }): Promise<ConflictBrief>;
  agentsHuddle(p?: HuddleParams, o?: { timeoutMs?: number }): Promise<HuddleBrief>;
  agentsJanitor(p: JanitorParams, o?: { timeoutMs?: number }): Promise<JanitorBrief>;
  agentsPreflight(p: PreflightParams, o?: { timeoutMs?: number }): Promise<PreflightBrief>;
}

export interface GatedBriefs {
  why: GatedBrief<WhyParams, WhyBrief>;
  ghost: GatedBrief<GhostParams, GhostBrief>;
  conflicts: GatedBrief<ConflictsParams, ConflictBrief>;
  huddle: GatedBrief<HuddleParams, HuddleBrief>;
  janitor: GatedBrief<JanitorParams, JanitorBrief>;
  preflight: GatedBrief<PreflightParams, PreflightBrief>;
}
```

and in the object returned by `gateRawBriefs`, alongside the existing four:

```ts
    janitor: (p, meta, title) =>
      run((q: JanitorParams) => client.agentsJanitor(q), p, meta, title),
    preflight: (p, meta, title) =>
      run((q: PreflightParams) => client.agentsPreflight(q), p, meta, title),
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test test/unit/egress-gated-client.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/egress/gated-client.ts test/unit/egress-gated-client.test.ts
git commit -m "feat(egress): gate the janitor and preflight brief calls"
```

---

### Task 6: The prompted commands, and prompt-before-`contain`

**Files:**
- Modify: `src/briefs/commands.ts`
- Test: `test/unit/briefs-commands.test.ts`

**Interfaces:**
- Consumes: `janitorParams`, `preflightParams`, `JanitorTarget` (Task 4); `createNamespaceStore`, `memoryFolder` (Task 3); `renderJanitor`, `renderPreflight` (Task 1); `GatedBriefs.janitor` / `.preflight` (Task 5); `Settings.defaultNamespace` (Task 2).
- Produces: `BriefCommandDeps` gains `namespaces: NamespaceStore`, `defaultNamespace(): string`, and `window.showInputBox`. `BriefCommands` gains `janitor(): Promise<void>` and `preflight(): Promise<void>`.

**The two behaviours this task must get right:**
1. Prompts resolve **before** `contain`, so **Retry re-sends rather than re-asks**. Same hoist for `why`/`ghost`/`conflicts`, whose targets are currently re-derived inside `contain` — a cursor moved between failure and retry silently redirects the retry to a different line.
2. A dismissed prompt returns **silently**. A user who cancelled has not failed at anything and must not get an error toast with a Retry button.

- [ ] **Step 1: Write the failing tests**

Add to the harness in `test/unit/briefs-commands.test.ts`: extend the `briefs()` stub with `janitor` and `preflight` recorders (same `record(...)` shape, returning `{ ...BASE, kind: "janitor", query: { resourceRef: "svc/legacy", idleDays: 90 }, idle: true, proposalSuppressed: false, cleanupAction: null, peersClear: 0, peersTouched: [] }` and `{ ...BASE, kind: "preflight", query: { ref: "release-1.4", namespace: "billing" }, downstreams: [], anyFailed: false, anyIncomplete: false }`), add a scripted input box, and add the two new deps:

```ts
  const inputs: string[] = [];
  const prompts: string[] = [];
  const answers: Array<string | undefined> = [...(over.__answers ?? [])];
```

Rather than smuggle answers through `over`, give `harness` a second parameter. Replace its signature with
`function harness(over: Partial<BriefCommandDeps> = {}, fail?: Error, answers: Array<string | undefined> = [])`
and add to `deps`:

```ts
    namespaces: {
      recall: () => remembered,
      remember: async (_folder: string | undefined, ns: string) => {
        remembered = ns;
      },
    },
    defaultNamespace: () => "from-setting",
```

with `let remembered: string | undefined;` declared above, exposed on the returned harness. Extend the `window` stub:

```ts
      showInputBox: async (opts?: { prompt?: string; value?: string; validateInput?: (v: string) => string | undefined }) => {
        prompts.push(opts?.prompt ?? "");
        prefills.push(opts?.value);
        validators.push(opts?.validateInput);
        return answers.shift();
      },
```

Then the tests:

```ts
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

  test("the manifest names the resource, not a file path", async () => {
    const h = harness({}, undefined, ["svc/legacy", ""]);
    await createBriefCommands(h.deps).janitor();
    expect(h.calls[0]?.meta).toEqual({
      action: "Is this idle? (agents.janitor)",
      files: [{ name: "svc/legacy", note: "the extension sends this path, not the file's contents" }],
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
    expect(h.prompts.length).toBe(2);
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]?.params).toEqual({ ref: "release-1.4", namespace: "billing" });
  });

  test("retrying why answers about the line it originally resolved", async () => {
    let line = 6;
    const h = harness(
      {
        activeEditor: () => ({
          document: { getText: () => "", fileName: "/home/dev/proj/src/a.ts", languageId: "ts", uri: { scheme: "file" } },
          selection: { isEmpty: true, active: { line } },
        }),
      },
      new Error("gateway down"),
    );
    h.retryOnce = true;
    h.onFirstFailure = () => { line = 40; };
    await createBriefCommands(h.deps).why();
    expect(h.calls[1]?.params).toEqual({ ref: "src/a.ts", line: 7 });
  });
});
```

To make `retryOnce` work, the harness's `showErrorMessage` returns `"Retry"` the first time when `retryOnce` is set, and the `record` helper calls `onFirstFailure?.()` then clears `fail` after the first throw so the retry succeeds. Wire that in the harness rather than in each test.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test test/unit/briefs-commands.test.ts`
Expected: FAIL — `createBriefCommands(...).janitor is not a function`, plus the retry tests failing on prompt counts.

- [ ] **Step 3: Implement**

In `src/briefs/commands.ts`:

Extend the imports and the deps interface:

```ts
import { type JanitorTarget, janitorParams, preflightParams } from "./params.js";
import { memoryFolder, type NamespaceStore } from "./namespace-store.js";
import { renderJanitor, renderPreflight } from "./render.js";
```

```ts
export interface BriefCommandDeps {
  // …existing members unchanged…
  /** Last namespace typed and confirmed, keyed per workspace folder. */
  namespaces: NamespaceStore;
  /** The nimbus.briefs.defaultNamespace setting; "" when unset. */
  defaultNamespace(): string;
  window: {
    showErrorMessage(msg: string, opts?: MessageOptionsLike, ...items: string[]): Thenable<string | undefined>;
    showInformationMessage(msg: string, opts?: MessageOptionsLike, ...items: string[]): Thenable<string | undefined>;
    showInputBox(opts?: {
      prompt?: string;
      value?: string;
      placeHolder?: string;
      validateInput?: (value: string) => string | undefined;
    }): Thenable<string | undefined>;
  };
  log: Logger;
}

export interface BriefCommands {
  why(args?: EditorTarget): Promise<void>;
  ghost(args?: EditorTarget): Promise<void>;
  conflicts(args?: EditorTarget): Promise<void>;
  huddle(): Promise<void>;
  janitor(): Promise<void>;
  preflight(): Promise<void>;
}
```

Widen `meta()` so a prompted brief names the ref the user typed:

```ts
// `prompted` briefs carry a ref the user typed rather than an editor path, so
// the manifest names that ref. BRIEF_FILE_NOTE still applies: the extension
// sends a path, and what the Gateway does after is the ledger's business.
function promptedMeta(id: BriefId, ref: string): EgressMeta {
  return {
    action: `${briefSpec(id).label} (agents.${id})`,
    files: [{ name: ref, note: BRIEF_FILE_NOTE }],
    omissions: [],
  };
}
```

Add the prompt helpers inside `createBriefCommands`, above the returned object:

```ts
  const POSITIVE_INT = /^[1-9]\d*$/;
  const IDLE_DAYS_ERROR =
    "Enter a whole number of days greater than zero, or leave blank for the Gateway default.";

  // showInputBox has THREE outcomes, not two, and collapsing them sends
  // something the user tried to cancel. Escape returns undefined; Enter on a
  // blank box returns "". Those mean opposite things on the idleDays prompt —
  // abort the command, versus accept the Gateway's default — so the type keeps
  // them apart rather than the call sites guessing.
  type Answer = { kind: "dismissed" } | { kind: "value"; value: string };

  const ask = async (
    prompt: string,
    opts: { value?: string; validate?: (v: string) => string | undefined } = {},
  ): Promise<Answer> => {
    const answer = await deps.window.showInputBox({
      prompt,
      ...(opts.value !== undefined && opts.value.length > 0 ? { value: opts.value } : {}),
      ...(opts.validate !== undefined ? { validateInput: opts.validate } : {}),
    });
    if (answer === undefined) return { kind: "dismissed" };
    return { kind: "value", value: answer.trim() };
  };

  /** A required answer: dismissed or blank both cancel, and both do so silently. */
  const askRequired = async (
    prompt: string,
    opts: { value?: string } = {},
  ): Promise<string | undefined> => {
    const answer = await ask(prompt, opts);
    if (answer.kind === "dismissed" || answer.value.length === 0) return undefined;
    return answer.value;
  };

  const askJanitor = async (): Promise<JanitorTarget | undefined> => {
    const editor = deps.activeEditor();
    const prefill =
      editor === undefined ? undefined : toRelativeRef(editor.document.fileName, deps.roots());
    const resourceRef = await askRequired("Resource to check for idleness", {
      ...(prefill !== undefined ? { value: prefill } : {}),
    });
    if (resourceRef === undefined) return undefined;

    const days = await ask("Idle for how many days? (blank = Gateway default)", {
      validate: (v) =>
        v.trim().length === 0 || POSITIVE_INT.test(v.trim()) ? undefined : IDLE_DAYS_ERROR,
    });
    // Escape aborts the whole command. Blank means "use the Gateway default",
    // which is a decision, not an abort. Treating Escape as blank would send a
    // brief the user was trying to cancel — and a user who ticked "Always send
    // Agent Briefs here" gets no modal to catch it.
    if (days.kind === "dismissed") return undefined;
    return days.value.length === 0
      ? { resourceRef }
      : { resourceRef, idleDays: Number(days.value) };
  };

  const askPreflight = async (): Promise<
    { ref: string; namespace: string; folder: string | undefined } | undefined
  > => {
    const ref = await askRequired("Ref to pre-flight (branch, tag or commit)");
    if (ref === undefined) return undefined;
    const editor = deps.activeEditor();
    const folder = memoryFolder(editor?.document.fileName, deps.roots());
    // Remembered first, then the setting. Never derived: a wrong namespace does
    // not error, it answers confidently about the wrong thing.
    const prefill = deps.namespaces.recall(folder) ?? deps.defaultNamespace();
    // Required, so an empty answer cancels rather than sending a guess — the
    // same outcome as Escape, which is why this one uses askRequired.
    const namespace = await askRequired("Namespace to pre-flight against", { value: prefill });
    if (namespace === undefined) return undefined;
    return { ref, namespace, folder };
  };
```

Rewrite the four existing commands to resolve **before** `contain`, and add the two new ones:

```ts
  return {
    why: async (args) => {
      const t = needTarget("why", args);
      if (t === undefined) return;
      await contain("why", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.why(whyParams(t), meta("why", t), "Nimbus: asking why…");
        await show("why", renderWhy(brief));
      });
    },

    ghost: async (args) => {
      const t = needTarget("ghost", args);
      if (t === undefined) return;
      await contain("ghost", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.ghost(fileParams(t), meta("ghost", t), "Nimbus: finding who knew this…");
        await show("ghost", renderGhost(brief));
      });
    },

    conflicts: async (args) => {
      const t = needTarget("conflicts", args);
      if (t === undefined) return;
      await contain("conflicts", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.conflicts(fileParams(t), meta("conflicts", t), "Nimbus: checking for collisions…");
        await show("conflicts", renderConflicts(brief, deps.now()));
      });
    },

    huddle: () =>
      contain("huddle", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.huddle({}, meta("huddle", undefined), "Nimbus: gathering the huddle…");
        await show("huddle", renderHuddle(brief, deps.now()));
      }),

    janitor: async () => {
      const target = await askJanitor();
      if (target === undefined) return;
      await contain("janitor", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.janitor(
          janitorParams(target),
          promptedMeta("janitor", target.resourceRef),
          "Nimbus: checking whether this is idle…",
        );
        await show("janitor", renderJanitor(brief));
      });
    },

    preflight: async () => {
      const answers = await askPreflight();
      if (answers === undefined) return;
      await contain("preflight", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.preflight(
          preflightParams(answers),
          promptedMeta("preflight", answers.ref),
          "Nimbus: pre-flighting…",
        );
        // Only after a successful send: a namespace that never reached the
        // Gateway is not a value worth prefilling next time.
        await deps.namespaces.remember(answers.folder, answers.namespace);
        await show("preflight", renderPreflight(brief));
      });
    },
  };
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test test/unit/briefs-commands.test.ts && bun run typecheck`
Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/commands.ts test/unit/briefs-commands.test.ts
git commit -m "feat(briefs): add the janitor and preflight commands"
```

---

### Task 7: Catalog entries, manifest, and registration

**Files:**
- Modify: `src/briefs/catalog.ts`, `package.json`, `src/extension.ts`
- Test: `test/unit/briefs-catalog.test.ts`, `test/unit/manifest-briefs.test.ts`

**Interfaces:**
- Consumes: `BriefCommands.janitor` / `.preflight` (Task 6), `createNamespaceStore` (Task 3), `Settings.defaultNamespace` (Task 2).
- Produces: `BriefId` includes `"janitor" | "preflight"`; `BriefContext` includes `"prompted"`; `needsEditor(spec: BriefSpec): boolean`.

**Watch out:** `manifest-briefs.test.ts` currently selects editor-menu briefs with `b.context !== "none"`. Adding `"prompted"` would sweep janitor and preflight into that filter and demand context-menu entries the design deliberately omits. Switch both call sites to `needsEditor`.

- [ ] **Step 1: Write the failing tests**

`test/unit/briefs-catalog.test.ts` — this file has three assertions that are **wrong after this task**, so edit rather than append. Import `needsEditor`, then:

*Replace* `"carries exactly the four briefs PR 1 implements"` with:

```ts
  test("carries all six briefs", () => {
    expect(BRIEF_CATALOG.map((b) => b.id)).toEqual([
      "why", "ghost", "conflicts", "huddle", "janitor", "preflight",
    ]);
  });
```

*Retitle* `"every entry is gated — whyPeek, the only exemption, is not in this PR"` — the body is unchanged, but the reason has:

```ts
  // whyPeek is deliberately absent from the catalog: it is a hover, not a row,
  // and an entry would put a dead row in the sidebar. Its gate exemption is
  // enforced by egress-choke-point.test.ts, which DISCOVERS call shapes rather
  // than trusting a hand-kept list.
  test("every entry is gated", () => {
    expect(BRIEF_CATALOG.filter((b) => !b.gated)).toEqual([]);
  });
```

*Extend* `"labels are human sentences, not agent names"` with `expect(briefSpec("janitor").label).toBe("Is this idle?");` and `expect(briefSpec("preflight").label).toBe("Safe to deploy?");`, and *extend* `"context matches what each RPC actually requires"` with `expect(briefSpec("janitor").context).toBe("prompted");` and the same for `preflight`.

*Add*:

```ts
  test("only the editor-context briefs need an editor", () => {
    expect(BRIEF_CATALOG.filter(needsEditor).map((b) => b.id)).toEqual([
      "why", "ghost", "conflicts",
    ]);
  });
```

`test/unit/manifest-briefs.test.ts` — import `needsEditor`, replace both `BRIEF_CATALOG.filter((b) => b.context !== "none")` filters with `BRIEF_CATALOG.filter(needsEditor)`, and add:

```ts
test("the prompted briefs are not in the editor context menu", () => {
  for (const spec of BRIEF_CATALOG.filter((b) => b.context === "prompted")) {
    expect(editorContext.find((e) => e.command === spec.command)).toBeUndefined();
  }
});

// They prompt for everything they need, so gating them on an open editor would
// hide them exactly when a tree row or the palette is the entry point.
test("the prompted briefs are not palette-gated on an open editor", () => {
  for (const spec of BRIEF_CATALOG.filter((b) => b.context === "prompted")) {
    expect(palette.find((e) => e.command === spec.command)?.when).not.toBe("editorIsOpen");
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test test/unit/briefs-catalog.test.ts test/unit/manifest-briefs.test.ts`
Expected: FAIL — the catalog has four entries and `needsEditor` does not exist.

- [ ] **Step 3: Extend the catalog and the manifest**

`src/briefs/catalog.ts` — update the header comment (PR 3 has landed), the two types, add the entries and the helper:

```ts
export type BriefId = "why" | "ghost" | "conflicts" | "huddle" | "janitor" | "preflight";

export type BriefContext =
  /** agentsWhy — needs the file and the cursor line. */
  | "fileAndLine"
  /** agentsGhost / agentsConflicts — need the file only. */
  | "file"
  /** agentsHuddle — every parameter is optional. */
  | "none"
  /**
   * agentsJanitor / agentsPreflight — the caller supplies a resource ref or a
   * git ref plus a namespace. Neither is an editor path, so these prompt.
   */
  | "prompted";
```

Append to `BRIEF_CATALOG`:

```ts
  {
    id: "janitor",
    label: "Is this idle?",
    iconId: "trash",
    command: "nimbus.brief.janitor",
    context: "prompted",
    gated: true,
  },
  {
    id: "preflight",
    label: "Safe to deploy?",
    iconId: "rocket",
    command: "nimbus.brief.preflight",
    context: "prompted",
    gated: true,
  },
```

and add:

```ts
// Briefs whose parameters come from the editor, and which therefore belong in
// the editor context menu and are palette-gated on an open editor. The prompted
// briefs ask for everything they need, so gating them on an editor would hide
// them exactly when the sidebar or the palette is the entry point.
export function needsEditor(spec: BriefSpec): boolean {
  return spec.context === "file" || spec.context === "fileAndLine";
}
```

`package.json` — add to `contributes.commands`, after `nimbus.brief.huddle`:

```json
      {
        "command": "nimbus.brief.janitor",
        "title": "Is this idle?",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.brief.preflight",
        "title": "Safe to deploy?",
        "category": "Nimbus"
      }
```

Add **no** `editor/context` and **no** `commandPalette` entries — a command with no `commandPalette` entry is shown unconditionally, which is what these need (`nimbus.brief.huddle` already relies on this).

`src/extension.ts` — wire the store and the setting into `createBriefCommands` (line ~637):

```ts
  const briefNamespaces = createNamespaceStore(ctx.workspaceState);

  const briefCommands = createBriefCommands({
    briefs: () => {
      const client = nimbus();
      return client === undefined ? undefined : gateRawBriefs(client, egressGate, runWithProgress);
    },
    activeEditor: () => deps.window.activeTextEditor,
    roots: egressRoots,
    now: () => Date.now(),
    openReadonly: openReadonlyJson,
    namespaces: briefNamespaces,
    defaultNamespace: () => settings.defaultNamespace(),
    window: deps.window,
    log,
  });
```

with `import { createNamespaceStore } from "./briefs/namespace-store.js";` added, and register the commands next to the existing four (line ~1263):

```ts
  register("nimbus.brief.janitor", () => briefCommands.janitor());
  register("nimbus.brief.preflight", () => briefCommands.preflight());
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test test/unit/briefs-catalog.test.ts test/unit/manifest-briefs.test.ts test/unit/sidebar-views.test.ts && bun run typecheck`
Expected: PASS. The sidebar rows come free — `builtInBriefRows()` maps the catalog — so if `sidebar-views.test.ts` asserts a built-in row count or the row labels, update it to the six.

- [ ] **Step 5: Commit**

```bash
git add src/briefs/catalog.ts src/extension.ts package.json test/unit/briefs-catalog.test.ts test/unit/manifest-briefs.test.ts
git commit -m "feat(briefs): surface Is this idle? and Safe to deploy?"
```

---

### Task 8: Briefs only run on real files

**Files:**
- Modify: `src/vscode-shim.ts`, `src/extension.ts`
- Test: `test/unit/extension.test.ts`, `test/unit/briefs-commands.test.ts:72`, `test/unit/scm-commands.test.ts:571`

**Interfaces:**
- Produces: `TextEditorLike.document` gains `uri: { scheme: string }` (required).

**Why:** `real-hover.ts:10-12` already draws this line for the hover — "an untitled buffer has no path to blame, and a virtual document — our own read-only brief tabs included — is not in any repo". Today the brief commands accept any active editor and will send `Untitled-1` as a ref. The filter goes at the `activeEditor()` seam so it covers the prefill and the editor briefs at once.

- [ ] **Step 1: Write the failing test**

In `test/unit/extension.test.ts`, alongside the existing activation tests:

```ts
test("a non-file editor is not offered to the brief commands", async () => {
  const virtual = {
    document: { getText: () => "", fileName: "Nimbus — Why is this here?.md", languageId: "markdown", uri: { scheme: "nimbus-readonly" } },
    selection: { isEmpty: true, active: { line: 0 } },
  };
  const deps = makeDeps({ window: { ...stubWindow, activeTextEditor: virtual } });
  await activateWithDeps(ctx, deps);
  await deps.commands.executed("nimbus.brief.why");
  expect(deps.window.infoMessages).toContain('Nimbus: Open a file to run "Why is this here?".');
});
```

Adapt the harness calls to whatever `extension.test.ts` already provides for building deps and invoking a registered command — do not introduce a second harness.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test test/unit/extension.test.ts`
Expected: FAIL — the command runs against the virtual document instead of reporting no editor.

- [ ] **Step 3: Add the scheme to the shim and filter at the seam**

`src/vscode-shim.ts`:

```ts
export interface TextEditorLike {
  document: {
    getText(range?: unknown): string;
    fileName: string;
    languageId: string;
    /** Scheme only. Briefs run against files in a repo; see real-hover.ts. */
    uri: { scheme: string };
  };
  // `active` is the cursor end of the selection — zero-based, straight from
  // vscode.Selection. agentsWhy({ref, line}) needs it; nothing else does yet.
  selection: { isEmpty: boolean; active: { line: number } };
}
```

`src/extension.ts` — above `createBriefCommands`:

```ts
  // Briefs answer questions about a file in a repo. An untitled buffer, a
  // settings editor, or one of our own read-only brief tabs is not one, and a
  // ref like "Untitled-1" is not something the Gateway can look up. The hover
  // already draws this line (real-hover.ts SELECTOR); this is the same rule for
  // the commands.
  const activeFileEditor = (): TextEditorLike | undefined => {
    const editor = deps.window.activeTextEditor;
    return editor?.document.uri.scheme === "file" ? editor : undefined;
  };
```

and change the dep to `activeEditor: activeFileEditor,`. Import `TextEditorLike` from `./vscode-shim.js` if it is not already imported.

Fix the three fixtures the new required field breaks — add `uri: { scheme: "file" }` to the `document` literal at `test/unit/briefs-commands.test.ts:72`, `test/unit/extension.test.ts:314`, and `test/unit/scm-commands.test.ts:571`.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS. Typecheck is what finds any fixture missed above.

- [ ] **Step 5: Commit**

```bash
git add src/vscode-shim.ts src/extension.ts test/unit/
git commit -m "fix(briefs): only offer a brief for a real file"
```

---

### Task 9: Route the participant's three briefs through the seam

**Files:**
- Modify: `src/egress/gated-client.ts`, `src/chat-participant/participant-types.ts`, `src/chat-participant/ops-commands.ts`, `src/extension.ts`
- Test: `test/unit/egress-gated-client.test.ts`, `test/unit/egress-choke-point.test.ts`, `test/unit/participant.test.ts`

**Interfaces:**
- Produces:
  - `RawParticipantBriefClient` — `agentsCatchup` / `agentsExpert` / `agentsImpact`.
  - `ParticipantBrief<P, B> = (p: P, meta: EgressMeta) => Promise<B>` — no `progressTitle`; the chat turn renders its own progress.
  - `ParticipantBriefs` — `catchup`, `expert`, `impact`.
  - `gateRawParticipantBriefs(client: RawParticipantBriefClient, gate: EgressGate): ParticipantBriefs`.
  - `ParticipantClientLike` swaps its three `agents*` methods for `briefs: ParticipantBriefs`.

**Two things to get right:**
1. **Record, do not prompt.** `gate.record` under kind `"participant"` — the argument is text the user typed after a slash command, and a modal must not interrupt a chat turn. One function per gate behaviour, so neither can be reached by passing the wrong argument to the other.
2. **`/blast` and `/owns` currently send an absolute local path.** With no argument they fall back to `req.selection?.path`, which `participant-types.ts:20` documents as "the REAL local path: redacted before it is sent to the Gateway" — and `ops-commands.ts:84,101` pass it straight into the RPC. Redact it with `redactPath`, the same helper `prompt.ts:25` already applies to the same file in free-form turns.

- [ ] **Step 1: Write the failing tests**

`test/unit/egress-gated-client.test.ts`:

```ts
test("participant briefs record without ever prompting", async () => {
  const recorded: Array<{ kind: string; prompt: string }> = [];
  let checked = false;
  const gate = {
    check: async () => { checked = true; return "send"; },
    record: (kind: string, prompt: string) => { recorded.push({ kind, prompt }); },
    lastPayload: () => undefined,
  } as unknown as EgressGate;
  const client = { agentsImpact: async () => ({ kind: "impact" }) } as unknown as RawParticipantBriefClient;

  await gateRawParticipantBriefs(client, gate).impact(
    { fileOrPrUrl: "session.ts" },
    { action: "Blast radius (agents.impact)", files: [], omissions: [] },
  );

  expect(checked).toBe(false);
  expect(recorded[0]?.kind).toBe("participant");
  expect(recorded[0]?.prompt).toContain('"fileOrPrUrl": "session.ts"');
});

// Restricted Mode changes nothing here: isTrusted is read only inside check,
// where it suppresses a stored skip. record never reads it, and nothing was
// being suppressed.
test("an untrusted workspace does not change participant brief routing", async () => {
  let checked = false;
  const gate = {
    check: async () => { checked = true; return "send"; },
    record: () => undefined,
    lastPayload: () => undefined,
  } as unknown as EgressGate;
  const client = { agentsCatchup: async () => ({ kind: "catchup" }) } as unknown as RawParticipantBriefClient;
  await gateRawParticipantBriefs(client, gate).catchup({ sinceMs: 1 }, { action: "a", files: [], omissions: [] });
  expect(checked).toBe(false);
});
```

`test/unit/egress-choke-point.test.ts` — move the three shapes into the gated list and delete the pending list:

```ts
const GATED_BRIEF_CALLS = [
  ".agentsWhy(", ".agentsGhost(", ".agentsConflicts(", ".agentsHuddle(",
  ".agentsJanitor(", ".agentsPreflight(",
  ".agentsCatchup(", ".agentsExpert(", ".agentsImpact(",
];

// agents* calls that are deliberately NOT gated. `.agentsWhyPeek(` is the only
// one, and it is on evidence rather than convenience: it takes no timeoutMs,
// returns synchronously, and carries no `brief` string or AgentBriefBase — it
// never reaches a model, so there is nothing for a pre-flight preview to show.
const UNGATED_BY_DESIGN = [".agentsWhyPeek("];
```

and in the final test, delete the `UNGATED_PENDING_PR3` filter line. Update the comment above `GATED_BRIEF_CALLS` — it currently explains why the list is deliberately short; that reason is gone.

`test/unit/participant.test.ts` — the ops-command tests need their client stub reshaped from three `agents*` methods to a `briefs` object. Add:

```ts
test("/blast with no argument sends a basename, never the absolute path", async () => {
  const sent: unknown[] = [];
  const client = clientStub({
    briefs: {
      impact: async (p: unknown) => { sent.push(p); return impactBrief(); },
      expert: async () => expertBrief(),
      catchup: async () => catchupBrief(),
    },
  });
  await runOpsCommand(client, { prompt: "", command: "blast", attachments: [], selection: { path: "/home/dev/proj/src/session.ts", languageId: "ts", code: "" } }, sink, silentLog);
  expect(sent[0]).toEqual({ fileOrPrUrl: "session.ts" });
});
```

using whatever brief factories and `sink` that file already defines.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run test test/unit/egress-gated-client.test.ts test/unit/egress-choke-point.test.ts test/unit/participant.test.ts`
Expected: FAIL — `gateRawParticipantBriefs` is not exported, and the choke-point test reports `ops-commands.ts` as an offender for the three call shapes.

- [ ] **Step 3: Implement**

`src/egress/gated-client.ts` — add `CatchupBrief`, `CatchupParams`, `ExpertBrief`, `ExpertParams`, `ImpactBrief`, `ImpactParams` to the type import, then append:

```ts
// ---------------------------------------------------------------------------
// Participant briefs.
//
// The chat participant's three ops briefs take an argument the user typed after
// a slash command, so they follow the same rule as askStream: record, do not
// prompt. gate.ts splits kinds on exactly this principle — only the surfaces
// where the EXTENSION decides what is sent prompt.
//
// A separate constructor rather than a flag on gateRawBriefs: one function per
// gate behaviour, each named for what it does, and neither reachable by passing
// the wrong argument to the other.

export interface RawParticipantBriefClient {
  agentsCatchup(p?: CatchupParams, o?: { timeoutMs?: number }): Promise<CatchupBrief>;
  agentsExpert(p: ExpertParams, o?: { timeoutMs?: number }): Promise<ExpertBrief>;
  agentsImpact(p: ImpactParams, o?: { timeoutMs?: number }): Promise<ImpactBrief>;
}

/** No progressTitle: the chat turn already renders its own progress. */
export type ParticipantBrief<P, B> = (p: P, meta: EgressMeta) => Promise<B>;

export interface ParticipantBriefs {
  catchup: ParticipantBrief<CatchupParams, CatchupBrief>;
  expert: ParticipantBrief<ExpertParams, ExpertBrief>;
  impact: ParticipantBrief<ImpactParams, ImpactBrief>;
}

export function gateRawParticipantBriefs(
  client: RawParticipantBriefClient,
  gate: EgressGate,
): ParticipantBriefs {
  // Stringified by the seam, so no call site can send a shape the ledger did
  // not record. Pretty-printed to match gateRawBriefs.
  const run = async <P, B>(call: (p: P) => Promise<B>, p: P, meta: EgressMeta): Promise<B> => {
    gate.record("participant", JSON.stringify(p, null, 2), meta);
    return call(p);
  };

  return {
    catchup: (p, meta) => run((q: CatchupParams) => client.agentsCatchup(q), p, meta),
    expert: (p, meta) => run((q: ExpertParams) => client.agentsExpert(q), p, meta),
    impact: (p, meta) => run((q: ImpactParams) => client.agentsImpact(q), p, meta),
  };
}
```

`src/chat-participant/participant-types.ts` — drop the three `agents*` members and the now-unused `CatchupBrief`/`ExpertBrief`/`ImpactBrief`/`…Params` type imports, and add:

```ts
import type { ParticipantBriefs } from "../egress/gated-client.js";

export interface ParticipantClientLike {
  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle;
  searchRanked(params?: RankedSearchParams): Promise<RankedSearchItem[]>;
  /** The ops briefs, pre-routed through the egress seam. */
  briefs: ParticipantBriefs;
  metricsDora(params: MetricsDoraParams): Promise<DoraMetricsResult>;
  egressHead(): Promise<{ head: string; count: number }>;
}
```

`src/chat-participant/ops-commands.ts` — import `redactPath` from `../quick-ask.js`, and change the three call sites:

```ts
  // The selection's path is the REAL local path. Redact it to a basename before
  // it goes anywhere near the Gateway — the same treatment prompt.ts gives the
  // same file in a free-form turn.
  const target = arg.length > 0 ? arg : redactPath(req.selection?.path ?? "");
```

(applies in `handleBlast`; `handleOwns` gets the same treatment for `topic`). Then:

```ts
  sink.markdown(
    renderImpact(
      target,
      await client.briefs.impact({ fileOrPrUrl: target }, {
        action: "Blast radius (agents.impact)",
        files: [],
        omissions: [],
      }),
    ),
  );
```

```ts
  sink.markdown(
    renderExperts(
      topic,
      await client.briefs.expert({ topicOrFile: topic, limit: EXPERT_LIMIT }, {
        action: "Who owns this (agents.expert)",
        files: [],
        omissions: [],
      }),
    ),
  );
```

```ts
  const brief = await client.briefs.catchup(
    { sinceMs: INCIDENT_WINDOW_MS, ...(arg.length > 0 ? { service: arg } : {}) },
    { action: "Catch me up (agents.catchup)", files: [], omissions: [] },
  );
```

Keep the existing empty-string guards: `redactPath("")` returns `""`, so the "Usage: …" branches still fire.

`src/extension.ts` — replace the spread-and-cast in `participantDeps.client` (line ~1195) with an explicit object, which is what makes the new member type-check honestly:

```ts
    client: () => {
      const client = nimbus();
      if (client === undefined) return undefined;
      return {
        ...client,
        askStream: gateRawAskStream(client, egressGate, "participant", "@nimbus chat"),
        // Recorded, not prompted: a slash-command argument is text the user
        // just typed, and a modal must not interrupt a chat turn.
        briefs: gateRawParticipantBriefs(client, egressGate),
      } as unknown as ParticipantClientLike;
    },
```

with `gateRawParticipantBriefs` added to the import from `./egress/gated-client.js`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun run test && bun run typecheck`
Expected: PASS. The choke-point test is the one that matters — `ops-commands.ts` must no longer appear as an offender, and `whyPeek` must be the only entry in the unaccounted list. **Do not add `chat-participant/ops-commands.ts` to `ALLOWED`** — it now holds only an injected seam, so it needs no entry, and adding one would make the guard pass for the wrong reason.

- [ ] **Step 5: Commit**

```bash
git add src/egress/gated-client.ts src/chat-participant/ src/extension.ts test/unit/
git commit -m "feat(egress): route the participant's ops briefs through the seam"
```

---

### Task 10: Make the prose true, then run the full gate

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/ROADMAP.md`, `docs/superpowers/specs/2026-08-10-built-in-briefs-design.md`

**Interfaces:** none — documentation and verification.

**Why this is a task and not a follow-up:** PR 3 exists to make `CLAUDE.md`'s central claim true. Leaving the claim stale would defeat its purpose.

- [ ] **Step 1: Correct `CLAUDE.md`**

In the *Surface today* paragraph:
- Extend the briefs list to the six now shipped, naming `Is this idle?` and `Safe to deploy?` as palette + sidebar entries that prompt for their input.
- Delete "— the three remaining `agents*` calls in `ops-commands.ts` are still raw pending PR 3".
- Correct "the five `agentInvoke`/`askStream` paths **and** the four brief calls route through `src/egress/gated-client.ts`" to say that every agent-bound call routes through it: the five `agentInvoke`/`askStream` paths, the six prompting brief calls, and the participant's three ops briefs, which record rather than prompt. `agentsWhyPeek` is the sole exemption.

In the *Layout* section, add `namespace-store.ts` to the `src/briefs/` file list.

- [ ] **Step 2: Correct `docs/architecture.md`**

Update the `src/briefs/` row (line 92): the six briefs by name, `namespace-store.ts` in the pure-core list, and the participant's three recorded under kind `"participant"`. Keep the `agentsWhyPeek` exemption paragraph as-is — it is still accurate and still the thing the choke-point test asserts.

- [ ] **Step 3: Correct `docs/ROADMAP.md`**

Delete the Phase 2 row *The seven unreached briefs* and add to **Already shipped**:

```markdown
| **Built-in briefs** — `Why is this here?`, `Who knew this code?`, `Who else is touching this?` and blame-on-hover from the editor; `Team huddle`, `Is this idle?` and `Safe to deploy?` from the palette and the Agents view. All seven previously unreached briefs are wired; every model-composed call routes through the pre-flight gate, and `agentsWhyPeek` is the one documented exemption | `agentsWhy`, `agentsWhyPeek`, `agentsGhost`, `agentsConflicts`, `agentsHuddle`, `agentsJanitor`, `agentsPreflight` |
```

Leave the *Agents view shows the built-ins* row alone if PR 1 already moved it; otherwise move it too.

- [ ] **Step 4: Correct the parent spec**

In `docs/superpowers/specs/2026-08-10-built-in-briefs-design.md`:
- The sidebar mockup (lines ~238–253): drop the `catchup` / `expert` / `impact` rows, leaving six. Add one line noting they stayed chat-participant slash commands in PR 3 and that promoting them is deferred.
- The testing section's *"Catalog invariant — exactly one ungated entry, and it is `whyPeek`"*: replace with *"Catalog invariant — every entry is gated; `whyPeek` is a hover, not a row, and its exemption is enforced by the choke-point test."*
- The delivery table's PR 3 row: mark it delivered and note the six-row scope.

- [ ] **Step 5: Run the full gate**

Use the `verify-extension` skill. It runs, in order:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run check-bundle
bun run check-vsix-contents
bun run check-settings-docs
```

Expected: all green. Then drive an Extension Development Host and confirm by hand:
1. **Is this idle?** from the palette prompts for a resource (prefilled with the open file's relative path), then for idle days; typing `-5` shows the validation message inline.
2. **Safe to deploy?** prompts for a ref, then a namespace prefilled from the setting; Esc on the namespace prompt sends nothing and shows no error.
3. Both show the pre-flight modal naming the ref, and Cancel sends nothing.
4. A second **Safe to deploy?** in the same folder prefills the namespace just used.
5. Opening a brief's read-only result tab and running **Is this idle?** from there prefills nothing rather than `Nimbus — …md`.
6. `@nimbus /blast` in the Chat view answers with **no** modal, and `Nimbus: Show Last Outbound Payload` then shows the recorded `agents.impact` payload.

- [ ] **Step 6: Commit and open the PR**

```bash
git add CLAUDE.md docs/
git commit -m "docs: every agent call now routes through one seam"
git push -u origin feat/briefs-pr3
```

PR title (Release Please reads it — the repo squash-merges):

```
feat(briefs): reach the last two briefs, and route every agent call through one seam
```

---

## Self-Review

**Spec coverage.** Catalog + `prompted` context → T7. Parameter builders → T4. Prompts, prefill order, required namespace, `idleDays` validation → T6. `file`-scheme prefill guard → T8. Namespace memory keyed per folder → T3. Prompt-before-Retry → T6. Renderers → T1. `gateRawParticipantBriefs` + `ParticipantClientLike` + choke-point → T9. Restricted Mode / `record` assertions → T9. Setting → T2. Doc corrections → T10. Every testing bullet in the spec maps to a step above.

**Plan review dispositions** ([2026-08-11-built-in-briefs-pr3-review.md](./2026-08-11-built-in-briefs-pr3-review.md)):

- **Escape versus blank on the prompts — fixed** (Task 6). The original `ask` helper collapsed `undefined` (Escape) and `""` (Enter on a blank box) into one value. On the `idleDays` prompt those mean opposite things, so Escape would have sent a janitor brief the user was cancelling. `ask` now returns a discriminated `Answer`, and `askRequired` wraps the three prompts where dismissed and blank genuinely do mean the same thing.
- **`idleDays` needs an `undefined` branch in `renderJanitor` — declined.** The finding reads `JanitorParams.idleDays?: number`, which is the **request**. The renderer takes a `JanitorBrief`, whose `query.idleDays` is a required `number` (`brief-composites.d.ts`) — the Gateway echoes back the window it actually used, resolving its own default when none was sent. A fallback branch would be unreachable code guarding a shape the type forbids. Task 1 now states this explicitly so it is not re-introduced.
- **Normalise `root` before the `endsWith("/")` check — already done.** The finding proposes the exact two lines Task 3 already specifies. No change; noted so a reader does not go looking for a diff.
- **Forward-compatible `changedSurface` on `preflightParams` — declined (YAGNI).** No caller has a changed surface to pass: the extension has no such concept, exactly as it has no namespace concept, and a parameter builder that accepts a value nothing produces is dead surface area. It becomes worth building when a caller can genuinely supply it — the SCM diff knows which files changed, which would be a feature with its own design, not a passthrough.

**Known deviations from the spec, both deliberate:**
- The spec says renderers test against the published mock's fixtures. Only `WHY_BRIEF_FIXTURE` exists, so T1 uses typed literals in the style `briefs-render.test.ts` already established.
- T9 also redacts `req.selection?.path` in `/blast` and `/owns`. The spec does not mention it because the defect was found while writing this plan: those two paths currently send an absolute local path. It is in scope because routing them through the seam is what surfaces it, and shipping the routing while leaving the leak would be worse than either alone.
