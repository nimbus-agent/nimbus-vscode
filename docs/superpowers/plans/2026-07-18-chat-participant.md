# Native `@nimbus` VS Code Chat Participant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `@nimbus` participant to VS Code's built-in Chat view, backed by the local Nimbus agent over `askStream`, with `/explain` `/fix` `/test` slash commands, `#file`/selection context, streaming answers, mid-stream HITL, and clickable local-index citations.

**Architecture:** Pure orchestration logic (`src/chat-participant/*.ts`) behind narrow interfaces, unit-tested under Vitest with a fake response sink — exactly like `ChatController`. A thin, coverage-excluded `real-participant.ts` adapts the real `vscode.chat` API (request/response/token/history/editor/references) onto those interfaces, injected into `activateWithDeps` the same way `chatPanelFactory` is. Reuses existing plumbing: `askStream` (streaming + `AbortSignal`), `searchRanked` (citations), the HITL router (`registeredHitlStreams`), and the `redactPath`/`clampContext` privacy helpers.

**Tech Stack:** TypeScript (strict, no `any`), `@nimbus-dev/client`, VS Code Chat API (`@types/vscode` 1.125), Vitest, esbuild, Biome, Bun.

## Global Constraints

- **TypeScript strict; no `any`** — use `unknown` for external data. Biome enforces `noExplicitAny`, `noNonNullAssertion`.
- **No `console`** anywhere in `src/` (Biome `noConsole`) — log via the injected `Logger` (`errMsg`/`log.warn`/`log.error` from `src/logging.ts`).
- **IPC-only, one Nimbus dependency** — all Gateway calls go through `@nimbus-dev/client` (`askStream`, `searchRanked`). No new dependency; the bundle's only external stays `vscode` (`check-bundle` must stay green).
- **The `vscode` API is touched only in glue files** — pure `chat-participant` modules import no `vscode`; `real-participant.ts` is the single new file that imports `vscode`, mirroring `real-chat-panel.ts` (coverage-excluded, smoke-tested).
- **Participant identity:** id `nimbus-agent.nimbus`, name `nimbus` (typed as `@nimbus`). The `createChatParticipant` id MUST equal the `contributes.chatParticipants[].id`.
- **Reconnect command id:** `nimbus.troubleshootConnection` (already registered).
- **Citation cap:** top 5 (hardcoded `citationLimit: 5`; no new setting).
- **Agent override:** reuse `settings.askAgent()` (empty string ⇒ omit `agent`).
- **Full pre-PR gate:** `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`.
- **Test runner filtering:** `bun run test <substring>` runs `vitest run <substring>` (matches by test file name).

## File Structure

| File | Responsibility | vscode? |
| --- | --- | --- |
| `src/chat-participant/participant-types.ts` | Narrow interfaces shared by the pure modules + adapter | no |
| `src/chat-participant/prompt.ts` | Build the agent prompt per command / attachments (redact + clamp) | no |
| `src/chat-participant/session.ts` | Read prior session id from history metadata; build result metadata | no |
| `src/chat-participant/citations.ts` | `searchRanked` rows → citation refs (self-excluded, capped) | no |
| `src/chat-participant/participant.ts` | `runParticipantTurn`: orchestrate guard → prompt → citations+stream → events → result | no |
| `src/chat-participant/real-participant.ts` | Adapt `vscode.chat` onto the pure handler | **yes** (glue) |
| `src/extension.ts` | Wire `participantDeps` + register (injected, default real) | yes |
| `package.json` | `contributes.chatParticipants` + engine floor | — |
| `test/unit/vscode-stub.ts` | Add a minimal `chat` namespace | — |
| `test/unit/participant-*.test.ts` | Unit tests for the pure modules + wiring | — |

---

### Task 1: Types module + engine floor

**Files:**
- Create: `src/chat-participant/participant-types.ts`
- Modify: `package.json` (bump `engines.vscode`)

**Interfaces:**
- Consumes: `AskStreamHandle`, `AskStreamOptions`, `RankedSearchItem`, `RankedSearchParams` from `@nimbus-dev/client`; `Logger` from `src/logging.ts`.
- Produces: `AttachedFile`, `ParticipantCommand`, `ParticipantRequest`, `CitationRef`, `ChatResponseSink`, `CancellationLike`, `ParticipantClientLike`, `ParticipantDeps`, `ParticipantResult` — the vocabulary every later task uses.

This task has no unit test (types + config only); its gate is typecheck/lint/build.

- [ ] **Step 1: Create the types module**

Create `src/chat-participant/participant-types.ts`:

```ts
import type {
  AskStreamHandle,
  AskStreamOptions,
  RankedSearchItem,
  RankedSearchParams,
} from "@nimbus-dev/client";
import type { Logger } from "../logging.js";

// A code file attached to a turn — an explicit #file reference (free-form) or the
// active editor's selection/whole file (slash commands). The adapter resolves
// these (fs / vscode) so the pure handler stays vscode-free. `path` is the REAL
// local path: redacted before it is sent to the Gateway, and used to self-exclude
// the active file from citations.
export interface AttachedFile {
  path: string;
  languageId: string;
  code: string;
}

export type ParticipantCommand = "explain" | "fix" | "test";

export interface ParticipantRequest {
  prompt: string; // user free text (may be empty for a bare slash command)
  command?: ParticipantCommand;
  attachments: AttachedFile[]; // resolved #file refs (free-form turns)
  selection?: AttachedFile; // active selection / whole file (slash-command turns)
  priorSessionId?: string; // from the prior turn's ChatResult.metadata
}

// A citation carries the REAL local target (opened on click) plus a display
// label. redactPath governs only Gateway-bound prompt context; a citation target
// is a local file the user already has and is never sent anywhere.
export interface CitationRef {
  label: string;
  target: string;
}

export interface ChatResponseSink {
  markdown(text: string): void;
  progress(text: string): void;
  citation(ref: CitationRef): void; // adapter -> response.anchor(uri, label)
  button(title: string, command: string, args?: unknown[]): void; // adapter -> response.button(Command)
}

export interface CancellationLike {
  readonly isCancelled: boolean;
  // Returns a disposable so the handler can unsubscribe in its finally block —
  // a turn that completes without cancelling must not leak the listener.
  onCancelled(cb: () => void): { dispose(): void };
}

export interface ParticipantClientLike {
  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle;
  searchRanked(params?: RankedSearchParams): Promise<RankedSearchItem[]>;
}

export interface ParticipantDeps {
  client(): ParticipantClientLike | undefined; // undefined = disconnected
  registerStreamWithHitl(streamId: string): void;
  unregisterStreamWithHitl(streamId: string): void;
  agent(): string; // askAgent() setting; "" = omit
  citationLimit: number;
  reconnectCommand: string; // e.g. "nimbus.troubleshootConnection"
  log: Logger;
}

// The pure handler returns the resolved session id; the adapter maps it onto
// ChatResult.metadata so the next turn in this conversation can thread it.
export interface ParticipantResult {
  sessionId?: string;
}
```

- [ ] **Step 2: Bump the engine floor (and align the types floor)**

In `package.json`, raise the engines floor so the full `ChatResponseStream` part set (`anchor`, `button`) is guaranteed at runtime:

```json
"engines": {
  "vscode": "^1.95.0"
},
```

Also raise the `@types/vscode` **floor** in `devDependencies` to match — not because typecheck would otherwise fail (the installed `@types/vscode` is already `1.125.0`, which satisfies `^1.90.0` and includes every chat API this plan uses), but so the declared compile-time floor never sits *below* the runtime floor:

```json
"@types/vscode": "^1.95.0",
```

Then sync the lockfile (the resolved version stays `1.125.0` — this only records the new floor):

Run: `bun install`
Expected: completes; `bun.lock` updated to record the `^1.95.0` range; no change to the resolved `@types/vscode` version.

- [ ] **Step 3: Run the gate to verify it compiles**

Run: `bun run typecheck && bun run lint && bun run build && bun run check-bundle`
Expected: all PASS; `check-bundle` still reports `vscode` as the only external.

- [ ] **Step 4: Commit**

```bash
git add src/chat-participant/participant-types.ts package.json bun.lock
git commit -m "feat(chat): participant interfaces + engine floor for Chat API"
```

---

### Task 2: Prompt building

**Files:**
- Create: `src/chat-participant/prompt.ts`
- Test: `test/unit/participant-prompt.test.ts`

**Interfaces:**
- Consumes: `ParticipantRequest`, `AttachedFile`, `ParticipantCommand` (Task 1); `redactPath`, `clampContext`, `QUICK_ASK_MAX_CONTEXT_CHARS` from `src/quick-ask.ts`.
- Produces: `buildParticipantPrompt(req: ParticipantRequest): string`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/participant-prompt.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildParticipantPrompt } from "../../src/chat-participant/prompt.js";
import type { ParticipantRequest } from "../../src/chat-participant/participant-types.js";

function req(over: Partial<ParticipantRequest>): ParticipantRequest {
  return { prompt: "", attachments: [], ...over };
}

describe("buildParticipantPrompt", () => {
  test("free-form with no attachments is just the trimmed prompt", () => {
    expect(buildParticipantPrompt(req({ prompt: "  hello  " }))).toBe("hello");
  });

  test("free-form appends a fenced, path-redacted block per attachment", () => {
    const out = buildParticipantPrompt(
      req({
        prompt: "what is this",
        attachments: [{ path: "/home/me/src/a.ts", languageId: "typescript", code: "const a = 1;" }],
      }),
    );
    expect(out).toContain("what is this");
    expect(out).toContain("File: a.ts (typescript)");
    expect(out).toContain("```typescript\nconst a = 1;\n```");
    expect(out).not.toContain("/home/me"); // absolute path redacted
  });

  test("slash command wraps the selection in the command template", () => {
    const out = buildParticipantPrompt(
      req({
        command: "explain",
        selection: { path: "/x/y/z.py", languageId: "python", code: "def f(): pass" },
      }),
    );
    expect(out.toLowerCase()).toContain("explain");
    expect(out).toContain("File: z.py (python)");
    expect(out).toContain("def f(): pass");
  });

  test("slash command with extra prompt text keeps both instruction and text", () => {
    const out = buildParticipantPrompt(
      req({ command: "fix", prompt: "focus on the loop", selection: { path: "a.ts", languageId: "typescript", code: "x" } }),
    );
    expect(out).toContain("focus on the loop");
    expect(out.toLowerCase()).toContain("fix");
  });

  test("slash command with no selection returns the instruction alone", () => {
    const out = buildParticipantPrompt(req({ command: "test" }));
    expect(out.toLowerCase()).toContain("test");
    expect(out).not.toContain("```");
  });

  test("oversized attachment code is clamped and marked truncated", () => {
    const big = "x".repeat(60_000);
    const out = buildParticipantPrompt(
      req({ prompt: "q", attachments: [{ path: "big.ts", languageId: "typescript", code: big }] }),
    );
    expect(out).toContain("(truncated)");
    expect(out.length).toBeLessThan(big.length); // clamped below the raw size
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test participant-prompt`
Expected: FAIL — `buildParticipantPrompt` is not defined / module not found.

- [ ] **Step 3: Implement the module**

Create `src/chat-participant/prompt.ts`:

```ts
import { clampContext, QUICK_ASK_MAX_CONTEXT_CHARS, redactPath } from "../quick-ask.js";
import type { AttachedFile, ParticipantCommand, ParticipantRequest } from "./participant-types.js";

const COMMAND_TEMPLATES: Record<ParticipantCommand, string> = {
  explain: "Explain what the following code does, clearly and concisely.",
  fix: "Find and fix bugs or issues in the following code. Return the corrected code and a brief explanation of each change. Do not apply edits — just show the suggested code.",
  test: "Write focused unit tests for the following code, following the project's existing test framework and conventions.",
};

// A fenced code block headed by the redacted file path + language, clamped to the
// shared quick-ask size cap so a single turn can't ship an unbounded payload.
function codeBlock(file: AttachedFile): string {
  const { code, truncated } = clampContext(file.code, QUICK_ASK_MAX_CONTEXT_CHARS);
  const suffix = truncated ? " (truncated)" : "";
  const header = `File: ${redactPath(file.path)} (${file.languageId})${suffix}`;
  return `${header}\n\`\`\`${file.languageId}\n${code}\n\`\`\``;
}

// Build the agent prompt. Slash commands wrap the active selection in a
// command-specific instruction; free-form turns append only explicitly attached
// #file references. Paths are always redacted and code is always clamped.
export function buildParticipantPrompt(req: ParticipantRequest): string {
  const userText = req.prompt.trim();

  if (req.command !== undefined) {
    const instruction = COMMAND_TEMPLATES[req.command];
    const head = userText.length > 0 ? `${instruction}\n\n${userText}` : instruction;
    if (req.selection === undefined || req.selection.code.trim().length === 0) return head;
    return `${head}\n\n${codeBlock(req.selection)}`;
  }

  const blocks = req.attachments.filter((a) => a.code.trim().length > 0).map(codeBlock);
  if (blocks.length === 0) return userText;
  return [userText, ...blocks].filter((s) => s.length > 0).join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test participant-prompt`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/chat-participant/prompt.ts test/unit/participant-prompt.test.ts
git commit -m "feat(chat): participant prompt building (redacted + clamped)"
```

---

### Task 3: Session id round-trip

**Files:**
- Create: `src/chat-participant/session.ts`
- Test: `test/unit/participant-session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NIMBUS_SESSION_META_KEY` (string const `"nimbusSessionId"`), `readPriorSessionId(history: ReadonlyArray<unknown>): string | undefined`, `toResultMetadata(sessionId: string | undefined): Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/participant-session.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  NIMBUS_SESSION_META_KEY,
  readPriorSessionId,
  toResultMetadata,
} from "../../src/chat-participant/session.js";

function responseTurn(sessionId?: string): unknown {
  return { result: { metadata: sessionId === undefined ? {} : { [NIMBUS_SESSION_META_KEY]: sessionId } } };
}

describe("readPriorSessionId", () => {
  test("returns undefined for empty history (new conversation)", () => {
    expect(readPriorSessionId([])).toBeUndefined();
  });

  test("returns the session id from the most recent response turn", () => {
    const history = [responseTurn("s1"), { prompt: "user turn, no result" }, responseTurn("s2")];
    expect(readPriorSessionId(history)).toBe("s2");
  });

  test("ignores turns without our metadata and falls back to an earlier one", () => {
    const history = [responseTurn("s1"), responseTurn(undefined)];
    expect(readPriorSessionId(history)).toBe("s1");
  });

  test("ignores non-string / empty metadata values", () => {
    const history = [{ result: { metadata: { [NIMBUS_SESSION_META_KEY]: "" } } }, { result: {} }];
    expect(readPriorSessionId(history)).toBeUndefined();
  });
});

describe("toResultMetadata", () => {
  test("wraps a real session id under the metadata key", () => {
    expect(toResultMetadata("s9")).toEqual({ [NIMBUS_SESSION_META_KEY]: "s9" });
  });

  test("returns an empty object for undefined or empty", () => {
    expect(toResultMetadata(undefined)).toEqual({});
    expect(toResultMetadata("")).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test participant-session`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/chat-participant/session.ts`:

```ts
// Key under which the Nimbus session id rides in ChatResult.metadata, so a
// conversation's follow-up turns thread the same server-side session. This keys
// the session to *this* VS Code conversation (history is per-conversation), so
// concurrent chat tabs never cross-talk — no global map, no cleanup.
export const NIMBUS_SESSION_META_KEY = "nimbusSessionId";

// Minimal structural shape of a history turn we read — matches
// vscode.ChatResponseTurn for the one field we use, so it is unit-testable with
// plain objects.
interface ResultTurnLike {
  result?: { metadata?: Record<string, unknown> };
}

// Walk history newest-first for the most recent turn carrying our session id.
export function readPriorSessionId(history: ReadonlyArray<unknown>): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i] as ResultTurnLike;
    const v = turn?.result?.metadata?.[NIMBUS_SESSION_META_KEY];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

// Build the ChatResult.metadata for a turn that resolved `sessionId`.
export function toResultMetadata(sessionId: string | undefined): Record<string, string> {
  return sessionId !== undefined && sessionId.length > 0 ? { [NIMBUS_SESSION_META_KEY]: sessionId } : {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test participant-session`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/chat-participant/session.ts test/unit/participant-session.test.ts
git commit -m "feat(chat): per-conversation session id via ChatResult.metadata"
```

---

### Task 4: Citations

**Files:**
- Create: `src/chat-participant/citations.ts`
- Test: `test/unit/participant-citations.test.ts`

**Interfaces:**
- Consumes: `CitationRef` (Task 1); `parseRankedItem` from `src/search.ts`; `redactPath` from `src/quick-ask.ts`.
- Produces: `buildCitations(rows: ReadonlyArray<unknown>, opts: { excludeBasename?: string; limit: number }): CitationRef[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/participant-citations.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildCitations } from "../../src/chat-participant/citations.js";

// A searchRanked row shape as parseRankedItem consumes it (name + canonicalUrl).
function row(name: string, canonicalUrl?: string): Record<string, unknown> {
  return { name, service: "fs", score: 0.9, ...(canonicalUrl ? { canonicalUrl } : {}) };
}

describe("buildCitations", () => {
  test("maps rows with a url to {label, target}", () => {
    const out = buildCitations([row("a.ts", "file:///w/a.ts"), row("b.ts", "file:///w/b.ts")], { limit: 5 });
    expect(out).toEqual([
      { label: "a.ts", target: "file:///w/a.ts" },
      { label: "b.ts", target: "file:///w/b.ts" },
    ]);
  });

  test("drops rows without a click target", () => {
    expect(buildCitations([row("no-url")], { limit: 5 })).toEqual([]);
  });

  test("self-excludes the active file by basename", () => {
    const out = buildCitations([row("self.ts", "file:///w/self.ts"), row("other.ts", "file:///w/other.ts")], {
      excludeBasename: "self.ts",
      limit: 5,
    });
    expect(out.map((c) => c.label)).toEqual(["other.ts"]);
  });

  test("caps at the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`f${i}.ts`, `file:///w/f${i}.ts`));
    expect(buildCitations(rows, { limit: 3 })).toHaveLength(3);
  });

  test("skips malformed rows without throwing", () => {
    expect(buildCitations([null, 42, row("ok.ts", "file:///w/ok.ts")], { limit: 5 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test participant-citations`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/chat-participant/citations.ts`:

```ts
import { redactPath } from "../quick-ask.js";
import { parseRankedItem } from "../search.js";
import type { CitationRef } from "./participant-types.js";

// Turn searchRanked rows into clickable citations. Reuses parseRankedItem (the
// same defensive parse the Search / Find-related surfaces use): it maps
// canonicalUrl -> url and drops nameless rows. A citation needs a real target to
// open; rows without one are skipped. The active file is self-excluded by
// basename. Output is capped at `limit`.
export function buildCitations(
  rows: ReadonlyArray<unknown>,
  opts: { excludeBasename?: string; limit: number },
): CitationRef[] {
  const out: CitationRef[] = [];
  for (const raw of rows) {
    if (out.length >= opts.limit) break;
    const r = parseRankedItem(raw);
    if (r === undefined) continue;
    if (r.url === undefined || r.url.length === 0) continue;
    if (opts.excludeBasename !== undefined && redactPath(r.url) === opts.excludeBasename) continue;
    out.push({ label: r.name, target: r.url });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test participant-citations`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/chat-participant/citations.ts test/unit/participant-citations.test.ts
git commit -m "feat(chat): local-index citations from searchRanked rows"
```

---

### Task 5: The participant handler (orchestration)

**Files:**
- Create: `src/chat-participant/participant.ts`
- Test: `test/unit/participant.test.ts`

**Interfaces:**
- Consumes: `ParticipantRequest`, `ParticipantDeps`, `ChatResponseSink`, `CancellationLike`, `ParticipantResult`, `ParticipantClientLike` (Task 1); `buildParticipantPrompt` (Task 2); `buildCitations` (Task 4); `redactPath` from `src/quick-ask.ts`; `errMsg` from `src/logging.ts`; `AskStreamHandle`, `AskStreamOptions`, `StreamEvent` from `@nimbus-dev/client`.
- Produces: `runParticipantTurn(req, deps, sink, cancel): Promise<ParticipantResult>`.

**Note on HITL:** the participant registers its `streamId` with the existing router (`registerStreamWithHitl`); consent surfaces through the shared modal path. In-stream `hitlBatch` events only emit a progress note here (there is no inline chat consent UI in MVP).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/participant.test.ts`. These mirror `chat-controller.test.ts`'s stream-handle helpers and fake-sink pattern:

```ts
import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";
import { runParticipantTurn } from "../../src/chat-participant/participant.js";
import type {
  CancellationLike,
  ChatResponseSink,
  CitationRef,
  ParticipantClientLike,
  ParticipantDeps,
  ParticipantRequest,
} from "../../src/chat-participant/participant-types.js";

// A stream handle that yields a fixed list of events, then completes.
function streamOf(events: StreamEvent[], streamId = "s1"): AskStreamHandle {
  return {
    streamId,
    cancel: vi.fn(async () => undefined),
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          if (i >= events.length) return { value: undefined as never, done: true };
          return { value: events[i++] as StreamEvent, done: false };
        },
      };
    },
  } as unknown as AskStreamHandle;
}

// A capturing fake sink.
function fakeSink(): {
  sink: ChatResponseSink;
  md: string[];
  progress: string[];
  citations: CitationRef[];
  buttons: Array<{ title: string; command: string }>;
} {
  const md: string[] = [];
  const progress: string[] = [];
  const citations: CitationRef[] = [];
  const buttons: Array<{ title: string; command: string }> = [];
  return {
    md,
    progress,
    citations,
    buttons,
    sink: {
      markdown: (t) => md.push(t),
      progress: (t) => progress.push(t),
      citation: (c) => citations.push(c),
      button: (title, command) => buttons.push({ title, command }),
    },
  };
}

const noCancel: CancellationLike = {
  isCancelled: false,
  onCancelled: () => ({ dispose: () => undefined }),
};

function fakeClient(over: Partial<ParticipantClientLike> = {}): ParticipantClientLike {
  return {
    askStream: () => streamOf([{ type: "done", reply: "hi", sessionId: "sess" }]),
    searchRanked: async () => [],
    ...over,
  };
}

function deps(over: Partial<ParticipantDeps> = {}): ParticipantDeps {
  return {
    client: () => fakeClient(),
    registerStreamWithHitl: vi.fn(),
    unregisterStreamWithHitl: vi.fn(),
    agent: () => "",
    citationLimit: 5,
    reconnectCommand: "nimbus.troubleshootConnection",
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...over,
  };
}

function req(over: Partial<ParticipantRequest> = {}): ParticipantRequest {
  return { prompt: "why", attachments: [], ...over };
}

describe("runParticipantTurn", () => {
  test("disconnected → friendly note + reconnect button, no stream started", async () => {
    const f = fakeSink();
    const askStream = vi.fn();
    const searchRanked = vi.fn();
    const client: ParticipantClientLike = { askStream, searchRanked };
    const result = await runParticipantTurn(req(), deps({ client: () => undefined }), f.sink, noCancel);
    expect(f.md.join(" ")).toMatch(/connect/i);
    expect(f.buttons).toEqual([{ title: expect.any(String), command: "nimbus.troubleshootConnection" }]);
    // The disconnected guard must return before touching a client at all.
    expect(client.askStream).not.toHaveBeenCalled();
    expect(client.searchRanked).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  test("streams token events into markdown and returns the session id", async () => {
    const f = fakeSink();
    const client = fakeClient({
      askStream: () =>
        streamOf([
          { type: "token", text: "Hello " },
          { type: "token", text: "world" },
          { type: "done", reply: "Hello world", sessionId: "sess-1" },
        ]),
    });
    const result = await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join("")).toBe("Hello world");
    expect(result).toEqual({ sessionId: "sess-1" });
  });

  test("emits citations from searchRanked", async () => {
    const f = fakeSink();
    const client = fakeClient({
      searchRanked: async () => [
        { name: "a.ts", service: "fs", score: 1, canonicalUrl: "file:///w/a.ts" },
      ] as never,
    });
    await runParticipantTurn(req({ prompt: "auth flow" }), deps({ client: () => client }), f.sink, noCancel);
    expect(f.citations).toEqual([{ label: "a.ts", target: "file:///w/a.ts" }]);
  });

  test("a failing searchRanked does not block the answer", async () => {
    const f = fakeSink();
    const client = fakeClient({
      askStream: () => streamOf([{ type: "token", text: "answer" }, { type: "done", reply: "answer", sessionId: "s" }]),
      searchRanked: async () => {
        throw new Error("index down");
      },
    });
    await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join("")).toContain("answer");
    expect(f.citations).toEqual([]);
  });

  test("threads priorSessionId into the stream options", async () => {
    const seen: AskStreamOptions[] = [];
    const client = fakeClient({
      askStream: (_input, opts) => {
        seen.push(opts ?? {});
        return streamOf([{ type: "done", reply: "", sessionId: "s2" }]);
      },
    });
    await runParticipantTurn(req({ priorSessionId: "prev" }), deps({ client: () => client }), fakeSink().sink, noCancel);
    expect(seen[0]?.sessionId).toBe("prev");
  });

  test("passes the agent setting when non-empty", async () => {
    const seen: AskStreamOptions[] = [];
    const client = fakeClient({
      askStream: (_i, opts) => {
        seen.push(opts ?? {});
        return streamOf([{ type: "done", reply: "", sessionId: "s" }]);
      },
    });
    await runParticipantTurn(req(), deps({ client: () => client, agent: () => "coder" }), fakeSink().sink, noCancel);
    expect(seen[0]?.agent).toBe("coder");
  });

  test("registers and unregisters the stream with HITL", async () => {
    const registerStreamWithHitl = vi.fn();
    const unregisterStreamWithHitl = vi.fn();
    const client = fakeClient({
      askStream: () => streamOf([{ type: "token", text: "x" }, { type: "done", reply: "x", sessionId: "s" }], "stream-9"),
    });
    await runParticipantTurn(
      req(),
      deps({ client: () => client, registerStreamWithHitl, unregisterStreamWithHitl }),
      fakeSink().sink,
      noCancel,
    );
    expect(registerStreamWithHitl).toHaveBeenCalledWith("stream-9");
    expect(unregisterStreamWithHitl).toHaveBeenCalledWith("stream-9");
  });

  test("aborts the stream signal when cancellation fires, then disposes the listener", async () => {
    let onCancel = (): void => undefined;
    const dispose = vi.fn();
    const cancel: CancellationLike = {
      isCancelled: false,
      onCancelled: (cb) => {
        onCancel = cb;
        return { dispose };
      },
    };
    let capturedSignal: AbortSignal | undefined;
    const client = fakeClient({
      askStream: (_i, opts) => {
        capturedSignal = opts?.signal;
        return streamOf([{ type: "done", reply: "", sessionId: "s" }]);
      },
    });
    await runParticipantTurn(req(), deps({ client: () => client }), fakeSink().sink, cancel);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    onCancel();
    expect(capturedSignal?.aborted).toBe(true);
    // The turn already completed, so the listener must have been disposed.
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("an error event surfaces a message and logs it", async () => {
    const f = fakeSink();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const client = fakeClient({ askStream: () => streamOf([{ type: "error", code: "E", message: "kaboom" }]) });
    await runParticipantTurn(req(), deps({ client: () => client, log }), f.sink, noCancel);
    expect(f.md.join(" ")).toContain("kaboom");
    expect(log.error).toHaveBeenCalled();
  });

  test("a stream that ends with no content shows the no-LLM notice", async () => {
    const f = fakeSink();
    const client = fakeClient({ askStream: () => streamOf([{ type: "done", reply: "", sessionId: "" }]) });
    await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join(" ")).toMatch(/no answer|LLM provider|Gateway/i);
  });

  test("a thrown mid-stream error is surfaced, not swallowed", async () => {
    const f = fakeSink();
    const throwing = {
      streamId: "s1",
      cancel: vi.fn(async () => undefined),
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            throw new Error("No LLM provider available");
          },
        };
      },
    } as unknown as AskStreamHandle;
    const client = fakeClient({ askStream: () => throwing });
    await runParticipantTurn(req(), deps({ client: () => client }), f.sink, noCancel);
    expect(f.md.join(" ")).toContain("No LLM provider available");
  });

  test("empty prompt with no context nudges the user, no stream", async () => {
    const f = fakeSink();
    const askStream = vi.fn();
    await runParticipantTurn(req({ prompt: "   " }), deps({ client: () => fakeClient({ askStream }) }), f.sink, noCancel);
    expect(askStream).not.toHaveBeenCalled();
    expect(f.md.join(" ")).toMatch(/ask me|\/explain/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test participant.test`
Expected: FAIL — `runParticipantTurn` not defined.

- [ ] **Step 3: Implement the handler**

Create `src/chat-participant/participant.ts`:

```ts
import type { AskStreamHandle, AskStreamOptions } from "@nimbus-dev/client";
import { errMsg } from "../logging.js";
import { redactPath } from "../quick-ask.js";
import { buildCitations } from "./citations.js";
import type {
  CancellationLike,
  ChatResponseSink,
  ParticipantClientLike,
  ParticipantDeps,
  ParticipantRequest,
  ParticipantResult,
} from "./participant-types.js";
import { buildParticipantPrompt } from "./prompt.js";

const NO_LLM_NOTICE =
  "Nimbus reached the Gateway, but no answer came back — this usually means no language model is set up yet. Add an LLM provider (or API key) in your Gateway configuration, then try again.";

// Fetch citations for the query and emit them; best-effort, never throws. Kept
// separate so the caller can start it WITHOUT awaiting, letting the answer stream
// while the search resolves in parallel.
async function emitCitations(
  client: ParticipantClientLike,
  deps: ParticipantDeps,
  sink: ChatResponseSink,
  query: string,
  excludeBasename: string | undefined,
): Promise<void> {
  const q = query.trim();
  if (q.length === 0) return;
  try {
    const rows = await client.searchRanked({ name: q, limit: deps.citationLimit });
    for (const c of buildCitations(rows as unknown[], { excludeBasename, limit: deps.citationLimit })) {
      sink.citation(c);
    }
  } catch (e) {
    deps.log.warn(`participant: searchRanked failed: ${errMsg(e)}`);
  }
}

export async function runParticipantTurn(
  req: ParticipantRequest,
  deps: ParticipantDeps,
  sink: ChatResponseSink,
  cancel: CancellationLike,
): Promise<ParticipantResult> {
  const client = deps.client();
  if (client === undefined) {
    sink.markdown(
      "Nimbus isn't connected to the Gateway right now, so I can't answer. Start or reconnect the Gateway, then try again.",
    );
    sink.button("Troubleshoot connection", deps.reconnectCommand);
    return {};
  }

  const prompt = buildParticipantPrompt(req);
  if (prompt.trim().length === 0) {
    sink.markdown("Ask me a question, or run `/explain`, `/fix`, or `/test` on a selection.");
    return {};
  }

  // Start citations WITHOUT awaiting — they resolve in parallel with the stream
  // so the first token is never delayed. Await it at the end so late references
  // still land before the turn completes.
  const excludeBasename = req.selection !== undefined ? redactPath(req.selection.path) : undefined;
  const citations = emitCitations(client, deps, sink, req.prompt, excludeBasename);

  const opts: AskStreamOptions = {};
  if (req.priorSessionId !== undefined && req.priorSessionId.length > 0) opts.sessionId = req.priorSessionId;
  const agentName = deps.agent();
  if (agentName.length > 0) opts.agent = agentName;

  const ac = new AbortController();
  // Track the cancellation subscription so it is disposed on every exit path — a
  // turn that finishes without being cancelled must not leak the listener.
  let cancelSub: { dispose(): void } | undefined;
  if (cancel.isCancelled) ac.abort();
  else cancelSub = cancel.onCancelled(() => ac.abort());
  opts.signal = ac.signal;

  let handle: AskStreamHandle;
  try {
    handle = client.askStream(prompt, opts);
  } catch (e) {
    cancelSub?.dispose();
    deps.log.error(`participant: askStream failed to start: ${errMsg(e)}`);
    sink.markdown(`Nimbus couldn't start the request: ${errMsg(e)}`);
    await citations;
    return {};
  }

  let sessionId: string | undefined;
  let sawContent = false;
  let registered = false;
  try {
    for await (const ev of handle) {
      if (ev.type !== "done") sawContent = true;
      if (!registered && handle.streamId.length > 0) {
        deps.registerStreamWithHitl(handle.streamId);
        registered = true;
      }
      if (ev.type === "token") {
        sink.markdown(ev.text);
      } else if (ev.type === "subTaskProgress") {
        sink.progress(ev.status);
      } else if (ev.type === "hitlBatch") {
        // Consent is collected out-of-band by the shared HITL modal router (via
        // registerStreamWithHitl). Just tell the user what's happening.
        sink.progress("Waiting for your approval…");
      } else if (ev.type === "error") {
        sink.markdown(`Nimbus ran into a problem: ${ev.message}`);
        deps.log.error(`participant stream error: ${ev.code}: ${ev.message}`);
        break;
      } else if (ev.type === "done") {
        if (ev.sessionId.length > 0) sessionId = ev.sessionId;
        break;
      }
    }
    if (!sawContent) sink.markdown(NO_LLM_NOTICE);
  } catch (e) {
    deps.log.error(`participant: stream failed: ${errMsg(e)}`);
    sink.markdown(
      `Nimbus ran into a problem answering: ${errMsg(e)}. If that mentions a missing model or invalid API key, set up an LLM provider in your Gateway and try again.`,
    );
  } finally {
    if (handle.streamId.length > 0) deps.unregisterStreamWithHitl(handle.streamId);
    cancelSub?.dispose();
  }

  await citations;
  return sessionId !== undefined ? { sessionId } : {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test participant.test`
Expected: PASS (12 tests).

- [ ] **Step 5: Run typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS (no `any`, no `console`).

- [ ] **Step 6: Commit**

```bash
git add src/chat-participant/participant.ts test/unit/participant.test.ts
git commit -m "feat(chat): participant turn orchestration over askStream"
```

---

### Task 6: Real adapter, manifest contribution, and wiring

**Files:**
- Create: `src/chat-participant/real-participant.ts`
- Modify: `src/extension.ts` (imports, `ActivateDeps`, wiring in `activateWithDeps`)
- Modify: `package.json` (`contributes.chatParticipants`)
- Modify: `test/unit/vscode-stub.ts` (add a `chat` namespace)
- Modify: `vitest.config.ts` / coverage config — add `real-participant.ts` to coverage exclusions (mirror `real-chat-panel.ts`)
- Test: `test/unit/participant-registration.test.ts`

**Interfaces:**
- Consumes: `runParticipantTurn` (Task 5); `readPriorSessionId`, `toResultMetadata` (Task 3); `ParticipantDeps`, `ParticipantRequest`, `AttachedFile`, `ParticipantCommand`, `ChatResponseSink`, `CancellationLike` (Task 1); `Logger`, `errMsg` from `src/logging.ts`.
- Produces: `registerNimbusChatParticipant(opts: { deps: ParticipantDeps; log: Logger }): { dispose(): void }`; a new optional `ActivateDeps.registerChatParticipant` seam (default = real).

- [ ] **Step 1: Add a `chat` namespace to the vscode stub**

In `test/unit/vscode-stub.ts`, add near the other exports (e.g. after `commands`):

```ts
export const chat = {
  createChatParticipant: (_id: string, _handler: unknown) => ({
    dispose: () => undefined,
  }),
};
```

- [ ] **Step 2: Write the failing wiring test**

Create `test/unit/participant-registration.test.ts`. It asserts that `activateWithDeps` registers a participant via the injected seam (so we don't depend on the real `vscode.chat` in this test):

```ts
import { describe, expect, test, vi } from "vitest";
import { activateWithDeps } from "../../src/extension.js";
import * as stub from "./vscode-stub.js";

type ActivateDeps = Parameters<typeof activateWithDeps>[1];

function ctx(): Parameters<typeof activateWithDeps>[0] {
  return {
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as Parameters<typeof activateWithDeps>[0];
}

describe("chat participant registration", () => {
  test("activateWithDeps registers a participant with sane deps", () => {
    const registerChatParticipant = vi.fn(() => ({ dispose: () => undefined }));
    const deps = {
      window: stub.window,
      workspace: stub.workspace,
      commands: stub.commands,
      chatPanelFactory: () => ({
        createOrReveal: () => ({}),
        current: () => undefined,
      }),
      registerChatParticipant,
    } as unknown as ActivateDeps;

    activateWithDeps(ctx(), deps);

    expect(registerChatParticipant).toHaveBeenCalledTimes(1);
    const arg = registerChatParticipant.mock.calls[0]?.[0] as {
      deps: { citationLimit: number; reconnectCommand: string };
    };
    expect(arg.deps.citationLimit).toBe(5);
    expect(arg.deps.reconnectCommand).toBe("nimbus.troubleshootConnection");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test participant-registration`
Expected: FAIL — `registerChatParticipant` is never called (seam does not exist yet).

- [ ] **Step 4: Implement the real adapter**

Create `src/chat-participant/real-participant.ts`:

```ts
import * as vscode from "vscode";
import { errMsg, type Logger } from "../logging.js";
import type {
  AttachedFile,
  ChatResponseSink,
  ParticipantCommand,
  ParticipantDeps,
  ParticipantRequest,
} from "./participant-types.js";
import { runParticipantTurn } from "./participant.js";
import { readPriorSessionId, toResultMetadata } from "./session.js";

// Thin vscode-API glue — mirrors real-chat-panel.ts. Excluded from coverage; the
// pure handler (participant.ts) carries the logic and the tests.

const PARTICIPANT_ID = "nimbus-agent.nimbus";

function normalizeCommand(c: string | undefined): ParticipantCommand | undefined {
  return c === "explain" || c === "fix" || c === "test" ? c : undefined;
}

function readActiveSelection(): AttachedFile | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return undefined;
  const doc = editor.document;
  const code = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
  return { path: doc.fileName, languageId: doc.languageId, code };
}

function refToUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value instanceof vscode.Location) return value.uri;
  return undefined;
}

async function resolveReferences(
  refs: ReadonlyArray<vscode.ChatPromptReference>,
  log: Logger,
): Promise<AttachedFile[]> {
  const out: AttachedFile[] = [];
  for (const ref of refs) {
    const uri = refToUri(ref.value);
    if (uri === undefined) continue;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      out.push({ path: doc.fileName, languageId: doc.languageId, code: doc.getText() });
    } catch (e) {
      log.warn(`participant: could not read reference ${uri.toString()}: ${errMsg(e)}`);
    }
  }
  return out;
}

async function adaptRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  log: Logger,
): Promise<ParticipantRequest> {
  const command = normalizeCommand(request.command);
  const priorSessionId = readPriorSessionId(context.history);
  const req: ParticipantRequest = { prompt: request.prompt, attachments: [] };
  if (priorSessionId !== undefined) req.priorSessionId = priorSessionId;
  if (command !== undefined) {
    req.command = command;
    const sel = readActiveSelection();
    if (sel !== undefined) req.selection = sel;
  } else {
    req.attachments = await resolveReferences(request.references, log);
  }
  return req;
}

// canonicalUrl may be a scheme URL (https://…) or a bare local path.
function targetToUri(target: string): vscode.Uri {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? vscode.Uri.parse(target) : vscode.Uri.file(target);
}

function adaptSink(response: vscode.ChatResponseStream): ChatResponseSink {
  return {
    markdown: (t) => response.markdown(t),
    progress: (t) => response.progress(t),
    citation: (c) => response.anchor(targetToUri(c.target), c.label),
    button: (title, command, args) => response.button({ title, command, arguments: args ?? [] }),
  };
}

export function registerNimbusChatParticipant(opts: {
  deps: ParticipantDeps;
  log: Logger;
}): { dispose(): void } {
  const handler: vscode.ChatRequestHandler = async (request, context, response, token) => {
    const req = await adaptRequest(request, context, opts.log);
    const sink = adaptSink(response);
    const cancel = {
      get isCancelled(): boolean {
        return token.isCancellationRequested;
      },
      // Return the vscode.Disposable so runParticipantTurn can dispose it — the
      // token outlives a normally-completing turn, so an undisposed listener leaks.
      onCancelled: (cb: () => void): { dispose(): void } => token.onCancellationRequested(cb),
    };
    const result = await runParticipantTurn(req, opts.deps, sink, cancel);
    return { metadata: toResultMetadata(result.sessionId) };
  };
  return vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
}
```

**Attached-file size (deferred, by design):** `resolveReferences` calls
`openTextDocument` then `getText()`, which loads the whole referenced file into
memory before `prompt.ts` clamps it — a very large `#file` could cause a brief
stutter. An explicit `fs.stat` pre-check is deliberately **not** added for the
MVP (YAGNI): VS Code's `openTextDocument` already rejects files over its max size
(~50 MB by default), and that rejection is caught by the `try/catch` above —
oversized references are logged and skipped, not loaded. The prompt-side
`clampContext` bounds what is actually sent. This is recorded as a known
performance risk; a size-aware skip is a cheap future follow-up if it ever bites.

- [ ] **Step 5: Wire it into `extension.ts`**

Add the import near the other `chat/` imports (after line 8's `createSessionStore` import):

```ts
import { registerNimbusChatParticipant } from "./chat-participant/real-participant.js";
import type { ParticipantClientLike, ParticipantDeps } from "./chat-participant/participant-types.js";
```

Add the optional seam to `ActivateDeps` (in the interface around line 88, next to `chatPanelFactory`):

```ts
  registerChatParticipant?: (opts: {
    deps: ParticipantDeps;
    log: Logger;
  }) => { dispose(): void };
```

Then, in `activateWithDeps`, AFTER the `hitlRouter` block and the `registeredHitlStreams` set are defined (place it just before `register("nimbus.showPendingHitl", …)` near the end, so all closures it references — `nimbus`, `registeredHitlStreams`, `settings` — exist):

```ts
  const participantDeps: ParticipantDeps = {
    client: () => nimbus() as unknown as ParticipantClientLike | undefined,
    registerStreamWithHitl: (id) => registeredHitlStreams.add(id),
    unregisterStreamWithHitl: (id) => {
      registeredHitlStreams.delete(id);
    },
    agent: () => settings.askAgent(),
    citationLimit: 5,
    reconnectCommand: "nimbus.troubleshootConnection",
    log,
  };
  const registerParticipant = deps.registerChatParticipant ?? registerNimbusChatParticipant;
  ctx.subscriptions.push(registerParticipant({ deps: participantDeps, log }));
```

- [ ] **Step 6: Declare the participant in `package.json`**

Add a `chatParticipants` array to `contributes` (sibling of `commands`):

```json
"chatParticipants": [
  {
    "id": "nimbus-agent.nimbus",
    "name": "nimbus",
    "fullName": "Nimbus",
    "description": "Ask the local Nimbus agent — grounded in your local index",
    "isSticky": true,
    "commands": [
      { "name": "explain", "description": "Explain the selected code" },
      { "name": "fix", "description": "Suggest a fix for the selected code" },
      { "name": "test", "description": "Generate tests for the selected code" }
    ]
  }
]
```

- [ ] **Step 7: Exclude the adapter from coverage**

In `vitest.config.ts`, find the coverage `exclude` list that already names `real-chat-panel.ts` (and `vscode-shim.ts`) and add the new glue file next to it:

```ts
      "src/chat-participant/real-participant.ts",
```

(If `real-chat-panel.ts` is matched by a glob rather than a literal, no change is needed — confirm by reading the config first.)

- [ ] **Step 8: Run the wiring test + full gate**

Run: `bun run test participant-registration`
Expected: PASS (1 test).

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
Expected: all PASS. `check-bundle` still reports `vscode` as the only external (the new pure modules are inlined; `real-participant.ts` only imports the external `vscode`).

- [ ] **Step 9: Commit**

```bash
git add src/chat-participant/real-participant.ts src/extension.ts package.json test/unit/vscode-stub.ts test/unit/participant-registration.test.ts vitest.config.ts
git commit -m "feat(chat): register @nimbus participant and wire the adapter"
```

---

### Task 7: Docs, changelog, and end-to-end verification

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `CLAUDE.md`, `docs/ROADMAP.md`, `CHANGELOG.md`

**Interfaces:** none (documentation + manual verification).

- [ ] **Step 1: Update the surface docs**

- `README.md`: add a bullet under the feature list describing the `@nimbus` Chat participant (`/explain`, `/fix`, `/test`, `#file`/selection context, local-index citations).
- `docs/architecture.md`: add the participant to the "Current surface" paragraph, and add a `src/chat-participant/` row to the Module map ("Chat participant: pure turn handler + the `real-participant.ts` vscode-glue adapter").
- `CLAUDE.md`: add `@nimbus` Chat participant to the "Surface today" sentence.
- `docs/ROADMAP.md`: move the "Native VS Code Chat participant" row from Phase 2 into the "Already shipped (baseline)" table (enabling RPCs `askStream` / `searchRanked`), and note completion under Phase 2.
- `CHANGELOG.md`: add an entry under the unreleased/next section: `feat: native @nimbus VS Code Chat participant (/explain, /fix, /test; #file + selection context; streaming; local-index citations)`.

- [ ] **Step 2: Commit the docs**

```bash
git add README.md docs/architecture.md CLAUDE.md docs/ROADMAP.md CHANGELOG.md
git commit -m "docs(chat): document the @nimbus Chat participant"
```

- [ ] **Step 3: Layer 1 verification gate (verify-extension)**

Run the full gate:

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-bundle`
Expected: all PASS.

- [ ] **Step 4: Layer 2 verification in an Extension Development Host (verify-extension)**

Invoke the **verify-extension** skill and drive the runtime surface:

1. `bun run build`, then press **F5** to launch the Extension Development Host (a Nimbus Gateway must be running for a real answer).
2. Open the Chat view, type `@nimbus explain what this function does`, attach a `#file`, and confirm: the answer **streams** token-by-token, and **citation chips** appear referencing local index items.
3. Select code in an editor, run `@nimbus /explain` (and `/fix`, `/test`), confirm the selection is used and the answer streams.
4. Start a turn and press **Stop** — confirm the stream cancels.
5. Ask a follow-up in the same conversation — confirm continuity (session threading), then open a **second** chat and confirm it starts fresh (no cross-talk).
6. Stop the Gateway (or disconnect) and send a turn — confirm the friendly "not connected" message + **Troubleshoot connection** button (which runs `nimbus.troubleshootConnection`).

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/chat-participant
gh pr create --title "feat(chat): native @nimbus VS Code Chat participant" --body "$(cat <<'EOF'
Adds a native `@nimbus` participant to VS Code's built-in Chat view, backed by the local Nimbus agent over `askStream`.

- Slash commands `/explain`, `/fix`, `/test` (operate on the active selection/file)
- `#file` reference context for free-form questions
- Live token streaming; Stop cancels via `askStream`'s `AbortSignal`
- Clickable local-index citations via `searchRanked`
- Mid-stream HITL through the existing modal router
- Per-conversation session isolation via `ChatResult.metadata`
- Additive: the existing Ask panel is unchanged

Spec: `docs/superpowers/specs/2026-07-18-chat-participant-design.md`
Plan: `docs/superpowers/plans/2026-07-18-chat-participant.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Release Please will open/update the release PR from the conventional commits.

---

## Self-Review

**Spec coverage:**
- Backing RPC `askStream` → Task 5. ✅
- `/explain` `/fix` `/test` → Task 2 (templates) + Task 6 (manifest + command routing). ✅
- `#file` + selection context → Task 6 (`resolveReferences`, `readActiveSelection`) + Task 2 (prompt). ✅
- Client-side `searchRanked` citations, concurrent, best-effort → Task 4 + Task 5 (`emitCitations`, not awaited before stream). ✅
- Citation real target vs. label; `anchor(uri, label)` → Task 1 (`CitationRef`) + Task 6 (`adaptSink`). ✅
- Per-conversation session via `ChatResult.metadata` → Task 3 + Task 6. ✅
- HITL via existing modal router (`registerStreamWithHitl`) → Task 5 + Task 6 wiring. ✅
- Disconnected guard + `button` to `nimbus.troubleshootConnection` → Task 5 + Task 6. ✅
- Error/no-content taxonomy mirrors `chat-controller.ts` → Task 5. ✅
- Privacy: `redactPath` + `clampContext` → Task 2. ✅
- `vscode` seam / no new bundle external / no new dep → Task 6 (`real-participant.ts` only) + `check-bundle` steps. ✅
- Coexistence with Ask panel (own session, no changes) → confirmed by isolated `participantDeps`. ✅
- Docs + ROADMAP move → Task 7. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows real assertions; every run step shows the exact command and expected result.

**Type consistency:** `runParticipantTurn(req, deps, sink, cancel)` signature is identical across Tasks 5 and 6. `ParticipantDeps` fields (`client`, `registerStreamWithHitl`, `unregisterStreamWithHitl`, `agent`, `citationLimit`, `reconnectCommand`, `log`) match between Task 1, the Task 5 fake, and the Task 6 wiring. `CitationRef` (`label`/`target`) is consistent across Tasks 1, 4, 6. `readPriorSessionId`/`toResultMetadata`/`NIMBUS_SESSION_META_KEY` names match between Task 3 and Task 6. `buildParticipantPrompt` and `buildCitations` signatures match their consumers.

**Note on `vitest.config.ts` (Task 6, Step 7):** confirmed `real-chat-panel.ts` is excluded as a literal path in the coverage `exclude` list, so the new `real-participant.ts` literal must be added there.

## Review disposition (2026-07-18)

Dispositions for [`2026-07-18-chat-participant-feedback.md`](./2026-07-18-chat-participant-feedback.md), each verified against the installed toolchain:

1. **`@types/vscode` bump — FIXED (mechanism), REJECTED (stated reasoning).** The
   premise is wrong: `@types/vscode` `1.125.0` **is** installed and already
   satisfies the existing `^1.90.0` range, and it includes every chat API this
   plan uses (`button`, `anchor`, `ChatResult.metadata`) — so `bun run typecheck`
   would **not** fail. But aligning the compile-time floor with the new runtime
   floor is good hygiene, so Task 1 Step 2 now raises `@types/vscode` to `^1.95.0`
   and runs `bun install` to sync `bun.lock` (resolved version unchanged).
2. **Cancellation listener leak — FIXED.** Correct catch.
   `CancellationLike.onCancelled` now returns `{ dispose(): void }`;
   `runParticipantTurn` tracks the subscription and disposes it on every exit path
   (Task 1 interface, Task 5 handler + test, Task 6 adapter returns the
   `token.onCancellationRequested` disposable).
3. **Large attached-file performance — DEFERRED (documented).** Legitimate but
   minor, and the feedback itself scoped it as post-MVP. No `fs.stat` pre-check is
   added (YAGNI): `openTextDocument` already rejects oversized files and the
   existing `try/catch` logs-and-skips them, while `clampContext` bounds what is
   sent. Recorded as a known perf risk in Task 6 with a cheap follow-up noted.
