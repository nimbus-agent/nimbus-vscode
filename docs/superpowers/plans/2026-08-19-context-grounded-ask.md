# Context-grounded Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Ask turn carry workspace files, an editor selection and local-index items, with the composer showing exactly what will be sent.

**Architecture:** One pure assembler (`src/chat/attachments.ts`) produces both the prompt blocks and the chips from a single pass, so the composer's preview cannot drift from the payload. The controller resolves bytes at send, posts the resolved manifest to the webview *before* calling `askStream`, and keeps attachments session-scoped. Files resolve at send; a selection is snapshotted at attach.

**Tech Stack:** TypeScript (strict, no `any`), Vitest, esbuild, the custom chat webview (`src/chat/webview/`), VS Code API only through `src/vscode-shim.ts`, `askStream` only through `src/egress/gated-client.ts`.

**Spec:** `docs/superpowers/specs/2026-08-19-context-grounded-ask-design.md`
(read it first; the review dispositions are in `2026-08-19-context-grounded-ask-review.md`)

## Global Constraints

- TypeScript **strict**, **no `any`** — `unknown` for external data. Biome enforces `noExplicitAny`, `noConsole` in `src/`, `noNonNullAssertion` (disabled in `**/*.test.ts` only).
- `tsconfig.json` sets `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true` — never assign `undefined` to an optional property; build objects incrementally.
- Log via `logging.ts` only, never `console`.
- `vscode` is reached only through `src/vscode-shim.ts`.
- **`askStream` stays behind the gate.** `src/egress/gated-client.ts` remains the only file naming it; `test/unit/egress-choke-point.test.ts` must stay green **unmodified**, and `src/chat/attachments.ts` must never be added to its `ALLOWED` list. Ask keeps **recording, not prompting** — the `EgressKind` count stays at **eight**.
- Do not spell a dotted `agents*` call followed by a paren in new comments; the choke-point test scans comments.
- **Per-task gate, all four:** `bun run test`, `bun run typecheck`, `bun run lint` (run `bunx biome check --write` on files you touch — the code blocks below are not Biome-formatted), and for manifest/setting changes `bun run check-settings-docs`.
- Commit messages are Conventional Commits ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### Fixed values (use verbatim)

- `PER_ATTACHMENT_BUDGET = 64_000` characters.
- `TOTAL_BUDGET = 200_000` characters across one turn.
- Refusal precedence: **secret → non-textual → budget → unreadable**.
- Chip label vocabulary, exact strings: `possible secret · not sent`,
  `binary · not sent`, `clamped · {sent} of {total} chars`,
  `omitted · turn budget reached`, `unreadable · not sent`,
  `captured at attach`, `from index`.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/chat/attachments.ts` | The `Attachment` union, classification, line-boundary clamping, and `buildAttachedContext` — the single function producing blocks + chips |
| `test/unit/chat-attachments.test.ts` | Pure tests, including the invariant that earns "record, don't prompt" |
| `test/unit/chat-attachment-controller.test.ts` | Controller-level attach/detach/resolve-ordering tests |
| `test/ui/specs/ask-attachments.test.ts` | ExTester spec — chips are UI |

**Modified:** `src/chat/chat-protocol.ts`, `src/chat/chat-controller.ts`, `src/chat/webview/render.ts`, `src/chat/webview/main.ts`, `src/chat/webview/styles.css`, `src/vscode-shim.ts`, `src/extension.ts`, `package.json`, `README.md`, `CLAUDE.md`, `docs/ROADMAP.md`, `docs/architecture.md`.

---

### Task 1: The pure assembler

**Files:**
- Create: `src/chat/attachments.ts`
- Test: `test/unit/chat-attachments.test.ts`

**Interfaces:**
- Consumes: `isSecretPath` from `src/scm/diff.js` (pure, shipped). **Nothing else from `src/scm/`** — `truncateAtHunkBoundary` and `selectWithinBudget` are diff-shaped and do not apply to a continuous file.
- Produces: `Attachment`, `AttachmentOutcome`, `ResolvedAttachment`, `AttachedContext`, `PER_ATTACHMENT_BUDGET`, `TOTAL_BUDGET`, `looksBinary`, `clampToLineBoundary`, `buildAttachedContext`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/chat-attachments.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  type Attachment,
  buildAttachedContext,
  clampToLineBoundary,
  looksBinary,
  PER_ATTACHMENT_BUDGET,
  TOTAL_BUDGET,
} from "../../src/chat/attachments.js";

const file = (path: string): Attachment => ({ kind: "file", path });

const selection = (path: string, text: string): Attachment => ({
  kind: "selection",
  path,
  startLine: 12,
  endLine: 30,
  text,
});

const indexItem = (name: string, snippet: string): Attachment => ({
  kind: "index",
  itemId: "i1",
  name,
  service: "github",
  snippet,
});

/** A reader that serves canned contents and records what it was asked for. */
function reader(files: Record<string, string>) {
  const asked: string[] = [];
  const read = (path: string): string | undefined => {
    asked.push(path);
    return files[path];
  };
  return { read, asked };
}

describe("clampToLineBoundary", () => {
  test("keeps whole lines only", () => {
    const text = "aaa\nbbb\nccc\n";
    expect(clampToLineBoundary(text, 5)).toBe("aaa\n");
  });

  test("returns everything when it already fits", () => {
    expect(clampToLineBoundary("aaa\nbbb\n", 999)).toBe("aaa\nbbb\n");
  });

  test("a single line longer than the budget yields nothing rather than half a line", () => {
    expect(clampToLineBoundary("a-very-long-single-line", 5)).toBe("");
  });
});

describe("looksBinary", () => {
  test("a NUL byte marks it binary", () => {
    expect(looksBinary("abc\0def")).toBe(true);
  });

  test("ordinary source is not binary", () => {
    expect(looksBinary("export const x = 1;\n")).toBe(false);
  });
});

describe("buildAttachedContext", () => {
  test("a plain file contributes a labelled block and a sent chip", () => {
    const r = reader({ "src/a.ts": "export const a = 1;\n" });
    const built = buildAttachedContext([file("src/a.ts")], r.read);
    expect(built.chips).toHaveLength(1);
    expect(built.chips[0]?.outcome.state).toBe("sent");
    expect(built.chips[0]?.label).toBe("src/a.ts");
    expect(built.blocks).toContain("src/a.ts");
    expect(built.blocks).toContain("export const a = 1;");
    // `chars` counts the whole block, header included, because that is what
    // enters the payload. Asserted against the built blocks rather than a
    // hand-counted body length, so the two can never disagree.
    expect(built.chips[0]?.outcome).toEqual({ state: "sent", chars: built.blocks.length });
    expect(built.totalChars).toBe(built.blocks.length);
  });

  test("THE INVARIANT: every chip's character count equals its block body, exactly", () => {
    const r = reader({
      "src/a.ts": "aaa\n",
      "src/b.ts": "bbbb\nbbbb\n",
    });
    const built = buildAttachedContext(
      [file("src/a.ts"), file("src/b.ts"), selection("src/c.ts", "sel\n"), indexItem("n", "snip")],
      r.read,
    );
    for (const chip of built.chips) {
      if (chip.outcome.state === "refused") {
        expect(chip.block).toBeUndefined();
        continue;
      }
      expect(chip.block).toBeDefined();
      expect(chip.block?.length).toBe(chip.outcome.chars);
    }
    const summed = built.chips
      .filter((c) => c.outcome.state !== "refused")
      .reduce((n, c) => n + (c.block?.length ?? 0), 0);
    expect(summed).toBe(built.totalChars);
  });

  test("a secret path is refused outright and reads nothing", () => {
    const r = reader({ ".env": "TOKEN=abc\n" });
    const built = buildAttachedContext([file(".env")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
    expect(built.chips[0]?.block).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  test("a selection from a secret file is refused too — the rule is the path, not the kind", () => {
    const built = buildAttachedContext([selection(".env", "TOKEN=abc\n")], reader({}).read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
  });

  test("binary content is refused, and secret beats binary", () => {
    const r = reader({ "a.bin": "x\0y", "secrets/id_rsa": "x\0y" });
    const built = buildAttachedContext([file("a.bin"), file("secrets/id_rsa")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "non-textual" });
    expect(built.chips[1]?.outcome).toEqual({ state: "refused", reason: "secret" });
  });

  test("an oversized file is clamped at a line boundary and says how much was cut", () => {
    const line = `${"x".repeat(99)}\n`;
    const big = line.repeat(1000); // 100_000 chars
    const r = reader({ "big.ts": big });
    const built = buildAttachedContext([file("big.ts")], r.read);
    const outcome = built.chips[0]?.outcome;
    expect(outcome?.state).toBe("clamped");
    if (outcome?.state !== "clamped") throw new Error("expected clamped");
    expect(outcome.ofChars).toBe(100_000);
    // The BODY respects the budget; `chars` counts the block, so it is larger
    // by exactly the header. Asserting `chars <= budget` would fail against a
    // correct implementation.
    const body = built.chips[0]?.block?.split("\n").slice(1).join("\n") ?? "";
    expect(body.length).toBeLessThanOrEqual(PER_ATTACHMENT_BUDGET);
    expect(outcome.chars).toBe(built.blocks.length);
    expect(built.chips[0]?.block?.endsWith("\n")).toBe(true);
  });

  test("the turn budget stops later attachments rather than truncating them silently", () => {
    const line = `${"y".repeat(99)}\n`;
    const files: Record<string, string> = {};
    const list: Attachment[] = [];
    for (let i = 0; i < 5; i += 1) {
      files[`f${i}.ts`] = line.repeat(640); // 64_000 each
      list.push(file(`f${i}.ts`));
    }
    const built = buildAttachedContext(list, reader(files).read);
    expect(built.totalChars).toBeLessThanOrEqual(TOTAL_BUDGET);
    const omitted = built.chips.filter(
      (c) => c.outcome.state === "refused" && c.outcome.reason === "budget",
    );
    expect(omitted.length).toBeGreaterThan(0);
  });

  test("a missing file is refused as unreadable, and the turn survives", () => {
    const built = buildAttachedContext([file("gone.ts")], reader({}).read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
    expect(built.blocks).toBe("");
  });

  test("empty content is unreadable, not a budget refusal — the reason must be true", () => {
    const emptyFile = buildAttachedContext([file("empty.ts")], reader({ "empty.ts": "" }).read);
    expect(emptyFile.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
    // An index hit whose semanticSnippet was absent arrives here as "".
    const emptyItem = buildAttachedContext([indexItem("n", "")], reader({}).read);
    expect(emptyItem.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
  });

  test("a selection ignores later edits to its file — the snapshot is what is sent", () => {
    const r = reader({ "src/c.ts": "THE FILE CHANGED ENTIRELY\n" });
    const built = buildAttachedContext([selection("src/c.ts", "original selected text\n")], r.read);
    expect(built.blocks).toContain("original selected text");
    expect(built.blocks).not.toContain("THE FILE CHANGED ENTIRELY");
    expect(r.asked).toEqual([]);
  });

  test("a file attachment DOES reflect a later edit — the asymmetry is deliberate", () => {
    const r = reader({ "src/c.ts": "edited\n" });
    const built = buildAttachedContext([file("src/c.ts")], r.read);
    expect(built.blocks).toContain("edited");
    expect(r.asked).toEqual(["src/c.ts"]);
  });

  test("a selection block names its line range", () => {
    const built = buildAttachedContext([selection("src/c.ts", "sel\n")], reader({}).read);
    expect(built.blocks).toContain("src/c.ts");
    expect(built.blocks).toContain("12");
    expect(built.blocks).toContain("30");
    expect(built.chips[0]?.detail).toContain("captured at attach");
  });

  test("an index item contributes its snippet and touches no file", () => {
    const r = reader({});
    const built = buildAttachedContext([indexItem("deploy.yml", "steps: [...]")], r.read);
    expect(built.chips[0]?.detail).toContain("from index");
    expect(built.blocks).toContain("steps: [...]");
    expect(r.asked).toEqual([]);
  });

  test("an entirely refused set still yields an empty block string, never a throw", () => {
    const built = buildAttachedContext([file(".env"), file("gone.ts")], reader({}).read);
    expect(built.blocks).toBe("");
    expect(built.totalChars).toBe(0);
    expect(built.chips).toHaveLength(2);
  });

  test("no attachments yields nothing at all", () => {
    const built = buildAttachedContext([], reader({}).read);
    expect(built).toEqual({ blocks: "", chips: [], totalChars: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/chat-attachments.test.ts`
Expected: FAIL — cannot resolve `../../src/chat/attachments.js`.

- [ ] **Step 3: Implement `attachments.ts`**

```ts
import { isSecretPath } from "../scm/diff.js";

/**
 * What one attachment contributes to a turn. A `file` stores a path and is read
 * at send, so the user gets the version they are looking at. A `selection`
 * stores its TEXT, captured when it was attached: a stored range drifts under
 * edits, and by send time it can cover entirely different code, which is worse
 * than sending nothing. The range travels as provenance, not as a pointer.
 */
export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "selection"; path: string; startLine: number; endLine: number; text: string }
  | { kind: "index"; itemId: string; name: string; service: string; snippet: string };

export type RefusalReason = "secret" | "non-textual" | "budget" | "unreadable";

export type AttachmentOutcome =
  | { state: "sent"; chars: number }
  | { state: "clamped"; chars: number; ofChars: number }
  | { state: "refused"; reason: RefusalReason };

export interface ResolvedAttachment {
  readonly attachment: Attachment;
  /** Primary chip text: the path, or the index item's name. */
  readonly label: string;
  /** Secondary chip text: what happened, in the vocabulary the spec fixes. */
  readonly detail: string;
  readonly outcome: AttachmentOutcome;
  /** The exact body this attachment contributes. Absent when refused. */
  readonly block?: string;
}

export interface AttachedContext {
  /** Everything prepended to the user's question. Empty when nothing survived. */
  readonly blocks: string;
  readonly chips: readonly ResolvedAttachment[];
  readonly totalChars: number;
}

/** One attachment's ceiling. */
export const PER_ATTACHMENT_BUDGET = 64_000;
/** One turn's ceiling across all attachments. */
export const TOTAL_BUDGET = 200_000;

// Decoded binary reaches us as text with NULs in it. A cheap, honest check —
// the alternative is sending a block of mojibake and letting the model guess.
//
// Write the two-character ESCAPE `\0`, never a literal NUL: an earlier draft of
// this plan contained real control bytes, which rendered as spaces to every
// reader. Had that shipped, `includes(" ")` would have refused every source
// file containing a space — i.e. all of them.
export function looksBinary(text: string): boolean {
  return text.includes("\0");
}

// Never cut mid-line: a truncated identifier invites a confident answer about
// code that does not exist. A single line over budget yields nothing at all.
export function clampToLineBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget);
  return cut < 0 ? "" : text.slice(0, cut + 1);
}

function labelOf(a: Attachment): string {
  return a.kind === "index" ? a.name : a.path;
}

function refuse(a: Attachment, reason: RefusalReason, detail: string): ResolvedAttachment {
  return { attachment: a, label: labelOf(a), detail, outcome: { state: "refused", reason } };
}

function headerFor(a: Attachment): string {
  switch (a.kind) {
    case "file":
      return `--- file: ${a.path} ---`;
    case "selection":
      return `--- selection: ${a.path} (lines ${a.startLine}-${a.endLine}) ---`;
    case "index":
      return `--- index item: ${a.service}/${a.name} ---`;
  }
}

function blockFor(a: Attachment, body: string): string {
  return `${headerFor(a)}\n${body}\n`;
}

/**
 * The single pass that produces both what is sent and what the composer shows.
 * Two outputs from one traversal is the whole point: the chips cannot drift
 * from the payload, which is what lets the Ask panel record rather than prompt.
 * `readFile` returns undefined for anything it cannot read.
 */
export function buildAttachedContext(
  attachments: readonly Attachment[],
  readFile: (path: string) => string | undefined,
): AttachedContext {
  const chips: ResolvedAttachment[] = [];
  const bodies: string[] = [];
  let total = 0;

  for (const a of attachments) {
    // Secret wins over every other verdict, and is decided from the path alone
    // so a secret file is never even read. NOTE: isSecretPath matches names,
    // not contents — an API key pasted into an ordinary source file is not
    // caught here, and the docs say so.
    if (a.kind !== "index" && isSecretPath(a.path)) {
      chips.push(refuse(a, "secret", "possible secret · not sent"));
      continue;
    }

    const raw =
      a.kind === "file" ? readFile(a.path) : a.kind === "selection" ? a.text : a.snippet;
    // Empty counts as unreadable, not as a budget refusal: an index item with
    // no semanticSnippet, or an empty file, has nothing to contribute, and
    // "omitted · turn budget reached" would be a lie about why.
    if (raw === undefined || raw.trim().length === 0) {
      chips.push(refuse(a, "unreadable", "unreadable · not sent"));
      continue;
    }
    if (looksBinary(raw)) {
      chips.push(refuse(a, "non-textual", "binary · not sent"));
      continue;
    }

    const remaining = TOTAL_BUDGET - total;
    if (remaining <= 0) {
      chips.push(refuse(a, "budget", "omitted · turn budget reached"));
      continue;
    }

    const budget = Math.min(PER_ATTACHMENT_BUDGET, remaining);
    const body = clampToLineBoundary(raw, budget);
    if (body.length === 0) {
      chips.push(refuse(a, "budget", "omitted · turn budget reached"));
      continue;
    }

    const block = blockFor(a, body);
    bodies.push(block);
    total += block.length;

    const provenance =
      a.kind === "selection"
        ? `lines ${a.startLine}-${a.endLine} · captured at attach`
        : a.kind === "index"
          ? "from index"
          : "";
    const clampNote =
      body.length < raw.length ? `clamped · ${body.length} of ${raw.length} chars` : "";
    const detail = [provenance, clampNote].filter((s) => s.length > 0).join(" · ");

    chips.push({
      attachment: a,
      label: labelOf(a),
      detail,
      outcome:
        body.length < raw.length
          ? { state: "clamped", chars: block.length, ofChars: raw.length }
          : { state: "sent", chars: block.length },
      block,
    });
  }

  return { blocks: bodies.join(""), chips, totalChars: total };
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/chat-attachments.test.ts`
Expected: PASS. If the invariant test fails, **stop and report** — that test is what justifies not prompting, and a design decision rests on it.

- [ ] **Step 5: Full gate and commit**

```bash
bunx biome check --write src/chat/attachments.ts test/unit/chat-attachments.test.ts
bun run test && bun run typecheck && bun run lint
git add src/chat/attachments.ts test/unit/chat-attachments.test.ts
git commit -m "feat(chat): pure attachment assembler with refusal and clamping"
```

---

### Task 2: Protocol and controller

**Files:**
- Modify: `src/chat/chat-protocol.ts`, `src/chat/chat-controller.ts`
- Test: `test/unit/chat-attachment-controller.test.ts`

**Interfaces:**
- Consumes: everything Task 1 exports.
- Produces: on `ChatControllerDeps`, a new `readFile(path: string): string | undefined`; on `ChatController`, `attach(a: Attachment): void`, `detach(id: string): void`, `attachments(): readonly Attachment[]`. New protocol messages both ways.

**Ordering requirement (the one that matters):** `start()` must post the resolved manifest **before** `deps.client.askStream(...)` is called. Today `start()` calls `askStream` first and posts `userMessage` afterwards; the manifest post goes *before* the `askStream` call, and `userMessage` stays where it is.

- [ ] **Step 1: Extend the protocol**

In `src/chat/chat-protocol.ts`, add to `ExtensionToWebview`:

```ts
  | { type: "attachments"; chips: ReadonlyArray<{ id: string; label: string; detail: string; state: "sent" | "clamped" | "refused"; chars: number }>; totalChars: number; provisional: boolean }
  | { type: "turnAttachments"; chips: ReadonlyArray<{ label: string; detail: string; state: "sent" | "clamped" | "refused"; chars: number }> }
```

and to `WebviewToExtension`:

```ts
  | { type: "detachContext"; id: string }
  | { type: "openAttachPicker" }
```

`attachments` updates the composer's live chips (`provisional: true` before a send, `false` for the resolved set). `turnAttachments` records the manifest on the message just sent — the permanent record.

- [ ] **Step 2: Write the failing controller test**

Create `test/unit/chat-attachment-controller.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

import type { Attachment } from "../../src/chat/attachments.js";
import { createChatController } from "../../src/chat/chat-controller.js";
import type { ExtensionToWebview } from "../../src/chat/chat-protocol.js";

function harness(files: Record<string, string> = {}) {
  const posted: ExtensionToWebview[] = [];
  const order: string[] = [];
  // AskStreamHandle is `AsyncIterable<StreamEvent> & { streamId, cancel() }` —
  // NOT an object with an `events` property. `test/unit/chat-controller.test.ts`
  // already builds this shape in its `pendingStream` helper; read that first and
  // mirror it rather than inventing a second fake.
  const handle = {
    streamId: "s1",
    cancel: vi.fn(async () => {}),
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next(): Promise<IteratorResult<never>> {
          return { value: undefined as never, done: true };
        },
      };
    },
  };
  const client = {
    askStream: vi.fn((_input: string) => {
      order.push("askStream");
      return handle as never;
    }),
    cancelStream: vi.fn(async () => ({ ok: true })),
    getSessionTranscript: vi.fn(async () => ({ sessionId: "s", turns: [], hasMore: false })),
  };
  const ctl = createChatController({
    client: client as never,
    panel: {
      postMessage: async (m: ExtensionToWebview) => {
        posted.push(m);
        order.push(m.type);
      },
    } as never,
    sessionStore: { get: () => undefined, set: () => {} } as never,
    registerStreamWithHitl: () => {},
    unregisterStreamWithHitl: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    readFile: (p: string) => files[p],
  });
  return { ctl, client, posted, order };
}

const file = (path: string): Attachment => ({ kind: "file", path });

describe("attachment state", () => {
  test("attaching posts provisional chips", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    const msg = h.posted.find((m) => m.type === "attachments");
    expect(msg).toBeDefined();
    if (msg?.type !== "attachments") throw new Error("expected attachments");
    expect(msg.provisional).toBe(true);
    expect(msg.chips[0]?.label).toBe("a.ts");
  });

  test("detaching removes it", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    const id = h.posted.flatMap((m) => (m.type === "attachments" ? m.chips : []))[0]?.id;
    if (id === undefined) throw new Error("no chip id");
    h.ctl.detach(id);
    expect(h.ctl.attachments()).toHaveLength(0);
  });

  test("attachments survive a turn, because the follow-up needs them", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("first question");
    expect(h.ctl.attachments()).toHaveLength(1);
  });

  test("a new conversation clears them", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.newConversation();
    expect(h.ctl.attachments()).toHaveLength(0);
  });
});

describe("sending", () => {
  test("the RESOLVED manifest is posted BEFORE askStream is called", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    h.order.length = 0; // ignore the attach-time post
    await h.ctl.start("why is this here?");
    // Track the resolved post specifically: several `attachments` messages are
    // sent, and "some attachments message preceded askStream" would pass even
    // if the resolved one came after. The composer being the pre-flight preview
    // is the whole argument for not prompting, so this ordering IS the feature.
    const resolvedAt = h.posted.findIndex(
      (m) => m.type === "attachments" && m.provisional === false,
    );
    expect(resolvedAt).toBeGreaterThanOrEqual(0);
    const askAt = h.order.indexOf("askStream");
    const postsBeforeAsk = h.order.slice(0, askAt).filter((t) => t === "attachments").length;
    expect(askAt).toBeGreaterThanOrEqual(0);
    // The resolved post is among those that happened before the request left.
    expect(postsBeforeAsk).toBeGreaterThanOrEqual(1);
    expect(h.posted.slice(0, postsBeforeAsk).some((m) => m.type === "attachments" && !m.provisional)).toBe(true);
  });

  test("the composer returns to provisional after the send, so the next turn is not overstated", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("q");
    const last = [...h.posted].reverse().find((m) => m.type === "attachments");
    if (last?.type !== "attachments") throw new Error("expected attachments");
    expect(last.provisional).toBe(true);
  });

  test("the prompt carries the block and the question, question last", async () => {
    const h = harness({ "a.ts": "export const a = 1;\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("why is this here?");
    const sent = h.client.askStream.mock.calls[0]?.[0] as string;
    expect(sent).toContain("export const a = 1;");
    expect(sent.indexOf("export const a = 1;")).toBeLessThan(sent.indexOf("why is this here?"));
  });

  test("a turn with no attachments sends exactly the typed text, as today", async () => {
    const h = harness();
    await h.ctl.start("plain question");
    expect(h.client.askStream.mock.calls[0]?.[0]).toBe("plain question");
  });

  test("the sent turn gets its own permanent manifest", async () => {
    const h = harness({ "a.ts": "x\n" });
    h.ctl.attach(file("a.ts"));
    await h.ctl.start("q");
    expect(h.posted.some((m) => m.type === "turnAttachments")).toBe(true);
  });

  test("an all-refused set still sends the question", async () => {
    const h = harness();
    h.ctl.attach(file(".env"));
    await h.ctl.start("q");
    expect(h.client.askStream.mock.calls[0]?.[0]).toBe("q");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bunx vitest run test/unit/chat-attachment-controller.test.ts`
Expected: FAIL — `attach` is not a function, and `readFile` is not a known dep.

- [ ] **Step 4: Implement in `chat-controller.ts`**

Add the import and the dep:

```ts
import { type Attachment, buildAttachedContext } from "./attachments.js";
```

In `ChatControllerDeps`:

```ts
  /** Reads a repo-relative path, or undefined when it cannot be read. */
  readFile(path: string): string | undefined;
```

In `ChatController`:

```ts
  attach(attachment: Attachment): void;
  detach(id: string): void;
  attachments(): readonly Attachment[];
```

Inside `createChatController`, beside the other closure state:

```ts
  // Session-scoped, not turn-scoped: "now explain the other half" is the normal
  // second question, so a turn must not consume its own context.
  const attached = new Map<string, Attachment>();
  let attachSeq = 0;

  const postAttachments = (provisional: boolean): void => {
    // Zip by IDENTITY, not by index. Index alignment holds only while
    // buildAttachedContext returns exactly one chip per input in order — true
    // today, and a silent mis-mapping tomorrow if it ever filters. A chip whose
    // id belongs to a different attachment means the remove button deletes the
    // wrong one, which is the kind of bug nobody suspects the zip for.
    const entries = [...attached.entries()];
    const built = buildAttachedContext(
      entries.map(([, a]) => a),
      deps.readFile,
    );
    post({
      type: "attachments",
      provisional,
      totalChars: built.totalChars,
      chips: built.chips.map((c) => ({
        id: entries.find(([, a]) => a === c.attachment)?.[0] ?? "",
        label: c.label,
        detail: c.detail,
        state: c.outcome.state,
        chars: c.outcome.state === "refused" ? 0 : c.outcome.chars,
      })),
    });
  };
```

Then in the returned object:

```ts
    attach(attachment): void {
      attachSeq += 1;
      attached.set(`a${attachSeq}`, attachment);
      postAttachments(true);
    },
    detach(id): void {
      attached.delete(id);
      postAttachments(true);
    },
    attachments(): readonly Attachment[] {
      return [...attached.values()];
    },
```

and in `newConversation()`, before it resets, add `attached.clear();`.

In `start(input)`, immediately after the `generation += 1;` line and **before**
`deps.client.askStream(...)`:

```ts
      // Resolve now, not at attach time, so a file edited since attaching sends
      // what the user is actually looking at. The manifest is posted BEFORE the
      // request goes out: the composer is this surface's pre-flight preview, so
      // it must show the resolved bytes rather than a stale estimate.
      const built = buildAttachedContext([...attached.values()], deps.readFile);
      if (built.chips.length > 0) {
        postAttachments(false);
        post({
          type: "turnAttachments",
          chips: built.chips.map((c) => ({
            label: c.label,
            detail: c.detail,
            state: c.outcome.state,
            chars: c.outcome.state === "refused" ? 0 : c.outcome.chars,
          })),
        });
      }
      const prompt = built.blocks.length > 0 ? `${built.blocks}\n${input}` : input;
```

Then, still before `askStream`, hand the composer back its provisional state:

```ts
      // The resolved numbers belong to the turn just sent, and the turn keeps
      // them. For the composer they are already history: the attachments carry
      // into the follow-up, where they will be re-read, so anything shown now
      // is an estimate again. Posting this here rather than on stream-end keeps
      // it in the same tick as the send, so the chips never visibly flicker.
      if (built.chips.length > 0) postAttachments(true);
```

then pass `prompt` (not `input`) to `deps.client.askStream(...)`. Leave the two
`post({ type: "userMessage", text: input })` calls posting **`input`** — the
transcript shows what the user typed, and the manifest carries the rest.

- [ ] **Step 5: Run both test files**

Run: `bunx vitest run test/unit/chat-attachment-controller.test.ts test/unit/chat-controller.test.ts`
Expected: PASS. The pre-existing `chat-controller.test.ts` will fail to compile until its harness supplies the new `readFile` dep — add it there (returning `undefined`) and change nothing else.

- [ ] **Step 6: Choke-point guard, gate, commit**

```bash
bunx vitest run test/unit/egress-choke-point.test.ts   # must pass UNEDITED
bunx biome check --write src/chat/attachments.ts src/chat/chat-controller.ts src/chat/chat-protocol.ts
bun run test && bun run typecheck && bun run lint
git add src/chat test/unit
git commit -m "feat(chat): resolve attachments at send and post the manifest first"
```

---

### Task 3: The file-reading seam

**Files:**
- Modify: `src/vscode-shim.ts`, `src/extension.ts`
- Test: extend `test/unit/extension.test.ts` only if it asserts the shim's shape

**The gap:** `WorkspaceApi` today exposes `textDocuments` — **documents VS Code already has open** — and nothing else. There is no way to read an unopened file and no `findFiles`. Both are needed: the picker lists workspace files, and an attachment usually names a file that is not open.

- [ ] **Step 1: Widen the shim**

In `src/vscode-shim.ts`, add to `WorkspaceApi`:

```ts
  /**
   * Reads a file that need not be open. `textDocuments` above only covers what
   * VS Code already holds; an attachment usually names a file that is not open.
   */
  openTextDocument(fsPath: string): Thenable<OpenTextDocumentLike>;
  /** Workspace file search for the attach picker. `max` caps the result set. */
  findFiles(include: string, exclude: string | undefined, max: number): Thenable<Array<{ fsPath: string }>>;
```

- [ ] **Step 2: Wire the real implementations in `extension.ts`**

Where the real `workspace` object is assembled, add:

```ts
    openTextDocument: (fsPath) => vscode.workspace.openTextDocument(fsPath),
    findFiles: (include, exclude, max) =>
      vscode.workspace.findFiles(include, exclude ?? null, max).then((uris) =>
        uris.map((u) => ({ fsPath: u.fsPath })),
      ),
```

- [ ] **Step 2b: Define the two path helpers — neither exists yet**

Attachments are keyed by **repo-relative** path (that is what appears in a chip
and in a block header), while the shim reads by absolute path. No helper for
either exists in `src/`; today the codebase reads `workspaceFolders` raw at
`src/context/real-context-view.ts:140` and `src/extension.ts:1849`. Define both
once, near the cache, and use them everywhere:

```ts
  // First workspace folder only, matching what extension.ts:1849 already does.
  // With no folder open, paths pass through unchanged — a loose file is still
  // attachable, it just has no root to be relative to.
  const workspaceRoot = (): string | undefined =>
    deps.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const toAbsolute = (repoRelative: string): string => {
    const root = workspaceRoot();
    return root === undefined ? repoRelative : `${root}/${repoRelative}`;
  };

  const toRepoRelative = (fsPath: string): string => {
    const root = workspaceRoot();
    if (root === undefined || !fsPath.startsWith(root)) return fsPath;
    return fsPath.slice(root.length).replace(/^[\\/]+/, "").replaceAll("\\", "/");
  };
```

These two must round-trip: `toRepoRelative(toAbsolute(p)) === p`. A mismatch
does not throw — it silently misses the cache, and the chip reports
`unreadable · not sent` for a file that reads perfectly well.

- [ ] **Step 3: Build the reader passed to the controller**

`buildAttachedContext` takes a **synchronous** `readFile`, because the assembler
must stay pure and synchronous for its tests. Bridge it with a cache filled
before send:

```ts
  // Repo-relative path -> contents. Primed when a file is ATTACHED and
  // refreshed before each send. Priming at attach is not an optimisation: the
  // controller renders provisional chips the moment attach() is called, and an
  // unprimed cache would render a perfectly good file as "unreadable · not
  // sent". The spec's own wording ("about 4 KB, measured when attached")
  // requires a real measurement at attach time.
  const attachmentCache = new Map<string, string>();
  const readAttachment = (path: string): string | undefined => attachmentCache.get(path);

  /** Reads one path into the cache. Silent on failure — the assembler reports it. */
  const cacheFile = async (path: string): Promise<void> => {
    try {
      const doc = await deps.workspace.openTextDocument(toAbsolute(path));
      attachmentCache.set(path, doc.getText());
    } catch {
      attachmentCache.delete(path);
    }
  };
```

and, in the command that submits a turn, prime the cache from the controller's
own attachment list before calling `start`:

```ts
  const primeAttachments = async (): Promise<void> => {
    attachmentCache.clear();
    for (const a of ctl.attachments()) {
      if (a.kind !== "file") continue;
      await cacheFile(a.path);
    }
  };
```

Two call sites, and both matter:

1. **Before every `ctl.start(...)`** that can carry attachments (the webview
   `submitAsk` path at minimum) — `await primeAttachments()`. This is the
   re-read that makes a file attachment reflect edits made since it was
   attached.
2. **Before every `chatController.attach(...)`** of a `file` attachment —
   `await cacheFile(path)`. Without this the first render of a freshly attached
   file shows `unreadable · not sent`, because `attach()` posts provisional
   chips synchronously and the cache would still be empty. `selection` and
   `index` attachments carry their own text and need no priming.

- [ ] **Step 3b: Test the first render**

Add to `test/unit/chat-attachment-controller.test.ts`:

```ts
test("a freshly attached file renders with a size, not as unreadable", async () => {
  const h = harness({ "a.ts": "export const a = 1;\n" });
  h.ctl.attach(file("a.ts"));
  const msg = h.posted.find((m) => m.type === "attachments");
  if (msg?.type !== "attachments") throw new Error("expected attachments");
  expect(msg.chips[0]?.state).toBe("sent");
  expect(msg.chips[0]?.chars).toBeGreaterThan(0);
});
```

The harness's `readFile` is backed by its `files` record, which stands in for a
primed cache — so this test passes only while the extension actually primes
before attaching. Task 5's picker and the two attach commands must `await
cacheFile(...)` first; note it in the report if any call site cannot.

- [ ] **Step 4: Gate and commit**

```bash
bunx biome check --write src/vscode-shim.ts src/extension.ts
bun run test && bun run typecheck && bun run lint
git add src/vscode-shim.ts src/extension.ts test/unit/extension.test.ts
git commit -m "feat(chat): read attachable files through the shim"
```

---

### Task 4: Chips in the composer

**Files:**
- Modify: `src/chat/webview/render.ts`, `src/chat/webview/main.ts`, `src/chat/webview/styles.css`
- Test: extend `test/unit/chat-panel.test.ts` — the existing home for this webview's rendering. `render.ts` already exports `escapeHtml` (line 22); import it, do not add a second one.

The webview **renders the posted manifest and computes nothing** — that is what
keeps the preview honest.

- [ ] **Step 1: Write the failing render test**

Add to the existing webview render test file:

```ts
test("a sent chip shows its label and character count", () => {
  const html = renderChips(
    [{ id: "a1", label: "src/a.ts", detail: "", state: "sent", chars: 20 }],
    20,
    true,
  );
  expect(html).toContain("src/a.ts");
  expect(html).toContain("20");
});

test("a refused chip says why, and carries no count", () => {
  const html = renderChips(
    [{ id: "a1", label: ".env", detail: "possible secret · not sent", state: "refused", chars: 0 }],
    0,
    true,
  );
  expect(html).toContain("possible secret · not sent");
});

test("provisional chips say the size is an estimate; resolved ones do not", () => {
  const chip = { id: "a1", label: "a.ts", detail: "", state: "sent" as const, chars: 20 };
  expect(renderChips([chip], 20, true)).toContain("estimated");
  expect(renderChips([chip], 20, false)).not.toContain("estimated");
});

test("no attachments renders nothing at all", () => {
  expect(renderChips([], 0, true)).toBe("");
});
```

- [ ] **Step 2: Implement `renderChips` in `render.ts`**

```ts
export interface ChipView {
  id: string;
  label: string;
  detail: string;
  state: "sent" | "clamped" | "refused";
  chars: number;
}

// Renders exactly what the host resolved. This module never reads a file,
// never counts characters itself, and never infers a state — the composer is
// this surface's pre-flight preview, and a preview that computes its own
// numbers is not a preview of anything.
export function renderChips(
  chips: readonly ChipView[],
  totalChars: number,
  provisional: boolean,
): string {
  if (chips.length === 0) return "";
  const items = chips
    .map((c) => {
      const count = c.state === "refused" ? "" : `<span class="chip-count">${c.chars}</span>`;
      const detail =
        c.detail.length > 0 ? `<span class="chip-detail">${escapeHtml(c.detail)}</span>` : "";
      return `<li class="chip chip-${c.state}" data-id="${escapeHtml(c.id)}">
<span class="chip-label">${escapeHtml(c.label)}</span>${detail}${count}
<button class="chip-remove" data-id="${escapeHtml(c.id)}" title="Remove">×</button></li>`;
    })
    .join("");
  const suffix = provisional ? " estimated" : "";
  return `<ul class="chips">${items}</ul>
<div class="chip-total">${totalChars} chars attached${suffix}</div>`;
}
```

Reuse the file's existing `escapeHtml`; do not add a second one.

- [ ] **Step 3: Wire `main.ts`**

Handle the two new host messages by replacing the composer's chip container
(`attachments`) and appending a compact, **non-removable** manifest to the last
user turn (`turnAttachments`). Wire click handling for `.chip-remove` to post
`{ type: "detachContext", id }`, and the attach button to post
`{ type: "openAttachPicker" }`.

- [ ] **Step 4: Style it**

In `styles.css`, using existing VS Code theme variables:

```css
.chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 5.5em; overflow-y: auto;
         list-style: none; margin: 0 0 4px; padding: 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
        border: 1px solid var(--vscode-panel-border); border-radius: 10px; font-size: 0.9em; }
.chip-refused { opacity: 0.7; text-decoration: line-through; }
.chip-clamped { border-style: dashed; }
.chip-detail { opacity: 0.8; }
.chip-count { opacity: 0.6; }
.chip-total { font-size: 0.85em; opacity: 0.7; }
/* History chips are a record, not a control: no remove button, dimmer. */
.turn-chips .chip-remove { display: none; }
.turn-chips { opacity: 0.75; }
```

The `max-height` plus `overflow-y` is the requirement from the spec: six
attachments is a normal working set, and chips must never squeeze the text area.

- [ ] **Step 5: Build, gate, commit**

```bash
bun run build     # the webview bundle must still build
bunx biome check --write src/chat/webview/render.ts src/chat/webview/main.ts
bun run test && bun run typecheck && bun run lint
git add src/chat/webview test/unit
git commit -m "feat(chat): attachment chips in the composer"
```

---

### Task 5: The three ways to attach

**Files:**
- Modify: `src/extension.ts`, `package.json`
- Test: `test/unit/manifest-attachments.test.ts` (new)

**Interfaces:** three commands — `nimbus.attachContext` (the picker, also what
`openAttachPicker` triggers), `nimbus.attachSelectionToAsk`, and
`nimbus.attachIndexItemToAsk`.

- [ ] **Step 1: Write the failing manifest test**

Create `test/unit/manifest-attachments.test.ts`, following the shape of
`test/unit/manifest-connectors.test.ts` (read it first). Assert: all three
commands exist under category `Nimbus`; `nimbus.attachIndexItemToAsk` appears in
`view/item/context` for `view == nimbus.indexView`; `nimbus.attachSelectionToAsk`
appears in `editor/context` guarded by `editorHasSelection`; and none of the
three is hidden from the palette with `"when": "false"` — each works without a
node, so the repo's rule for hiding does not apply.

- [ ] **Step 2: Add the manifest entries**

```json
{ "command": "nimbus.attachContext", "title": "Attach Context to Ask", "category": "Nimbus", "icon": "$(add)" },
{ "command": "nimbus.attachSelectionToAsk", "title": "Attach Selection to Ask", "category": "Nimbus" },
{ "command": "nimbus.attachIndexItemToAsk", "title": "Attach to Ask", "category": "Nimbus" }
```

plus an `editor/context` entry for the selection command
(`"when": "editorHasSelection"`, group `nimbus`) and a `view/item/context` entry
for the index one (`"when": "view == nimbus.indexView && viewItem == nimbusIndexItem"`).

- [ ] **Step 3: Implement the picker**

In `extension.ts`, blending both sources into one Quick Pick, each row carrying
its own icon so the two are never confused:

```ts
  const attachPicker = async (): Promise<void> => {
    const files = await deps.workspace.findFiles("**/*", "**/node_modules/**", 200);
    const fileItems = files.map((f) => ({
      label: `$(file) ${toRepoRelative(f.fsPath)}`,
      attachment: { kind: "file", path: toRepoRelative(f.fsPath) } as Attachment,
    }));
    let indexItems: typeof fileItems = [];
    const client = nimbus();
    if (client !== undefined) {
      try {
        const hits = await client.searchRanked({ limit: settings.searchLimit() });
        indexItems = hits.map((h) => ({
          label: `$(database) ${h.name}`,
          attachment: {
            kind: "index",
            // Verified against the pinned client: RankedSearchItem carries
            // `indexPrimaryKey` and an OPTIONAL `semanticSnippet` — there is no
            // `snippet` field. `name`/`service` come from NimbusItem, which is
            // what src/sidebar/index.ts already reads.
            itemId: h.indexPrimaryKey,
            name: h.name,
            service: h.service,
            snippet: h.semanticSnippet ?? "",
          } as Attachment,
        }));
      } catch (e) {
        log.warn(`attach picker: index unavailable: ${errMsg(e)}`);
      }
    }
    const chosen = await deps.window.showQuickPick([...fileItems, ...indexItems], {
      placeHolder: "Attach a file or an indexed item to your question",
      matchOnDescription: true,
    });
    if (chosen === undefined) return;
    chatController.attach(chosen.attachment);
  };
```

An index item whose `semanticSnippet` is absent attaches an empty snippet, which
the assembler refuses as `unreadable · not sent` — correct behaviour, since there
is nothing to send, and visible rather than silent.

The selection command builds `{ kind: "selection", path, startLine, endLine, text }`
from the active editor, capturing the text **now**. The index command takes the
tree node's payload, exactly as `nimbus.askAboutIndexItem` already does.

- [ ] **Step 4: Handle `openAttachPicker` from the webview**

Route that message to `attachPicker()` where the other webview messages are
dispatched, and `detachContext` to `chatController.detach(id)`.

- [ ] **Step 5: Gate and commit**

```bash
bunx vitest run test/unit/manifest-attachments.test.ts
bunx biome check --write src/extension.ts
bun run test && bun run typecheck && bun run lint && bun run check-settings-docs
git add src/extension.ts package.json test/unit/manifest-attachments.test.ts
git commit -m "feat(chat): attach from the picker, the editor and the index"
```

---

### Task 6: Drive it in a real editor

**Files:**
- Create: `test/ui/specs/ask-attachments.test.ts`
- Modify: `test/ui/fake-gateway.ts` if `ask.stream` needs a canned reply it lacks

Read `test/ui/specs/context-panel.test.ts` and `workflows-view.test.ts` first —
they establish the fixture, the fake Gateway wiring and the waiting helpers.

- [ ] **Step 1: Write the spec**

Cover, at minimum: open the Ask panel; run **Nimbus: Attach Context to Ask** and
pick a fixture file; assert a chip appears bearing that file's name; send a
question; assert the chip's count is non-zero and the sent turn carries its own
chip row; then detach and assert the chip disappears.

- [ ] **Step 2: Run it**

Run: `bun run test:ui`
Note this suite is **not** part of CI (an unfixed upstream headless-Linux
limitation in ExTester's window-reuse handshake — see `docs/development.md`), so
it must be run locally and its result pasted into the task report.

- [ ] **Step 3: Commit**

```bash
git add test/ui
git commit -m "test(ui): drive Ask attachments in a real editor"
```

---

### Task 7: Docs

**Files:** `README.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Write them**

- `README.md` — a feature bullet in the existing list. It must state that the
  composer shows exactly what will be sent, that possibly-secret and binary
  files are refused, that oversized ones are clamped, and that
  **`isSecretPath` matches file names, not contents** — an API key pasted into
  an ordinary source file is not detected.
- `CLAUDE.md` — extend the Ask entry in *Surface today*: attachments, the
  session scoping, and the reason Ask still records rather than prompts (the
  composer is the preview, and the chips-equal-payload invariant is what earns
  it). Note the `EgressKind` count stays at eight.
- `docs/architecture.md` — `src/chat/attachments.ts` in the module map, and the
  resolve-at-send ordering.
- `docs/ROADMAP.md` — move **Context-grounded Ask** from Phase 2 to *Already
  shipped*; add a Phase 2/3 row for the deferred follow-up (typed `@`-mentions
  and Explorer drag-and-drop).

- [ ] **Step 2: Full gate**

```bash
bun run test && bun run typecheck && bun run lint && bun run build
bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

All must pass. `check-settings-docs` passes because **no setting is added**.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md docs
git commit -m "docs: record context-grounded Ask"
```

---

## Self-Review

**Spec coverage:** attachment kinds and the snapshot/live asymmetry (Task 1) ·
refusal precedence, line-boundary clamping, budgets (1) · the chips-equal-payload
invariant (1) · resolve-at-send and manifest-before-request (2) · session scoping
and clearing (2) · the sent turn's permanent manifest (2, 4) · reading unopened
files (3) · chips wrapping without squeezing the composer, draft vs history (4) ·
three entry points and distinct picker icons (5) · real-editor verification (6) ·
`isSecretPath` name-not-content limitation documented (7) · roadmap and deferred
follow-ups (7). Every spec section maps to a task.

**Deliberate deviations:**
- The spec left the budget open; this plan fixes `PER_ATTACHMENT_BUDGET = 64_000`
  and `TOTAL_BUDGET = 200_000` and adds a **turn** budget the spec did not
  require — without it, ten attachments at the per-file ceiling would send 640k
  characters. Over-budget attachments are refused with `omitted · turn budget
  reached` rather than silently truncated.
- `buildAttachedContext` is synchronous, so file contents are primed into a cache
  before each send (Task 3). An async assembler would be closer to the metal but
  would make the invariant test asynchronous for no gain.

**Type consistency:** `Attachment` (Task 1) is consumed by 2, 3 and 5;
`ResolvedAttachment.outcome` drives the chip `state` strings in 2 and 4;
`ChipView` (4) mirrors the `attachments` protocol message (2); `readFile` (1) is
supplied by the cache in 3 and stubbed in 2's tests.
