# "Preview what leaves" pre-flight gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every agent-bound call in the extension through one seam that can render exactly what would leave — paths already redacted — and refuse to send it.

**Architecture:** Four new modules under `src/egress/`. Three are pure or vscode-free and carry all the logic (`leak-check.ts`, `preflight.ts`, `gate.ts`); `gated-client.ts` wraps the raw Nimbus client and becomes the only file in `src/` permitted to call `.agentInvoke(` or `.askStream(`. Each surface is handed a wrapper with its `EgressKind` fixed at wiring time, so a call site cannot misreport which surface it is. Two of the five kinds prompt; three route silently.

**Tech Stack:** TypeScript (strict), Vitest, Biome, esbuild, VS Code extension API via `src/vscode-shim.ts`.

**Spec:** [`docs/superpowers/specs/2026-07-30-preview-what-leaves-design.md`](../specs/2026-07-30-preview-what-leaves-design.md)

## Global Constraints

- TypeScript **strict**. **No `any`** — use `unknown` for external data. No non-null assertions (`!`).
- **Never `console`** — log through the `Logger` from `src/logging.ts`.
- All relative imports end in **`.js`** (e.g. `import { x } from "./preflight.js"`), even for `.ts` files.
- The `vscode` API is touched **only** through `src/vscode-shim.ts`, or a thin `real-*.ts` adapter listed in `vitest.config.ts`'s coverage `exclude`. Pure modules import neither.
- **Never send an absolute path** to the agent. Roots are held locally as leak-check needles only.
- Output is always a suggestion: the extension never writes to disk and never applies a `WorkspaceEdit`.
- Everything goes through the typed `@nimbus-dev/client`. **No new RPCs** in this feature, and no client bump. Never import from the Nimbus gateway.
- Biome enforces `noExplicitAny`, `noConsole` (in `src/`), `noNonNullAssertion`. Run `bun run lint` before every commit.
- Full gate before the final commit:
  `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs`

**One refinement against the spec.** The spec sketched `check(payload)`. The gate instead takes `(kind, prompt, meta)` and builds the payload itself, so `roots` is filled from one place and no call site can forget it. `EgressMeta` is therefore `{ action, files, omissions }` — `kind`, `prompt` and `roots` are all supplied by the seam.

---

### Task 1: Leak check

The zero-false-positive absolute-path detector. Pure — no imports at all.

**Files:**
- Create: `src/egress/leak-check.ts`
- Test: `test/unit/egress-leak-check.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MIN_NEEDLE_LENGTH: number`, `pathVariants(root: string): readonly string[]`, `findLeakedRoots(text: string, roots: readonly string[]): readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-leak-check.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  findLeakedRoots,
  MIN_NEEDLE_LENGTH,
  pathVariants,
} from "../../src/egress/leak-check.js";

describe("pathVariants", () => {
  test("yields both separator forms of a Windows root", () => {
    expect(pathVariants("C:\\gitrep\\nimbus")).toEqual(["C:\\gitrep\\nimbus", "C:/gitrep/nimbus"]);
  });
  test("yields both separator forms of a POSIX root", () => {
    expect(pathVariants("/home/asafg/p")).toEqual(["/home/asafg/p", "\\home\\asafg\\p"]);
  });
  test("collapses to one variant when there is no separator", () => {
    expect(pathVariants("plainword")).toEqual(["plainword"]);
  });
});

describe("findLeakedRoots", () => {
  const WIN = "C:\\gitrep\\nimbus";
  const HOME = "/home/asafg";

  test("returns nothing for a clean payload", () => {
    expect(findLeakedRoots("just a diff of a.ts", [WIN, HOME])).toEqual([]);
  });
  test("finds a root that appears verbatim", () => {
    expect(findLeakedRoots(`see ${WIN}\\src\\a.ts`, [WIN])).toEqual([WIN]);
  });
  test("finds a Windows root written with forward slashes", () => {
    expect(findLeakedRoots("see C:/gitrep/nimbus/src/a.ts", [WIN])).toEqual([WIN]);
  });
  test("matches case-insensitively, since Windows paths are", () => {
    expect(findLeakedRoots("see c:\\GITREP\\Nimbus\\a.ts", [WIN])).toEqual([WIN]);
  });
  test("reports each matching root once, in the order given", () => {
    expect(findLeakedRoots(`${WIN} and ${HOME} and ${WIN}`, [WIN, HOME])).toEqual([WIN, HOME]);
  });
  test("ignores roots shorter than the minimum needle length", () => {
    // This is why os.tmpdir() is not a needle: "/tmp" is 4 characters and
    // appears legitimately in shebangs, fixtures and docs.
    expect(MIN_NEEDLE_LENGTH).toBe(5);
    expect(findLeakedRoots("#!/bin/sh\ncd /tmp && ./run", ["/tmp"])).toEqual([]);
  });
  test("ignores empty and whitespace-only roots", () => {
    expect(findLeakedRoots("anything at all", ["", "   "])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- egress-leak-check`
Expected: FAIL — cannot resolve `../../src/egress/leak-check.js`.

- [ ] **Step 3: Write the implementation**

Create `src/egress/leak-check.ts`:

```ts
// Absolute-path leak detection for the pre-flight gate.
//
// Deliberately NOT a "looks like a path" regex. Every needle is a literal
// string we already know (a workspace root, the home directory), so a match
// is a fact rather than a guess — a regex would fire on every
// `#!/usr/bin/env` in a diff, and a gate that cries wolf trains people to
// click through it.
//
// Needles never leave the machine; they exist only to be searched for.

// Shorter needles are dropped. A root of "/" or "" would match everything,
// and this is also the structural reason os.tmpdir() is not a needle: on
// Linux it is "/tmp", four characters that appear legitimately in shebangs,
// test fixtures and documentation.
export const MIN_NEEDLE_LENGTH = 5;

// The same path can appear in one payload written both ways — a Windows tool
// prints "C:\a\b" while a script in the same diff writes "C:/a/b". Both forms
// are exact transforms of a known string, so neither weakens the guarantee.
export function pathVariants(root: string): readonly string[] {
  const forward = root.replace(/\\/g, "/");
  const back = root.replace(/\//g, "\\");
  return forward === back ? [forward] : [root, root.includes("\\") ? forward : back];
}

// The roots found verbatim in `text`, each reported once, in the order given.
// An empty result means the payload is clean.
export function findLeakedRoots(text: string, roots: readonly string[]): readonly string[] {
  const haystack = text.toLowerCase();
  const hits: string[] = [];
  for (const root of roots) {
    if (root.trim().length < MIN_NEEDLE_LENGTH) continue;
    if (hits.includes(root)) continue;
    const found = pathVariants(root).some((v) => haystack.includes(v.toLowerCase()));
    if (found) hits.push(root);
  }
  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- egress-leak-check`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/egress/leak-check.ts test/unit/egress-leak-check.test.ts
git commit -m "feat(egress): add the absolute-path leak check"
```

---

### Task 2: Payload types and the three renderers

**Files:**
- Create: `src/egress/preflight.ts`
- Test: `test/unit/egress-preflight.test.ts`

**Interfaces:**
- Consumes: `findLeakedRoots` from Task 1.
- Produces: `EgressKind`, `EgressFile`, `EgressPayload`, `EgressMeta`, `EGRESS_FILES_SHOWN`, `REDACTION_NOTE`, `LEAK_WARNING`, `egressTitle(p): string`, `summarizeEgress(p): string`, `renderFullEgress(p): string`, `confirmationMessage(p): { title: string; message: string }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-preflight.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  confirmationMessage,
  EGRESS_FILES_SHOWN,
  type EgressPayload,
  egressTitle,
  LEAK_WARNING,
  REDACTION_NOTE,
  renderFullEgress,
  summarizeEgress,
} from "../../src/egress/preflight.js";

function payload(over: Partial<EgressPayload> = {}): EgressPayload {
  return {
    kind: "scm",
    action: "Review Changes",
    prompt: "diff of a.ts",
    files: [{ name: "a.ts", note: "staged + unstaged" }],
    omissions: [],
    roots: [],
    ...over,
  };
}

describe("egressTitle", () => {
  test("names the action and asks", () => {
    expect(egressTitle(payload())).toBe("Send this to the Nimbus agent?");
  });
});

describe("summarizeEgress", () => {
  test("heads with the action, file count and grouped character count", () => {
    const s = summarizeEgress(payload({ prompt: "x".repeat(18412) }));
    expect(s.split("\n")[0]).toBe("Review Changes — 1 file, 18,412 characters");
  });
  test("omits the file count when nothing is attached", () => {
    const s = summarizeEgress(payload({ files: [], prompt: "hello" }));
    expect(s.split("\n")[0]).toBe("Review Changes — 5 characters");
  });
  test("lists each file with its note", () => {
    expect(summarizeEgress(payload())).toContain("  a.ts — staged + unstaged");
  });
  test(`shows at most ${EGRESS_FILES_SHOWN} files, then counts the rest`, () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.ts`, note: "staged" }));
    const s = summarizeEgress(payload({ files }));
    expect(s).toContain("  f0.ts — staged");
    expect(s).toContain("  f4.ts — staged");
    expect(s).not.toContain("f5.ts");
    expect(s).toContain("  … and 7 more");
  });
  test("states the redaction rule when files are attached", () => {
    expect(summarizeEgress(payload())).toContain(REDACTION_NOTE);
  });
  test("states no redaction rule when no files are attached", () => {
    expect(summarizeEgress(payload({ files: [] }))).not.toContain(REDACTION_NOTE);
  });
  test("lists omissions verbatim", () => {
    const s = summarizeEgress(payload({ omissions: ["2 files omitted (diff too large)."] }));
    expect(s).toContain("  2 files omitted (diff too large).");
  });
  test("warns when a root leaked into the prompt", () => {
    const s = summarizeEgress(payload({ prompt: "at C:\\gitrep\\nimbus\\a.ts", roots: ["C:\\gitrep\\nimbus"] }));
    expect(s).toContain(LEAK_WARNING);
  });
  test("does not warn on a clean prompt", () => {
    expect(summarizeEgress(payload({ roots: ["C:\\gitrep\\nimbus"] }))).not.toContain(LEAK_WARNING);
  });
});

describe("renderFullEgress", () => {
  test("lists every file, with no elision", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.ts`, note: "staged" }));
    const full = renderFullEgress(payload({ files }));
    expect(full).toContain("f11.ts");
    expect(full).not.toContain("… and");
  });
  test("ends with the verbatim prompt", () => {
    expect(renderFullEgress(payload({ prompt: "EXACT BYTES" }))).toContain("EXACT BYTES");
  });
});

describe("confirmationMessage", () => {
  test("asks in the title and describes the payload in the message", () => {
    const c = confirmationMessage(payload({ kind: "lmTool", action: "Ask Nimbus", prompt: "hi" }));
    expect(c.title).toBe("Send this to the Nimbus agent?");
    expect(c.message).toContain("Ask Nimbus");
    expect(c.message).toContain("2 characters");
  });
  test("carries the leak warning into the card", () => {
    const c = confirmationMessage(
      payload({ kind: "lmTool", prompt: "at /home/asafg/x", roots: ["/home/asafg"] }),
    );
    expect(c.message).toContain(LEAK_WARNING);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- egress-preflight`
Expected: FAIL — cannot resolve `../../src/egress/preflight.js`.

- [ ] **Step 3: Write the implementation**

Create `src/egress/preflight.ts`:

```ts
import { findLeakedRoots } from "./leak-check.js";

// Which surface a payload came from. Fixed per surface at wiring time so a
// call site cannot misreport itself.
export type EgressKind = "quickAsk" | "scm" | "ask" | "participant" | "lmTool";

export interface EgressFile {
  /** ALREADY redacted by the call site — a basename or repo-relative path. */
  name: string;
  /** "whole file", "selected code", "staged + unstaged" */
  note: string;
}

export interface EgressPayload {
  kind: EgressKind;
  /** Human label for the action: "Review Changes", "Quick Ask". */
  action: string;
  /** Verbatim — exactly the string that would be sent. */
  prompt: string;
  files: readonly EgressFile[];
  /** What was deliberately left out: "2 files omitted (diff too large)." */
  omissions: readonly string[];
  /** Absolute paths held LOCALLY as leak-check needles. Never sent. */
  roots: readonly string[];
}

// What a call site supplies. `kind`, `prompt` and `roots` come from the seam,
// so no call site can forget the needles or misreport its surface.
export type EgressMeta = Omit<EgressPayload, "kind" | "prompt" | "roots">;

// A modal cannot scroll, so the list elides. The full list is always one
// click away in "Show full text".
export const EGRESS_FILES_SHOWN = 5;

export const REDACTION_NOTE =
  "Paths sent as file names only — no directories, no repository path.";

export const LEAK_WARNING =
  "WARNING: this payload contains an absolute path from this machine. Nimbus does not add it — it is inside your own content.";

// Group digits without toLocaleString, whose output depends on the host
// locale and would make these strings untestable across machines.
function groupDigits(n: number): string {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function headline(p: EgressPayload): string {
  const chars = `${groupDigits(p.prompt.length)} characters`;
  if (p.files.length === 0) return `${p.action} — ${chars}`;
  const files = `${p.files.length} file${p.files.length === 1 ? "" : "s"}`;
  return `${p.action} — ${files}, ${chars}`;
}

function leaked(p: EgressPayload): boolean {
  return findLeakedRoots(p.prompt, p.roots).length > 0;
}

function footerLines(p: EgressPayload): string[] {
  const lines: string[] = [];
  if (p.files.length > 0) lines.push(`  ${REDACTION_NOTE}`);
  if (leaked(p)) lines.push(`  ${LEAK_WARNING}`);
  for (const omission of p.omissions) lines.push(`  ${omission}`);
  return lines;
}

function render(p: EgressPayload, limit: number | undefined): string {
  const shown = limit === undefined ? p.files : p.files.slice(0, limit);
  const rest = p.files.length - shown.length;
  const lines: string[] = [headline(p)];
  if (shown.length > 0) {
    lines.push("");
    for (const f of shown) lines.push(`  ${f.name} — ${f.note}`);
    if (rest > 0) lines.push(`  … and ${rest} more`);
  }
  const footer = footerLines(p);
  if (footer.length > 0) {
    lines.push("");
    lines.push(...footer);
  }
  return lines.join("\n");
}

// The modal's main message. Deliberately not action-specific: the detail
// below it already names the action, and a modal title reads better short.
export function egressTitle(_p: EgressPayload): string {
  return "Send this to the Nimbus agent?";
}

// The modal's `detail` — a summary, elided to fit without scrolling.
export function summarizeEgress(p: EgressPayload): string {
  return render(p, EGRESS_FILES_SHOWN);
}

// The read-only tab — every file, then the exact bytes that would be sent.
export function renderFullEgress(p: EgressPayload): string {
  return `${render(p, undefined)}\n\n---\n\n${p.prompt}`;
}

// The LM-tool confirmation card. Rendered inline by the calling chat, so it
// stays to a couple of sentences.
export function confirmationMessage(p: EgressPayload): { title: string; message: string } {
  const parts = [headline(p)];
  if (leaked(p)) parts.push(LEAK_WARNING);
  return { title: egressTitle(p), message: parts.join(" ") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- egress-preflight`
Expected: PASS (13 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/egress/preflight.ts test/unit/egress-preflight.test.ts
git commit -m "feat(egress): add the outbound payload model and its renderers"
```

---

### Task 3: Per-surface skip store

Mirrors `src/chat/session-store.ts` — a `MementoLike` wrapper, nothing more.

**Files:**
- Create: `src/egress/skip-store.ts`
- Test: `test/unit/egress-skip-store.test.ts`

**Interfaces:**
- Consumes: `MementoLike` from `src/vscode-shim.ts`.
- Produces: `SkippableKind = "quickAsk" | "scm"`, `PreflightSkipStore` with `isSkipped(kind): boolean`, `setSkipped(kind): Promise<void>`, `clearAll(): Promise<void>`; `createPreflightSkipStore(memento): PreflightSkipStore`

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-skip-store.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { createPreflightSkipStore } from "../../src/egress/skip-store.js";
import type { MementoLike } from "../../src/vscode-shim.js";

class FakeMemento implements MementoLike {
  readonly store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

describe("createPreflightSkipStore", () => {
  test("nothing is skipped by default", () => {
    const s = createPreflightSkipStore(new FakeMemento());
    expect(s.isSkipped("quickAsk")).toBe(false);
    expect(s.isSkipped("scm")).toBe(false);
  });

  test("skipping one surface leaves the other still gated", async () => {
    const s = createPreflightSkipStore(new FakeMemento());
    await s.setSkipped("quickAsk");
    expect(s.isSkipped("quickAsk")).toBe(true);
    expect(s.isSkipped("scm")).toBe(false);
  });

  test("clearAll resets every surface", async () => {
    const s = createPreflightSkipStore(new FakeMemento());
    await s.setSkipped("quickAsk");
    await s.setSkipped("scm");
    await s.clearAll();
    expect(s.isSkipped("quickAsk")).toBe(false);
    expect(s.isSkipped("scm")).toBe(false);
  });

  test("stores under stable, namespaced keys", async () => {
    const m = new FakeMemento();
    await createPreflightSkipStore(m).setSkipped("scm");
    expect([...m.store.keys()]).toEqual(["nimbus.preflight.skip.scm"]);
  });

  test("a non-boolean stored value does not count as skipped", () => {
    const m = new FakeMemento();
    m.store.set("nimbus.preflight.skip.scm", "yes");
    expect(createPreflightSkipStore(m).isSkipped("scm")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- egress-skip-store`
Expected: FAIL — cannot resolve `../../src/egress/skip-store.js`.

- [ ] **Step 3: Write the implementation**

Create `src/egress/skip-store.ts`:

```ts
import type { MementoLike } from "../vscode-shim.js";

// Only the two surfaces where the EXTENSION assembles context can be skipped;
// the other three never prompt, so they have nothing to suppress.
export type SkippableKind = "quickAsk" | "scm";

// Workspace-scoped by construction (the caller passes ctx.workspaceState), so
// trusting your own repo does not carry into a client repo opened next week.
const KEYS: Record<SkippableKind, string> = {
  quickAsk: "nimbus.preflight.skip.quickAsk",
  scm: "nimbus.preflight.skip.scm",
};

export interface PreflightSkipStore {
  isSkipped(kind: SkippableKind): boolean;
  setSkipped(kind: SkippableKind): Promise<void>;
  clearAll(): Promise<void>;
}

export function createPreflightSkipStore(memento: MementoLike): PreflightSkipStore {
  return {
    // Stored state is external data: only an exact `true` suppresses the gate,
    // so a corrupted or hand-edited value fails closed.
    isSkipped: (kind) => memento.get<unknown>(KEYS[kind]) === true,
    setSkipped: async (kind) => {
      await memento.update(KEYS[kind], true);
    },
    clearAll: async () => {
      for (const key of Object.values(KEYS)) await memento.update(key, undefined);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- egress-skip-store`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/egress/skip-store.ts test/unit/egress-skip-store.test.ts
git commit -m "feat(egress): add the per-surface preflight skip store"
```

---

### Task 4: Shim members and a bounded preview opener

Two small pieces of plumbing the gate needs. No new behaviour on its own.

**Files:**
- Modify: `src/vscode-shim.ts:132-135` (the `WorkspaceApi` interface)
- Modify: `test/unit/vscode-stub.ts:75-88` (the `workspace` stub)
- Modify: `src/extension.ts:1141-1172` (`createReadonlyJsonOpener`)
- Test: `test/unit/extension.test.ts` (add one case)

**Interfaces:**
- Produces: `WorkspaceApi.isTrusted: boolean`; `WorkspaceApi.workspaceFolders: readonly WorkspaceFolderLike[] | undefined` where `WorkspaceFolderLike = { uri: { fsPath: string } }`; `createReadonlyJsonOpener(ctx, maxDocs?)`.

- [ ] **Step 1: Extend `WorkspaceApi` in the shim**

In `src/vscode-shim.ts`, replace the `WorkspaceApi` interface (line 132) with:

```ts
export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface WorkspaceApi {
  getConfiguration(section: string): WorkspaceConfigSection;
  onDidChangeConfiguration(handler: (e: ConfigurationChangeEventLike) => void): DisposableLike;
  /** False in Restricted Mode — the pre-flight gate is never suppressed there. */
  isTrusted: boolean;
  /** Leak-check needles. Undefined when no folder is open (a loose file). */
  workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
}
```

- [ ] **Step 2: Extend the test stub to match**

In `test/unit/vscode-stub.ts`, inside the exported `workspace` object, replace the
`workspaceFolders` line and add `isTrusted`:

```ts
  isTrusted: true,
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
```

- [ ] **Step 3: Make the readonly opener's retention bound a parameter**

In `src/extension.ts`, change the signature and the constant (lines 1141-1148):

```ts
function createReadonlyJsonOpener(
  ctx: ExtensionContextLike,
  // Retained so the content provider can still serve a tab the user left open.
  // Callers that render large payloads (the egress preview) pass a small bound
  // — a full outbound prompt is among the biggest strings this extension
  // builds, and 50 of them would sit in memory for the whole session.
  maxDocs = 50,
): (title: string, content: string) => Promise<void> {
  const scheme = "nimbus-audit";
  const docs = new Map<string, string>();
```

Then replace the eviction loop's constant:

```ts
    while (docs.size > maxDocs) {
```

Delete the now-stale `const MAX_DOCS = 50;` line and the comment above it that
mentions it (its content has moved onto the parameter).

- [ ] **Step 4: Add the retention test**

In `test/unit/extension.test.ts`, add at the end of the file:

```ts
describe("createReadonlyJsonOpener", () => {
  test("evicts oldest documents beyond the requested bound", async () => {
    const ctx: ExtensionContextLike = { subscriptions: [], workspaceState: new FakeMemento() };
    const open = createReadonlyJsonOpener(ctx, 2);
    await open("a.md", "AAA");
    await open("b.md", "BBB");
    await open("c.md", "CCC");
    const provider = vi.mocked(vscodeWorkspace.registerTextDocumentContentProvider).mock
      .calls[0]?.[1] as { provideTextDocumentContent(uri: { path: string }): string };
    expect(provider.provideTextDocumentContent({ path: "/1/a.md" })).toBe("");
    expect(provider.provideTextDocumentContent({ path: "/3/c.md" })).toBe("CCC");
  });
});
```

Two prerequisites for that test:

1. Export `createReadonlyJsonOpener` from `src/extension.ts` (`export function
   createReadonlyJsonOpener`). `createSourceOpener` is already exported for
   exactly this reason, so this follows the existing pattern. Add it to the
   existing `import { activateWithDeps, createSourceOpener }` line.
2. Capture the provider by spying **before** the first `open` call, since the
   opener registers it lazily on first use:

```ts
const spy = vi.spyOn(vscodeWorkspace, "registerTextDocumentContentProvider");
```

Then read `spy.mock.calls[0]?.[1]` instead of `vi.mocked(...)`, and call
`spy.mockRestore()` at the end so the stub is left clean for other tests.

- [ ] **Step 5: Run the suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass. `WorkspaceApi` gaining required members will surface any
place constructing a fake `WorkspaceApi` — fix each by adding
`isTrusted: true, workspaceFolders: undefined`.

- [ ] **Step 6: Commit**

```bash
git add src/vscode-shim.ts src/extension.ts test/unit/vscode-stub.ts test/unit/extension.test.ts
git commit -m "feat(egress): expose workspace trust and folders, bound the preview opener"
```

---

### Task 5: The gate

The decision table. vscode-free — every dependency is injected structurally.

**Files:**
- Create: `src/egress/gate.ts`
- Test: `test/unit/egress-gate.test.ts`

**Interfaces:**
- Consumes: `EgressKind`, `EgressMeta`, `EgressPayload`, `egressTitle`, `summarizeEgress`, `renderFullEgress` (Task 2); `PreflightSkipStore`, `SkippableKind` (Task 3); `Logger` from `src/logging.ts`.
- Produces: `GateDecision = "send" | "cancel"`, `EgressGateDeps`, `EgressGate` with `check(kind, prompt, meta): Promise<GateDecision>`, `record(kind, prompt, meta): void`, `lastPayload(): EgressPayload | undefined`; `createEgressGate(deps): EgressGate`; `SKIP_LABEL: Record<SkippableKind, string>`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-gate.test.ts`:

```ts
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
  items: string[];
}

function harness(opts: { answers?: (string | undefined)[]; trusted?: boolean } = {}) {
  const shown: Shown[] = [];
  const opened: { title: string; content: string }[] = [];
  const logs: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const deps: EgressGateDeps = {
    window: {
      showWarningMessage: async (message: string, o?: { modal?: boolean }, ...items: string[]) => {
        shown.push({ message, modal: o?.modal === true, items });
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
    expect(h.shown.length).toBe(1);
  });
});

describe("Show full text", () => {
  test("opens the tab, then re-asks with a NON-modal notification", async () => {
    const h = harness({ answers: ["Show full text", "Send"] });
    expect(await h.gate.check("scm", "EXACT BYTES", META)).toBe("send");
    expect(h.opened.length).toBe(1);
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
    expect(h.shown.length).toBe(1);
  });

  test("offers no Always send button, which would be ignored anyway", async () => {
    const h = harness({ answers: [undefined], trusted: false });
    await h.gate.check("scm", "diff", META);
    expect(h.shown[0]?.items).toEqual(["Send", "Show full text"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- egress-gate`
Expected: FAIL — cannot resolve `../../src/egress/gate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/egress/gate.ts`:

```ts
import type { Logger } from "../logging.js";
import {
  type EgressKind,
  type EgressMeta,
  type EgressPayload,
  egressTitle,
  renderFullEgress,
  summarizeEgress,
} from "./preflight.js";
import type { PreflightSkipStore, SkippableKind } from "./skip-store.js";

export type GateDecision = "send" | "cancel";

export const SKIP_LABEL: Record<SkippableKind, string> = {
  quickAsk: "Quick Ask",
  scm: "Source Control",
};

const SEND = "Send";
const SHOW_FULL = "Show full text";
const CANCEL = "Cancel";

// Only the two surfaces where the EXTENSION assembles context prompt. Ask and
// the participant are text the user just typed; the LM tool is confirmed
// upstream by its own inline card.
function skippableKind(kind: EgressKind): SkippableKind | undefined {
  if (kind === "quickAsk" || kind === "scm") return kind;
  return undefined;
}

export interface EgressGateDeps {
  window: {
    showWarningMessage(
      msg: string,
      opts?: { modal?: boolean },
      ...items: string[]
    ): Thenable<string | undefined>;
  };
  openReadonly(title: string, content: string): Promise<void>;
  skips: PreflightSkipStore;
  /** False in Restricted Mode, where no skip is honoured. */
  isTrusted(): boolean;
  /** Leak-check needles: workspace folders + the home directory. */
  roots(): readonly string[];
  log: Logger;
}

export interface EgressGate {
  /** Prompting kinds. Awaited before anything is sent. */
  check(kind: EgressKind, prompt: string, meta: EgressMeta): Promise<GateDecision>;
  /** Pass-through kinds. Synchronous, because askStream returns its handle synchronously. */
  record(kind: EgressKind, prompt: string, meta: EgressMeta): void;
  lastPayload(): EgressPayload | undefined;
}

export function createEgressGate(deps: EgressGateDeps): EgressGate {
  // A single slot, replaced on every send — never a list. Bounded upstream by
  // the Quick Ask clamp and collectDiff's budget.
  let last: EgressPayload | undefined;

  const build = (kind: EgressKind, prompt: string, meta: EgressMeta): EgressPayload => ({
    kind,
    prompt,
    roots: deps.roots(),
    ...meta,
  });

  const remember = (payload: EgressPayload): EgressPayload => {
    last = payload;
    deps.log.debug(
      `egress: ${payload.kind} ${payload.prompt.length} chars, ${payload.files.length} file(s)`,
    );
    return payload;
  };

  // The second ask, after the full text has been opened. Deliberately NOT
  // modal: a VS Code modal blocks the whole workbench, so re-showing one over
  // the freshly opened tab would leave the user unable to scroll, search or
  // copy the very text they asked to see. The gate is the await, not the
  // dialog — nothing is sent until this resolves.
  const askAfterFullText = async (payload: EgressPayload): Promise<GateDecision> => {
    await deps.openReadonly(`Nimbus outbound — ${payload.action}.md`, renderFullEgress(payload));
    const answer = await deps.window.showWarningMessage(
      `Send ${payload.action} to the Nimbus agent? (${payload.prompt.length} characters)`,
      {},
      SEND,
      CANCEL,
    );
    return answer === SEND ? "send" : "cancel";
  };

  return {
    lastPayload: () => last,

    record: (kind, prompt, meta) => {
      remember(build(kind, prompt, meta));
    },

    check: async (kind, prompt, meta) => {
      const payload = remember(build(kind, prompt, meta));
      const skippable = skippableKind(kind);
      if (skippable === undefined) return "send";

      // Restricted Mode is exactly when the gate is wanted, so a stored skip
      // is ignored there — and the button that would set one is not offered.
      const trusted = deps.isTrusted();
      if (trusted && deps.skips.isSkipped(skippable)) return "send";

      const always = `Always send ${SKIP_LABEL[skippable]} here`;
      const items = trusted ? [SEND, SHOW_FULL, always] : [SEND, SHOW_FULL];
      // VS Code adds Cancel to a modal automatically, so it is not an item.
      const answer = await deps.window.showWarningMessage(
        egressTitle(payload),
        { modal: true, detail: summarizeEgress(payload) },
        ...items,
      );

      if (answer === SEND) return "send";
      if (answer === always) {
        await deps.skips.setSkipped(skippable);
        return "send";
      }
      if (answer === SHOW_FULL) return askAfterFullText(payload);
      // Cancel, Esc, or dismissed. The gate fails closed on every ambiguous
      // outcome.
      return "cancel";
    },
  };
}
```

Note the `detail` property passed to `showWarningMessage`. Extend the shim's
three message signatures (`src/vscode-shim.ts:90-104`) to accept it:

```ts
  showWarningMessage(
    msg: string,
    opts?: { modal?: boolean; detail?: string },
    ...items: string[]
  ): Thenable<string | undefined>;
```

Apply the same `detail?: string` addition to `showInformationMessage` and
`showErrorMessage` so the three stay uniform.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- egress-gate`
Expected: PASS (13 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/egress/gate.ts src/vscode-shim.ts test/unit/egress-gate.test.ts
git commit -m "feat(egress): add the pre-flight gate decision table"
```

---

### Task 6: The gated client

The choke point itself, and the only module allowed to call the raw client.

**Files:**
- Create: `src/egress/gated-client.ts`
- Test: `test/unit/egress-gated-client.test.ts`

**Interfaces:**
- Consumes: `EgressGate` (Task 5); `EgressKind`, `EgressMeta` (Task 2).
- Produces: `EgressCancelled` (class), `isEgressCancelled(e): boolean`, `GatedAgentInvoke`, `gateAgentInvoke(raw, gate, kind): GatedAgentInvoke`, `gateAskStream(raw, gate, kind, action): typeof raw`

- [ ] **Step 1: Write the failing test**

Create `test/unit/egress-gated-client.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { EgressGate, GateDecision } from "../../src/egress/gate.js";
import {
  EgressCancelled,
  gateAgentInvoke,
  gateAskStream,
  isEgressCancelled,
} from "../../src/egress/gated-client.js";
import type { EgressMeta, EgressPayload } from "../../src/egress/preflight.js";

function fakeGate(decision: GateDecision): EgressGate & { recorded: EgressPayload[] } {
  const recorded: EgressPayload[] = [];
  const build = (kind: EgressPayload["kind"], prompt: string, meta: EgressMeta): EgressPayload => ({
    kind,
    prompt,
    roots: [],
    ...meta,
  });
  return {
    recorded,
    check: async (kind, prompt, meta) => {
      recorded.push(build(kind, prompt, meta));
      return decision;
    },
    record: (kind, prompt, meta) => {
      recorded.push(build(kind, prompt, meta));
    },
    lastPayload: () => recorded.at(-1),
  };
}

const META: EgressMeta = { action: "Review Changes", files: [], omissions: [] };

describe("gateAgentInvoke", () => {
  test("forwards input and options when the gate says send", async () => {
    const seen: unknown[] = [];
    const raw = async (input: string, opts: unknown) => {
      seen.push([input, opts]);
      return { reply: "ok" };
    };
    const invoke = gateAgentInvoke(raw, fakeGate("send"), "scm");
    expect(await invoke("diff", { stream: false, agent: "a" }, META)).toEqual({ reply: "ok" });
    expect(seen).toEqual([["diff", { stream: false, agent: "a" }]]);
  });

  test("never calls the raw client when the gate cancels", async () => {
    let called = false;
    const raw = async () => {
      called = true;
      return {};
    };
    const invoke = gateAgentInvoke(raw, fakeGate("cancel"), "scm");
    await expect(invoke("diff", { stream: false }, META)).rejects.toBeInstanceOf(EgressCancelled);
    expect(called).toBe(false);
  });

  test("its rejection is recognisable, so callers stay silent instead of erroring", async () => {
    const invoke = gateAgentInvoke(async () => ({}), fakeGate("cancel"), "quickAsk");
    try {
      await invoke("q", { stream: false }, META);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isEgressCancelled(e)).toBe(true);
    }
  });

  test("isEgressCancelled rejects unrelated errors", () => {
    expect(isEgressCancelled(new Error("socket closed"))).toBe(false);
    expect(isEgressCancelled("nope")).toBe(false);
  });

  test("passes the fixed kind through, not one the call site chose", async () => {
    const gate = fakeGate("send");
    await gateAgentInvoke(async () => ({}), gate, "quickAsk")("q", { stream: false }, META);
    expect(gate.recorded[0]?.kind).toBe("quickAsk");
  });
});

describe("gateAskStream", () => {
  test("records and returns the handle synchronously", () => {
    const handle = { streamId: "s1" };
    const gate = fakeGate("send");
    const askStream = gateAskStream(() => handle, gate, "ask", "Ask");
    // Not awaited: askStream's contract is a synchronous return.
    expect(askStream("hello", { sessionId: "x" })).toBe(handle);
    expect(gate.recorded[0]?.kind).toBe("ask");
    expect(gate.recorded[0]?.prompt).toBe("hello");
  });

  test("forwards the options object untouched", () => {
    const seen: unknown[] = [];
    const opts = { sessionId: "x" };
    const askStream = gateAskStream(
      (input: string, o?: unknown) => {
        seen.push([input, o]);
        return {};
      },
      fakeGate("send"),
      "participant",
      "Chat",
    );
    askStream("hi", opts);
    expect(seen).toEqual([["hi", opts]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- egress-gated-client`
Expected: FAIL — cannot resolve `../../src/egress/gated-client.js`.

- [ ] **Step 3: Write the implementation**

Create `src/egress/gated-client.ts`:

```ts
import type { EgressGate } from "./gate.js";
import type { EgressKind, EgressMeta } from "./preflight.js";

// THE CHOKE POINT.
//
// This is the only module in src/ permitted to call `.agentInvoke(` or
// `.askStream(` on a Nimbus client; test/unit/egress-choke-point.test.ts
// enforces that. Everything else receives a wrapper from here, with its
// EgressKind fixed at wiring time.

// Thrown instead of returned because the SCM helper already treats an
// `undefined` reply as "the agent returned no reply" — a cancelled send would
// otherwise show the wrong message. A distinguishable error keeps every call
// site's signature unchanged.
export class EgressCancelled extends Error {
  constructor() {
    super("Nimbus: send cancelled at the pre-flight preview.");
    this.name = "EgressCancelled";
  }
}

export function isEgressCancelled(e: unknown): boolean {
  return e instanceof EgressCancelled;
}

export interface GatedAgentInvoke<R> {
  (input: string, opts: { stream: boolean; agent?: string }, meta: EgressMeta): Promise<R>;
}

// The required third argument is the type-level half of the guardrail: the raw
// NimbusClient no longer satisfies ScmClientLike or LmToolsClientLike
// structurally, so the ungated client cannot be wired in by accident.
export function gateAgentInvoke<R>(
  raw: (input: string, opts: { stream: boolean; agent?: string }) => Promise<R>,
  gate: EgressGate,
  kind: EgressKind,
): GatedAgentInvoke<R> {
  return async (input, opts, meta) => {
    if ((await gate.check(kind, input, meta)) === "cancel") throw new EgressCancelled();
    return raw(input, opts);
  };
}

// askStream returns its handle synchronously, so this records rather than
// awaits. That is sound because the two askStream surfaces are pass-through by
// design: the text is what the user just typed.
export function gateAskStream<H, O>(
  raw: (input: string, opts?: O) => H,
  gate: EgressGate,
  kind: EgressKind,
  action: string,
): (input: string, opts?: O) => H {
  return (input, opts) => {
    gate.record(kind, input, { action, files: [], omissions: [] });
    return raw(input, opts);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- egress-gated-client`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/egress/gated-client.ts test/unit/egress-gated-client.test.ts
git commit -m "feat(egress): add the gated client choke point"
```

---

### Task 7: Build the gate and register its two commands

Built here, before the wiring tasks, because Tasks 8-11 all consume it.
It must be constructed **after** `openReadonlyJson` is resolved
(`src/extension.ts:522`), not next to `createSessionStore` — the gate needs
that opener.

**Files:**
- Modify: `src/extension.ts` (gate construction just after the opener block at `:522-538`, plus two `register(...)` calls)
- Modify: `package.json` (`contributes.commands`)
- Test: `test/unit/extension.test.ts`, `test/unit/manifest-capabilities.test.ts`

**Interfaces:**
- Consumes: `createEgressGate` (Task 5), `createPreflightSkipStore` (Task 3), `renderFullEgress` (Task 2).
- Produces: `egressGate` and `egressRoots` in `activateWithDeps`'s scope, consumed by Tasks 8-11.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/extension.test.ts`:

```ts
test("registers the two pre-flight commands", async () => {
  const h = await activateHarness({});
  expect(h.commandHandlers.has("nimbus.showLastOutbound")).toBe(true);
  expect(h.commandHandlers.has("nimbus.resetPreflightPrompts")).toBe(true);
});

test("showLastOutbound says so plainly when nothing has been sent", async () => {
  const h = await activateHarness({});
  await h.commandHandlers.get("nimbus.showLastOutbound")?.();
  expect(h.infoMessages.join(" ")).toContain("nothing");
  expect(h.readonlyOpened).toEqual([]);
});
```

Add to the manifest test file:

```ts
test("the pre-flight commands are declared with the Nimbus category", () => {
  const declared = manifest.contributes.commands as { command: string; category?: string }[];
  for (const id of ["nimbus.showLastOutbound", "nimbus.resetPreflightPrompts"]) {
    const entry = declared.find((c) => c.command === id);
    expect(entry, `${id} must be declared in contributes.commands`).toBeDefined();
    expect(entry?.category).toBe("Nimbus");
  }
});
```

Follow the file's existing way of loading `package.json` rather than adding a
new one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- extension manifest`
Expected: FAIL — commands not registered, not declared.

- [ ] **Step 3: Build the gate in `activateWithDeps`**

In `src/extension.ts`, near `const sessionStore = createSessionStore(ctx.workspaceState);`
(line 126), add:

```ts
  // Leak-check needles, resolved fresh each time so opening a folder mid-
  // session is picked up. They are held locally and never sent.
  const egressRoots = (): readonly string[] => {
    const folders = deps.workspace.workspaceFolders ?? [];
    return [...folders.map((f) => f.uri.fsPath), homedir()];
  };
  const egressGate = createEgressGate({
    window: deps.window,
    // A small retention bound: a full outbound prompt is among the largest
    // strings this extension builds, and the shared opener keeps 50.
    openReadonly: deps.openReadonlyJson ?? createReadonlyJsonOpener(ctx, 5),
    skips: createPreflightSkipStore(ctx.workspaceState),
    isTrusted: () => deps.workspace.isTrusted,
    roots: egressRoots,
    log,
  });
```

Add the imports:

```ts
import { homedir } from "node:os";

import { createEgressGate } from "./egress/gate.js";
import { renderFullEgress } from "./egress/preflight.js";
import { createPreflightSkipStore } from "./egress/skip-store.js";
```

- [ ] **Step 4: Register the two commands**

In `src/extension.ts`, alongside the other `register(...)` calls:

```ts
  register("nimbus.showLastOutbound", async () => {
    const payload = egressGate.lastPayload();
    if (payload === undefined) {
      void deps.window.showInformationMessage(
        "Nimbus: nothing has been sent to the agent in this window yet.",
        {},
      );
      return;
    }
    await openReadonlyJson("Nimbus outbound.md", renderFullEgress(payload));
  });

  register("nimbus.resetPreflightPrompts", async () => {
    await createPreflightSkipStore(ctx.workspaceState).clearAll();
    void deps.window.showInformationMessage(
      "Nimbus: the send preview will be shown again in this workspace.",
      {},
    );
  });
```

- [ ] **Step 5: Declare them in `package.json`**

In `contributes.commands`, after the `nimbus.quickAsk` entry:

```json
      {
        "command": "nimbus.showLastOutbound",
        "title": "Show Last Outbound Payload",
        "category": "Nimbus"
      },
      {
        "command": "nimbus.resetPreflightPrompts",
        "title": "Reset Egress Preview Prompts",
        "category": "Nimbus"
      },
```

- [ ] **Step 6: Run the tests**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts package.json test/unit/extension.test.ts test/unit/manifest-capabilities.test.ts
git commit -m "feat(egress): build the gate and register its two commands"
```


---

### Task 8: Wire the SCM trio

Four commands, one shared `invoke` helper — so all four are covered at once.

**Files:**
- Modify: `src/scm/commands.ts:37-44` (`ScmClientLike`), `:252-270` (`invoke`), `:241-250` (`contain`), and the four `invoke(` call sites at `:351`, `:412`, `:442`, `:462`
- Modify: `src/extension.ts:540-560` (the `createScmCommands` wiring)
- Test: `test/unit/scm-commands.test.ts`

**Interfaces:**
- Consumes: `gateAgentInvoke`, `isEgressCancelled` (Task 6); `EgressMeta`, `EgressFile` (Task 2).
- Produces: `collectedToFiles(collected): readonly EgressFile[]`, `collectedToOmissions(collected): readonly string[]` exported from `src/scm/commands.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/scm-commands.test.ts`:

```ts
import { collectedToFiles, collectedToOmissions } from "../../src/scm/commands.js";

describe("collectedToFiles", () => {
  test("names every reviewed file with the scope note", () => {
    expect(
      collectedToFiles(
        { block: "", reviewed: ["a.ts", "b.ts"], omittedTooLarge: [], skippedSecret: [], nonTextual: [], empty: false },
        "staged + unstaged",
      ),
    ).toEqual([
      { name: "a.ts", note: "staged + unstaged" },
      { name: "b.ts", note: "staged + unstaged" },
    ]);
  });
});

describe("collectedToOmissions", () => {
  test("reports what was left out, so 'what leaves' is not an understatement", () => {
    expect(
      collectedToOmissions({
        block: "",
        reviewed: ["a.ts"],
        omittedTooLarge: ["big.ts", "huge.ts"],
        skippedSecret: [".env"],
        nonTextual: ["logo.png"],
        empty: false,
      }),
    ).toEqual([
      "2 files omitted (diff too large).",
      "1 possible secret file skipped.",
      "1 binary or non-textual file not sent.",
    ]);
  });

  test("says nothing when nothing was left out", () => {
    expect(
      collectedToOmissions({ block: "", reviewed: ["a.ts"], omittedTooLarge: [], skippedSecret: [], nonTextual: [], empty: false }),
    ).toEqual([]);
  });
});
```

Then add a cancellation test alongside the existing `generateCommitMessage`
cases. **Read the top of `test/unit/scm-commands.test.ts` first** — it already
has a helper that builds a fake `ScmCommandDeps` (fake git repo, fake client,
captured window messages). Reuse it rather than writing a second one; the only
new thing this test needs is a client whose `agentInvoke` rejects with
`EgressCancelled`. Sketch, to be adapted to that helper's actual name and
shape:

```ts
test("a cancelled pre-flight leaves the input box untouched and shows no error", async () => {
  const h = harness({
    // Whatever this file's helper is for a client whose agentInvoke rejects:
    agentInvoke: async () => {
      throw new EgressCancelled();
    },
  });
  await h.commands.generateCommitMessage();
  expect(h.repo.inputBox.value).toBe("");
  expect(h.errors).toEqual([]);
});
```

Import `EgressCancelled` from `../../src/egress/gated-client.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- scm-commands`
Expected: FAIL — `collectedToFiles` is not exported; the cancel test reports an
error message that should not be there.

- [ ] **Step 3: Change `ScmClientLike` to require meta**

In `src/scm/commands.ts`, replace the `agentInvoke` member (line 38):

```ts
export interface ScmClientLike {
  // The third argument is the guardrail: the raw NimbusClient does not satisfy
  // this shape, so only a wrapper from src/egress/gated-client.ts fits here.
  agentInvoke(
    input: string,
    opts: { stream: boolean; agent?: string },
    meta: EgressMeta,
  ): Promise<unknown>;
```

Add the import at the top of the file:

```ts
import type { EgressFile, EgressMeta } from "../egress/preflight.js";
```

- [ ] **Step 4: Add the two mappers**

In `src/scm/commands.ts`, next to `warnOmissions`, add:

```ts
// A CollectedDiff, projected onto the pre-flight manifest. Paths here are
// already redacted — collectDiff produces them through relativeOrBasename.
export function collectedToFiles(collected: CollectedDiff, note: string): readonly EgressFile[] {
  return collected.reviewed.map((name) => ({ name, note }));
}

// "What leaves" is incomplete without "and what didn't". These mirror the
// toasts warnOmissions already raises, phrased for a manifest rather than a
// notification.
export function collectedToOmissions(collected: CollectedDiff): readonly string[] {
  const out: string[] = [];
  const plural = (n: number): string => (n === 1 ? "" : "s");
  if (collected.omittedTooLarge.length > 0) {
    out.push(`${collected.omittedTooLarge.length} file${plural(collected.omittedTooLarge.length)} omitted (diff too large).`);
  }
  if (collected.skippedSecret.length > 0) {
    out.push(`${collected.skippedSecret.length} possible secret file${plural(collected.skippedSecret.length)} skipped.`);
  }
  if (collected.nonTextual.length > 0) {
    out.push(`${collected.nonTextual.length} binary or non-textual file${plural(collected.nonTextual.length)} not sent.`);
  }
  return out;
}
```

- [ ] **Step 5: Thread meta through `invoke`**

In `src/scm/commands.ts`, change the `invoke` helper (line 252):

```ts
  const invoke = async (
    client: ScmClientLike,
    prompt: string,
    title: string,
    meta: EgressMeta,
  ): Promise<string | undefined> => {
    const agent = deps.agent();
    const options: { stream: boolean; agent?: string } = { stream: false };
    if (agent.length > 0) options.agent = agent;
    deps.log.debug(`scm: sending ${prompt.length} chars to agentInvoke`);
    const result = await deps.window.withProgress(
      { location: PROGRESS_LOCATION_NOTIFICATION, title },
      () => client.agentInvoke(prompt, options, meta),
    );
```

Leave the rest of the body unchanged.

- [ ] **Step 6: Supply meta at each of the four call sites**

`generateCommitMessage` (line 351):

```ts
      const reply = await invoke(client, prompt, "Nimbus: drafting commit message…", {
        action: "Generate Commit Message",
        files: collectedToFiles(collected, "staged"),
        omissions: collectedToOmissions(collected),
      });
```

`reviewChanges` (line 412):

```ts
      const reply = await invoke(
        client,
        buildReviewPrompt(collected.block),
        "Nimbus: reviewing changes…",
        {
          action: "Review Changes",
          files: collectedToFiles(collected, "staged + unstaged"),
          omissions: collectedToOmissions(collected),
        },
      );
```

`generateTests` (line 442) — this one has an editor context, not a diff:

```ts
      const reply = await invoke(client, prompt, "Nimbus: generating tests…", {
        action: "Generate Tests",
        files: [
          {
            name: redactPath(ctx.fileName),
            note: ctx.hasSelection ? "selected code" : "whole file",
          },
        ],
        omissions: ctx.truncated
          ? [`Context truncated at ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`]
          : [],
      });
```

`generateDocstrings` (line 462) — identical but for the action:

```ts
      const reply = await invoke(client, prompt, "Nimbus: generating docstrings…", {
        action: "Generate Docstrings",
        files: [
          {
            name: redactPath(ctx.fileName),
            note: ctx.hasSelection ? "selected code" : "whole file",
          },
        ],
        omissions: ctx.truncated
          ? [`Context truncated at ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`]
          : [],
      });
```

- [ ] **Step 7: Make a cancelled send silent**

In `src/scm/commands.ts`, change `contain` (line 241) so a cancellation is not
reported as a failure:

```ts
  const contain =
    (internalName: string, humanName: string, body: () => Promise<void>) =>
    async (): Promise<void> => {
      try {
        await body();
      } catch (e) {
        // Cancelling at the pre-flight preview is a normal outcome, not a
        // failure — stay silent, exactly as dismissing a Quick Pick does.
        if (isEgressCancelled(e)) {
          deps.log.debug(`nimbus.${internalName} cancelled at the pre-flight preview`);
          return;
        }
        deps.log.error(`nimbus.${internalName} failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus ${humanName} failed: ${errMsg(e)}`);
      }
    };
```

Add to the imports:

```ts
import { isEgressCancelled } from "../egress/gated-client.js";
```

- [ ] **Step 8: Wire the gated client in `extension.ts`**

In `src/extension.ts`, replace the `client` dep passed to `createScmCommands`
(line 542):

```ts
    client: () => {
      const client = nimbus();
      return client === undefined
        ? undefined
        : {
            agentInvoke: gateAgentInvoke((i, o) => client.agentInvoke(i, o), egressGate, "scm"),
            egressProveWindow: (p) => client.egressProveWindow(p),
          };
    },
```

`egressGate` was created in Task 7 and is in scope here.

- [ ] **Step 9: Run the tests**

Run: `bun run test -- scm-commands && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/scm/commands.ts src/extension.ts test/unit/scm-commands.test.ts
git commit -m "feat(scm): route the dev-workflow trio through the pre-flight gate"
```

---

### Task 9: Wire Quick Ask

**Files:**
- Modify: `src/extension.ts:791-815` (the `nimbus.quickAsk` handler)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `gateAgentInvoke`, `isEgressCancelled` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/extension.test.ts`, following the file's existing pattern for
invoking a captured command handler:

```ts
test("quick ask cancelled at the pre-flight preview shows no error", async () => {
  const h = await activateHarness({
    // A client whose agentInvoke would succeed — the gate must stop it first.
    client: makeFakeClient({ agentInvoke: async () => ({ reply: "should not appear" }) }),
    // The stub answers every modal with undefined = dismissed = cancel.
    showWarningMessage: async () => undefined,
  });
  await h.commandHandlers.get("nimbus.quickAsk")?.();
  expect(h.errorMessages).toEqual([]);
  expect(h.readonlyOpened).toEqual([]);
});
```

**Read `test/unit/extension.test.ts` first.** It already has a `Captured`
interface and a `makeFakeClient` helper (around lines 38-60) plus a function
that calls `activateWithDeps` and captures the registered command handlers.
Reuse them; `activateHarness` above is a placeholder for whatever that function
is actually called. Two invariants matter regardless of shape: a dismissed
modal produces **no error toast** and **no reply tab**.

The stub's `showWarningMessage` returns `undefined`, which the gate reads as a
dismissal, so the default stub already exercises the cancel path — you only
need to override it when a test wants a different button pressed.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- extension`
Expected: FAIL — the reply tab opens, because nothing gates the send yet.

- [ ] **Step 3: Route the call through the gate**

In `src/extension.ts`, replace the `try` block of the `nimbus.quickAsk` handler
(line 801):

```ts
    try {
      const invoke = gateAgentInvoke((i, o) => client.agentInvoke(i, o), egressGate, "quickAsk");
      const result = await deps.window.withProgress(
        { location: PROGRESS_LOCATION_NOTIFICATION, title: "Nimbus: asking…" },
        () =>
          invoke(prompt, options, {
            action: "Quick Ask",
            files: [
              {
                name: redactPath(editor.document.fileName),
                note: hasSelection ? "selected code" : "whole file",
              },
            ],
            omissions: truncated
              ? [`Context truncated at ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`]
              : [],
          }),
      );
      const reply = extractReply(result);
      if (reply === undefined) {
        void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
        return;
      }
      await openReadonlyJson("Nimbus reply.md", reply);
    } catch (e) {
      // Cancelling at the preview is a normal outcome, like dismissing the
      // Quick Pick above — say nothing.
      if (isEgressCancelled(e)) {
        log.debug("nimbus.quickAsk cancelled at the pre-flight preview");
        return;
      }
      log.error(`nimbus.quickAsk failed: ${errMsg(e)}`);
      void deps.window.showErrorMessage(`Nimbus quick ask failed: ${errMsg(e)}`);
    }
```

The gate now runs inside `withProgress`. That is intentional: the progress
notification's title only appears once the send is under way, and the modal
resolves before `agentInvoke` is reached.

Add the imports:

```ts
import { gateAgentInvoke, isEgressCancelled } from "./egress/gated-client.js";
```

- [ ] **Step 4: Run the test**

Run: `bun run test -- extension`
Expected: PASS.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts test/unit/extension.test.ts
git commit -m "feat(quick-ask): route Quick Ask through the pre-flight gate"
```

---

### Task 10: Route the two pass-through surfaces

No call-site change — the injected client is swapped for a wrapper.

**Files:**
- Modify: `src/extension.ts` (the chat-controller and participant deps wiring)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `gateAskStream` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/extension.test.ts`:

```ts
test("an Ask-panel send is recorded by the gate without prompting", async () => {
  const shown: string[] = [];
  const h = await activateHarness({
    showWarningMessage: async (m: string) => {
      shown.push(m);
      return undefined;
    },
  });
  await h.commandHandlers.get("nimbus.ask")?.();
  // The user typed it, so nothing is asked — but it still routed through the
  // seam, which is what "no call site bypasses the gate" means.
  expect(shown).toEqual([]);
  await h.commandHandlers.get("nimbus.showLastOutbound")?.();
  expect(h.readonlyOpened.at(-1)?.content).toContain("Ask");
});
```

`nimbus.showLastOutbound` was registered in Task 7, so this test can run as
written.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- extension`
Expected: FAIL — `nimbus.showLastOutbound` is not registered.

- [ ] **Step 3: Wrap the chat controller's client**

In `src/extension.ts`, find where the chat controller's deps are built (the
object passed to `createChatController`, whose `client` member carries
`askStream`). Wrap that member:

```ts
      client: {
        ...client,
        askStream: gateAskStream(
          (i, o) => client.askStream(i, o),
          egressGate,
          "ask",
          "Ask panel",
        ),
      },
```

- [ ] **Step 4: Wrap the participant's client**

In `src/extension.ts`, the `ParticipantDeps.client()` factory returns the client
used at `participant.ts:221`. Wrap it the same way:

```ts
    client: () => {
      const client = nimbus();
      return client === undefined
        ? undefined
        : {
            ...client,
            askStream: gateAskStream(
              (i, o) => client.askStream(i, o),
              egressGate,
              "participant",
              "@nimbus chat",
            ),
          };
    },
```

Keep every other member of the returned object exactly as it is today —
`searchRanked`, `egressHead` and the ops RPCs all still come straight from the
client.

Add the import:

```ts
import { gateAskStream } from "./egress/gated-client.js";
```

- [ ] **Step 5: Run the tests**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts test/unit/extension.test.ts
git commit -m "feat(egress): route the Ask panel and participant through the seam"
```

---

### Task 11: LM tools confirmation card

**Files:**
- Modify: `src/lm-tools/lm-tools.ts:6-12` (`LmToolsClientLike`), `:65-81` (`runNimbusAskTool`)
- Modify: `src/lm-tools/real-lm-tools.ts:20-22` (add `prepareInvocation`)
- Modify: `src/extension.ts` (the `LmToolsDeps.client()` factory)
- Test: `test/unit/lm-tools.test.ts`

**Interfaces:**
- Consumes: `confirmationMessage` (Task 2); `gateAgentInvoke` (Task 6).
- Produces: `buildAskConfirmation(deps, input): { title: string; message: string } | undefined` exported from `src/lm-tools/lm-tools.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/lm-tools.test.ts`:

```ts
import { buildAskConfirmation } from "../../src/lm-tools/lm-tools.js";

describe("buildAskConfirmation", () => {
  test("describes the question the calling model wants to send", () => {
    const c = buildAskConfirmation({ roots: () => [] }, { question: "why is p99 up?" });
    expect(c?.title).toBe("Send this to the Nimbus agent?");
    expect(c?.message).toContain("Ask Nimbus");
    expect(c?.message).toContain("14 characters");
  });

  test("warns when the calling model quoted an absolute path", () => {
    // The question on this path is written by ANOTHER model, which may well
    // quote a path it read from disk — so the leak check runs here too.
    const c = buildAskConfirmation(
      { roots: () => ["/home/asafg"] },
      { question: "look at /home/asafg/svc/main.go" },
    );
    expect(c?.message).toContain("WARNING");
  });

  test("returns undefined for invalid input, leaving the handler to explain", () => {
    expect(buildAskConfirmation({ roots: () => [] }, { question: "  " })).toBeUndefined();
    expect(buildAskConfirmation({ roots: () => [] }, null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- lm-tools`
Expected: FAIL — `buildAskConfirmation` is not exported.

- [ ] **Step 3: Add the pure confirmation builder**

In `src/lm-tools/lm-tools.ts`, add near the top (after `stringField`):

```ts
import { confirmationMessage } from "../egress/preflight.js";

// Built for prepareInvocation, so the leak check runs BEFORE the calling chat
// asks the user. The question text on this path comes from another model,
// which may quote an absolute path it read from disk.
export function buildAskConfirmation(
  deps: { roots(): readonly string[] },
  input: unknown,
): { title: string; message: string } | undefined {
  const question = stringField(input, "question");
  if (question === undefined) return undefined;
  return confirmationMessage({
    kind: "lmTool",
    action: "Ask Nimbus",
    prompt: question,
    files: [],
    omissions: [],
    roots: deps.roots(),
  });
}
```

Add `roots(): readonly string[];` to `LmToolsDeps`, and change
`LmToolsClientLike.agentInvoke` to require meta:

```ts
export interface LmToolsClientLike {
  searchRanked(params: { name: string; limit?: number }): Promise<unknown[]>;
  agentInvoke(
    input: string,
    options: { stream?: boolean; agent?: string },
    meta: EgressMeta,
  ): Promise<{ reply?: string } & Record<string, unknown>>;
}
```

Update the call in `runNimbusAskTool`:

```ts
    const result = await client.agentInvoke(
      question,
      { stream: false, ...(agent.length > 0 ? { agent } : {}) },
      { action: "Ask Nimbus", files: [], omissions: [] },
    );
```

Import `EgressMeta` as a type from `../egress/preflight.js`.

- [ ] **Step 4: Add `prepareInvocation` to the real adapter**

In `src/lm-tools/real-lm-tools.ts`, replace the `ask` registration:

```ts
  const ask = vscode.lm.registerTool("nimbus_ask", {
    // The inline Continue/Cancel card in the CALLING chat — no modal, no focus
    // steal, and VS Code remembers the choice for the session. The message is
    // ours, built by the same renderer the Nimbus-owned surfaces use.
    prepareInvocation: (options) => {
      const messages = buildAskConfirmation(opts.deps, options.input);
      return messages === undefined
        ? { invocationMessage: "Asking Nimbus…" }
        : { invocationMessage: "Asking Nimbus…", confirmationMessages: messages };
    },
    invoke: async (options) => asToolResult(await runNimbusAskTool(opts.deps, options.input)),
  });
```

Add `buildAskConfirmation` to the import from `./lm-tools.js`.

- [ ] **Step 5: Wire the gated client and roots in `extension.ts`**

Find the `LmToolsDeps` object passed to `registerNimbusLmTools` and change its
`client` factory, adding `roots`:

```ts
      client: () => {
        const client = nimbus();
        return client === undefined
          ? undefined
          : {
              searchRanked: (p) => client.searchRanked(p),
              agentInvoke: gateAgentInvoke(
                (i, o) => client.agentInvoke(i, o),
                egressGate,
                "lmTool",
              ),
            };
      },
      roots: egressRoots,
```

`egressRoots` was defined in Task 7.

- [ ] **Step 6: Run the tests**

Run: `bun run test -- lm-tools && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lm-tools/lm-tools.ts src/lm-tools/real-lm-tools.ts src/extension.ts test/unit/lm-tools.test.ts
git commit -m "feat(lm-tools): confirm and leak-check nimbus_ask before it sends"
```

---

### Task 12: The choke-point guard

Lands last, because it fails by definition until every path is migrated. That
makes it a real completion signal rather than a formality.

**Files:**
- Create: `test/unit/egress-choke-point.test.ts`

**Interfaces:**
- Consumes: the finished state of `src/` after Tasks 7-11.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `test/unit/egress-choke-point.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The trio review found that nothing asserted "nothing absolute crosses into
// agentInvoke" beyond four call sites each doing the right thing. This is the
// assertion. Every agent-bound call goes through src/egress/gated-client.ts,
// which is the only file allowed to reach the raw client.
//
// Guard the CALL shape (a leading dot), not the bare identifier, so interface
// declarations like `agentInvoke(input: string, ...)` do not false-positive.
// Same trick as no-raw-sql-guard.test.ts.

const ALLOWED = ["gated-client.ts"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("agent-bound calls have exactly one choke point", () => {
  for (const call of [".agentInvoke(", ".askStream("]) {
    test(`${call} appears only in ${ALLOWED.join(", ")}`, () => {
      const offenders = listTsFiles(join(__dirname, "..", "..", "src"))
        .filter((f) => readFileSync(f, "utf8").includes(call))
        .filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
        .map((f) => f.replace(join(__dirname, "..", ".."), ""));
      expect(offenders).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `bun run test -- egress-choke-point`
Expected: PASS. If it fails, the listed files still reach the raw client — route
each through `gateAgentInvoke` / `gateAskStream` rather than widening `ALLOWED`.
Widening the allowlist defeats the entire purpose of this task.

- [ ] **Step 3: Commit**

```bash
git add test/unit/egress-choke-point.test.ts
git commit -m "test(egress): assert the gated client is the only choke point"
```

---

### Task 13: Documentation and the full gate

**Files:**
- Modify: `docs/architecture.md`, `docs/ROADMAP.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Document the seam in `docs/architecture.md`**

Add a section describing `src/egress/`: the five kinds, which two prompt, the
two guardrail mechanisms (the required `meta` argument and the choke-point
test), and that the feature makes no RPCs.

- [ ] **Step 2: Update `docs/ROADMAP.md`**

Move the "Preview what leaves" pre-flight row (line 93) into **Already shipped**,
and correct its enabling-RPC column from `local + egressList` to **none** — a
pre-flight view describes a payload the extension already holds.

- [ ] **Step 3: Update `CLAUDE.md`**

Add `src/egress/` to the Layout section, and add the pre-flight gate to the
"Surface today" paragraph next to the egress ledger viewer, noting it is the
before-the-fact counterpart to that after-the-fact record.

- [ ] **Step 4: Run the full gate**

```bash
bun run test && bun run typecheck && bun run lint && bun run build \
  && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Expected: every command exits 0. `check-settings-docs` should be unaffected —
this feature adds no settings.

- [ ] **Step 5: Verify in an Extension Development Host**

Use the `verify-extension` skill. Four things unit tests cannot settle:

1. The modal's real button order and its automatic Cancel.
2. That the tab opened by *Show full text* is genuinely scrollable and
   searchable with the non-modal re-ask on screen.
3. Whether `prepareInvocation` is called on every LM-tool invocation route. If
   a route skips it, that path is observed rather than gated — record the
   finding.
4. That an untrusted workspace still prompts despite a set skip.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md docs/ROADMAP.md CLAUDE.md
git commit -m "docs: record the pre-flight egress gate"
```
