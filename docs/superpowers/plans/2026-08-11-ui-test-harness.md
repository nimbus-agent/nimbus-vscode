# UI Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual Extension Development Host pass with an automated suite that drives a real VS Code against a fake Gateway, covering all six built-in briefs end to end.

**Architecture:** ExTester (Selenium) drives a real VS Code opened on a checked-in fixture workspace. A test-only `net` server speaks the Gateway's real wire protocol (NDJSON JSON-RPC) on a socket the fixture workspace points `nimbus.socketPath` at. The fake records every request, so specs assert at the wire what unit tests can only approximate.

**Tech Stack:** `vscode-extension-tester` 8.23.0, Mocha, TypeScript (compiled to CommonJS for Mocha), Node `net`, bun.

**Spec:** [docs/superpowers/specs/2026-08-11-ui-test-harness-design.md](../specs/2026-08-11-ui-test-harness-design.md). Read it first — it carries the reasoning this plan executes.

## Global Constraints

- TypeScript **strict**, **no `any`** — `unknown` for external data. Biome enforces `noExplicitAny`, `noNonNullAssertion`. `noConsole` applies to `src/` only; `test/` may log.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are ON. Build optional properties with a conditional spread; indexed access yields `T | undefined`.
- `tsconfig.json` includes `test/**/*`, so **everything under `test/ui/` is typechecked by `bun run typecheck`**. This is deliberate — it is how canned brief fixtures typed as real SDK types catch shape drift.
- `vitest.config.ts` includes **only** `test/unit/**/*.test.ts`. UI specs under `test/ui/` are therefore invisible to `bun run test`. Do not widen that include.
- `.vscodeignore` is an allowlist beginning with `**`, so new directories cannot leak into the `.vsix`. **Do not add ignore entries** for `test/ui`, `out/` or `test-resources/` — they are already excluded, and `check-vsix-contents` enforces it from the other side.
- Never hand-edit `CHANGELOG.md` — Release Please writes it from the PR title.
- Branch is `feat/briefs-pr3`. Commit after every task.
- Per-task verification: `bun run typecheck` and `bun run lint` always; `bun run test` for tasks touching `test/unit/`; `bun run test:ui` from Task 2 onward.

## Verified protocol facts (do not re-derive)

Checked against `@nimbus-dev/client` 0.15.1 while writing this plan:

- **Framing:** NDJSON — one JSON-RPC 2.0 object per line, terminated by `\n`.
- **Connect:** `NimbusClient.open` awaits a plain socket connect. No handshake RPC. A server that listens is enough to appear connected.
- **Briefs are two-step:** request `agents.<agent>` → respond `{ sessionId }`, then send a **notification** `<agent>.briefReady` with `{ sessionId, brief, findings }`, or `<agent>.briefError` with `{ sessionId, error }` (`nimbus-client.js:99-100,144`). Answering only the request hangs the call for 30 s.
- **`agents.whyPeek` is NOT two-step** (`nimbus-client.js:197-201`): it is a direct request/response returning a `WhyPeek` object.
- **Agent names** are the method suffix: `agents.conflicts` → `conflicts.briefReady` (note: the *brief kind* is `"conflict"` singular, but the *agent name* is `conflicts` — use the agent name for the notification).
- **Windows named pipes work.** Verified on win32: `\\.\pipe\<name>` carried the full two-step exchange.

## File Structure

**Create**
- `test/ui/fake-gateway.ts` — the fake server. One responsibility: speak the protocol, record requests, allow queued errors.
- `test/ui/fixtures/briefs.ts` — canned brief payloads, each typed as its real SDK type.
- `test/ui/fixture-workspace/src/session.ts`, `.../src/auth.ts` — files briefs run against.
- `test/ui/fixture-workspace/.vscode/settings.json` — points `nimbus.socketPath` at the fake.
- `test/ui/specs/smoke.test.ts`, `briefs-no-send.test.ts`, `briefs-gated.test.ts`, `participant.test.ts`
- `test/unit/ui-fake-gateway.test.ts` — vitest tests for the fake itself (lives in `test/unit/` so `bun run test` runs it)
- `tsconfig.ui.json`, `.mocharc.ui.js`, `scripts/run-ui-tests.mjs`

**Modify**
- `package.json` — devDependencies + `test:ui` script
- `.gitignore` — `out/`, `test-resources/`
- `.github/workflows/ci.yml` — a `ui-test` job

---

### Task 1: The fake Gateway

**Files:**
- Create: `test/ui/fake-gateway.ts`, `test/ui/fixtures/briefs.ts`
- Test: `test/unit/ui-fake-gateway.test.ts`

**Interfaces:**
- Produces:
  - `createFakeGateway(): FakeGateway`
  - `interface FakeGateway { readonly socketPath: string; start(): Promise<void>; stop(): Promise<void>; requests(): readonly RecordedRequest[]; queueError(method: string, detail: string): void; reset(): void; }`
  - `interface RecordedRequest { method: string; params: unknown }`
  - From `fixtures/briefs.ts`: `WHY_BRIEF`, `GHOST_BRIEF`, `CONFLICT_BRIEF`, `HUDDLE_BRIEF`, `JANITOR_BRIEF`, `PREFLIGHT_BRIEF`, `WHY_PEEK`, each typed as its SDK type.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/ui-fake-gateway.test.ts`:

```ts
import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { createFakeGateway, type FakeGateway } from "../ui/fake-gateway.js";

let gw: FakeGateway | undefined;

afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

// Speaks the same NDJSON the real client speaks: one JSON object per line.
function call(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; notifications: unknown[] }> {
  return new Promise((resolve, reject) => {
    const notifications: unknown[] = [];
    let result: unknown;
    const sock = net.connect(socketPath, () => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; method?: string };
        if (msg.id === 1) result = msg.result;
        else notifications.push(msg);
      }
      // A brief is done when the response AND its notification have arrived.
      if (result !== undefined && notifications.length > 0) {
        sock.end();
        resolve({ result, notifications });
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("fake gateway did not answer")), 3000);
  });
}

describe("fake gateway", () => {
  test("a brief answers with a sessionId and then a briefReady notification", async () => {
    gw = createFakeGateway();
    await gw.start();
    const { result, notifications } = await call(gw.socketPath, "agents.janitor", {
      resourceRef: "svc/legacy",
    });
    expect(result).toEqual({ sessionId: expect.any(String) });
    const note = notifications[0] as { method: string; params: { findings: { kind: string } } };
    expect(note.method).toBe("janitor.briefReady");
    expect(note.params.findings.kind).toBe("janitor");
  });

  // The agent name, not the brief kind: agents.conflicts emits conflicts.briefReady
  // even though the brief's own `kind` is the singular "conflict".
  test("the notification is named for the agent, not the brief kind", async () => {
    gw = createFakeGateway();
    await gw.start();
    const { notifications } = await call(gw.socketPath, "agents.conflicts", { file: "a.ts" });
    expect((notifications[0] as { method: string }).method).toBe("conflicts.briefReady");
  });

  test("a queued error emits briefError instead", async () => {
    gw = createFakeGateway();
    await gw.start();
    gw.queueError("agents.preflight", "namespace not found");
    const { notifications } = await call(gw.socketPath, "agents.preflight", {
      ref: "r",
      namespace: "n",
    });
    const note = notifications[0] as { method: string; params: { error: string } };
    expect(note.method).toBe("preflight.briefError");
    expect(note.params.error).toBe("namespace not found");
  });

  test("every request is recorded with its params", async () => {
    gw = createFakeGateway();
    await gw.start();
    await call(gw.socketPath, "agents.why", { ref: "src/a.ts", line: 7 });
    expect(gw.requests()).toEqual([{ method: "agents.why", params: { ref: "src/a.ts", line: 7 } }]);
  });

  test("reset clears recorded requests and queued errors", async () => {
    gw = createFakeGateway();
    await gw.start();
    gw.queueError("agents.janitor", "boom");
    await call(gw.socketPath, "agents.why", { ref: "a.ts" });
    gw.reset();
    expect(gw.requests()).toEqual([]);
    const { notifications } = await call(gw.socketPath, "agents.janitor", { resourceRef: "x" });
    expect((notifications[0] as { method: string }).method).toBe("janitor.briefReady");
  });

  test("two gateways never collide on a socket path", () => {
    const a = createFakeGateway();
    const b = createFakeGateway();
    expect(a.socketPath).not.toBe(b.socketPath);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/ui-fake-gateway.test.ts`
Expected: FAIL — cannot resolve `../ui/fake-gateway.js`.

- [ ] **Step 3: Write the fixtures**

Create `test/ui/fixtures/briefs.ts`. Type each constant with its real SDK type — that is what makes a client bump fail `typecheck` instead of passing against a fiction.

**Do not add an `as WhyBrief`-style cast to these constants.** The type annotation is the entire drift guard; a trailing `as X` suppresses precisely the errors it exists to raise, and the fixture would then pass against a shape the SDK no longer has. (`test/unit/briefs-render.test.ts` does use that cast, because its fixtures are deliberately partial — these are complete, so they do not need it.) If a fixture will not compile without a cast, the fixture is wrong: fix the fixture to match the real type rather than silencing the compiler. The code below is written without casts for this reason.

```ts
import type {
  ConflictBrief,
  GhostBrief,
  HuddleBrief,
  JanitorBrief,
  PreflightBrief,
  WhyBrief,
  WhyPeek,
} from "@nimbus-dev/client";

const BASE = { agentVersion: 1 as const, generatedAt: 0, latencyMs: 5, gaps: [] };

export const WHY_BRIEF: WhyBrief = {
  ...BASE,
  kind: "why",
  query: { ref: "src/session.ts", line: 3 },
  subject: null,
  findings: [
    { lane: "pull_request", title: "PR #42 — add session cache", detail: "merged", url: null },
  ],
};

export const GHOST_BRIEF: GhostBrief = {
  ...BASE,
  kind: "ghost",
  query: { file: "src/session.ts" },
  startEntityId: null,
  findings: [
    { peerId: "p1", expert: "Dana", rank: "high", context: [], suggestedContact: "dana@example.com" },
  ],
};

export const CONFLICT_BRIEF: ConflictBrief = {
  ...BASE,
  kind: "conflict",
  query: { file: "src/session.ts" },
  startEntityId: null,
  collisions: [],
};

export const HUDDLE_BRIEF: HuddleBrief = {
  ...BASE,
  kind: "huddle",
  query: { sinceMs: 86_400_000 },
  contributions: [],
};

export const JANITOR_BRIEF: JanitorBrief = {
  ...BASE,
  kind: "janitor",
  query: { resourceRef: "svc/legacy-billing", idleDays: 90 },
  idle: true,
  proposalSuppressed: false,
  cleanupAction: null,
  peersClear: 0,
  peersTouched: [],
};

export const PREFLIGHT_BRIEF: PreflightBrief = {
  ...BASE,
  kind: "preflight",
  query: { ref: "release-1.4", namespace: "billing" },
  downstreams: [],
  anyFailed: false,
  anyIncomplete: false,
};

export const WHY_PEEK: WhyPeek = {
  subject: { repoRoot: "/fixture", filePath: "src/session.ts", lineNo: 3 },
  author: "Dana",
  authorEmail: "dana@example.com",
  commitSha: "abc1234",
  committedAt: 0,
  commitSubject: "add session cache",
  pr: null,
  ticket: null,
  hasMore: false,
};

/** agent name (the `agents.<name>` suffix) → the findings it answers with. */
export const BRIEF_BY_AGENT: Record<string, unknown> = {
  why: WHY_BRIEF,
  ghost: GHOST_BRIEF,
  conflicts: CONFLICT_BRIEF,
  huddle: HUDDLE_BRIEF,
  janitor: JANITOR_BRIEF,
  preflight: PREFLIGHT_BRIEF,
};
```

- [ ] **Step 4: Write the fake**

Create `test/ui/fake-gateway.ts`:

```ts
import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIEF_BY_AGENT, WHY_PEEK } from "./fixtures/briefs.js";

// A test-only Gateway. It speaks the real wire protocol and returns fixed
// shapes; it does not index, rank or reason. See the design doc for why a fake
// rather than a real Gateway, and for the limits of that choice.
//
// Protocol (verified against @nimbus-dev/client 0.15.1):
//   - NDJSON: one JSON-RPC 2.0 object per line.
//   - agents.<agent>  -> { sessionId }, then a <agent>.briefReady notification.
//   - agents.whyPeek  -> a direct result; it is NOT a brief and has no notification.

export interface RecordedRequest {
  method: string;
  params: unknown;
}

export interface FakeGateway {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  requests(): readonly RecordedRequest[];
  queueError(method: string, detail: string): void;
  reset(): void;
}

let counter = 0;

// The PID (plus a counter, so one process can run two) is the real defence
// against EADDRINUSE: a leftover socket from a crashed run can never collide
// with the next one. On win32 a named pipe is a kernel object and disappears
// with the process, so there is nothing to unlink there.
function newSocketPath(): string {
  counter += 1;
  const name = `nimbus-ui-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

const CANNED: Record<string, unknown> = {
  "agents.whyPeek": WHY_PEEK,
  searchRanked: [],
  "search.ranked": [],
  egressHead: { head: "0".repeat(64), count: 0 },
  "egress.head": { head: "0".repeat(64), count: 0 },
  queryItems: [],
};

export function createFakeGateway(): FakeGateway {
  const socketPath = newSocketPath();
  const recorded: RecordedRequest[] = [];
  const queuedErrors = new Map<string, string>();
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;

  const send = (sock: net.Socket, msg: unknown): void => {
    sock.write(`${JSON.stringify(msg)}\n`);
  };

  const handle = (sock: net.Socket, line: string): void => {
    const req = JSON.parse(line) as { id?: number | string; method: string; params?: unknown };
    recorded.push({ method: req.method, params: req.params ?? {} });

    if (req.method.startsWith("agents.") && req.method !== "agents.whyPeek") {
      const agent = req.method.slice("agents.".length);
      const sessionId = `s-${recorded.length}`;
      send(sock, { jsonrpc: "2.0", id: req.id, result: { sessionId } });
      const queued = queuedErrors.get(req.method);
      if (queued !== undefined) {
        queuedErrors.delete(req.method);
        send(sock, {
          jsonrpc: "2.0",
          method: `${agent}.briefError`,
          params: { sessionId, error: queued },
        });
        return;
      }
      send(sock, {
        jsonrpc: "2.0",
        method: `${agent}.briefReady`,
        params: { sessionId, brief: "fixture brief", findings: BRIEF_BY_AGENT[agent] ?? {} },
      });
      return;
    }

    send(sock, { jsonrpc: "2.0", id: req.id, result: CANNED[req.method] ?? {} });
  };

  return {
    socketPath,
    start: () =>
      new Promise((resolve, reject) => {
        // Unlink a leftover socket before listening. This is safe precisely
        // BECAUSE the path carries our PID: a live process cannot own a socket
        // named for this PID, so anything here is debris from a crashed run.
        // Without it, PID reuse on a long-lived machine surfaces as EADDRINUSE
        // — a failure with no relationship to the change under test.
        // Windows named pipes are kernel objects that vanish with the process,
        // so there is nothing to unlink there.
        if (process.platform !== "win32" && existsSync(socketPath)) {
          try {
            unlinkSync(socketPath);
          } catch {
            // Losing the race with another cleanup is fine; listen() will tell us.
          }
        }
        server = net.createServer((sock) => {
          sockets.add(sock);
          sock.on("close", () => sockets.delete(sock));
          let buf = "";
          sock.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) if (line.trim().length > 0) handle(sock, line);
          });
          // A client that drops mid-request must not take the server down.
          sock.on("error", () => sockets.delete(sock));
        });
        server.on("error", reject);
        server.listen(socketPath, () => resolve());
      }),

    stop: () =>
      new Promise((resolve) => {
        for (const sock of sockets) sock.destroy();
        sockets.clear();
        if (server === undefined) return resolve();
        server.close(() => resolve());
        server = undefined;
      }),

    requests: () => recorded,
    queueError: (method, detail) => queuedErrors.set(method, detail),
    reset: () => {
      recorded.length = 0;
      queuedErrors.clear();
    },
  };
}
```

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `bun run test test/unit/ui-fake-gateway.test.ts && bun run typecheck && bun run lint`
Expected: PASS. Run the full `bun run test` once too — nothing else should change.

- [ ] **Step 6: Commit**

```bash
git add test/ui/fake-gateway.ts test/ui/fixtures/briefs.ts test/unit/ui-fake-gateway.test.ts
git commit -m "test(ui): a fake Gateway speaking the real wire protocol"
```

---

### Task 2: The runner, the fixture workspace, and a smoke spec

This is the riskiest task in the plan: it is where the harness either boots or does not. Its deliverable is one spec proving VS Code launches with the extension loaded and connected to the fake.

**Files:**
- Create: `tsconfig.ui.json`, `.mocharc.ui.js`, `scripts/run-ui-tests.mjs`, `test/ui/fixture-workspace/src/session.ts`, `test/ui/fixture-workspace/src/auth.ts`, `test/ui/fixture-workspace/.vscode/settings.json`, `test/ui/specs/smoke.test.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Consumes: `createFakeGateway()` from Task 1.
- Produces: `bun run test:ui` — compiles `test/ui/**` to `out/ui/`, starts the fake, runs ExTester, stops the fake.

- [ ] **Step 1: Add the dependencies and ignores**

```bash
bun add -d vscode-extension-tester@8.23.0 mocha@11 @types/mocha@10 chai@5 @types/chai@5
```

`chai` is what every spec in Tasks 3-5 asserts with (`import { expect } from "chai"`), and `@types/chai` is required because the root `tsconfig.json` typechecks `test/**/*`. ExTester does not bundle either.

Append to `.gitignore`, after the `coverage/` line:

```
# UI test harness: compiled specs, and ExTester's downloaded VS Code + chromedriver
out/
test-resources/
```

Do **not** touch `.vscodeignore` — it is an allowlist starting with `**`, so these are already excluded from the `.vsix`.

- [ ] **Step 2: Add the TypeScript and Mocha configs**

Create `tsconfig.ui.json`. ExTester runs Mocha over compiled JavaScript, and Mocha loads CommonJS most reliably, so this emits CJS — unlike the root config, which is `noEmit` and ESNext:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "noEmit": false,
    "outDir": "out/ui",
    "rootDir": "test/ui",
    "types": ["node", "mocha"]
  },
  "include": ["test/ui/**/*.ts"]
}
```

Create `.mocharc.ui.js`. **The extension must be `.js`, not `.cjs`** — corrected during execution: ExTester 8.23.0's config loader accepts only `.js`, `.json`, `.yml` and `.yaml` (`vscode-extension-tester/out/suite/runner.js:180`), and silently skips anything else with a log line. A `.cjs` file means the timeout and retry settings below never apply at all.

```js
// Retries absorb Selenium races; a genuine regression still fails all three
// attempts. Timeouts are generous because each case drives a real VS Code.
//
// 120s rather than 60s, raised in review: a cold CI run pays for the workbench
// coming up for the first time, and that latency lands inside the `before`
// hook. The VS Code download itself happens in `extest setup-and-run` BEFORE
// mocha starts, so it is not on this clock — but workbench init is. The cost of
// this number is that a genuinely hung test burns 120s x 3 retries before it
// fails, which is why a test that hangs is a bug to fix rather than a number to
// raise again.
module.exports = {
  timeout: 120000,
  retries: 2,
  reporter: "spec",
};
```

- [ ] **Step 3: Write the runner**

Create `scripts/run-ui-tests.mjs`. It owns the fake's lifecycle so a crashed run cannot leave one behind:

```js
// Compiles the UI specs, starts the fake Gateway, runs ExTester against the
// fixture workspace, and always stops the fake.
//
// The VS Code version is pinned HERE and nowhere else. CI keys its download
// cache on the same value, so local and CI cannot silently diverge.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const VSCODE_VERSION = "1.104.0";

// Corrected during execution. The first draft called process.exit() inside
// this helper on a non-zero status — including for the extest run below. That
// is wrong in a way that only shows up when it matters: process.exit()
// terminates without unwinding pending `finally` blocks, so a FAILING ui suite
// skipped gateway.stop() entirely, which is precisely the case the finally
// exists to cover. Verified: `function run(){process.exit(3)}; try{run()}
// finally{console.log("x")}` prints nothing.
//
// So this returns the status and lets the caller decide when to exit.
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
};

const runOrExit = (cmd, args) => {
  const status = run(cmd, args);
  if (status !== 0) process.exit(status);
};

// Fail fast here: nothing is running yet, so there is nothing to clean up.
runOrExit("bunx", ["tsc", "-p", "tsconfig.ui.json"]);

const { createFakeGateway } = await import("../out/ui/fake-gateway.js");
const gateway = createFakeGateway();
await gateway.start();

// The extension reads nimbus.socketPath from the fixture workspace's settings,
// so the path has to be written before VS Code opens.
const settingsPath = join("test", "ui", "fixture-workspace", ".vscode", "settings.json");
writeFileSync(
  settingsPath,
  `${JSON.stringify(
    {
      "nimbus.socketPath": gateway.socketPath,
      "nimbus.autoStartGateway": false,
      "nimbus.egress.showStatusBarBadge": false,
      "nimbus.briefs.showHoverBlame": false,
      // WITHOUT THIS, TASK 4 CANNOT WORK. VS Code renders a modal
      // showWarningMessage as a NATIVE OS dialog by default, and Selenium
      // cannot see, read or click a native dialog — ExTester's ModalDialog page
      // object only drives the HTML one. The gate's whole surface is modal, so
      // every Group B spec would hang until it timed out, with a failure that
      // looks like a broken extension rather than a missing setting.
      "window.dialogStyle": "custom",
    },
    null,
    2,
  )}\n`,
);

// NOT runOrExit: exiting here would skip the finally and leak the fake on
// exactly the path that matters — a failing suite. Capture the status, let the
// finally stop the gateway, then exit with it.
let status = 1;
try {
  status = run("bunx", [
    "extest",
    "setup-and-run",
    "./out/ui/specs/**/*.test.js",
    "-c",
    VSCODE_VERSION,
    "-m",
    ".mocharc.ui.js",
    "-s",
    "./test-resources",
    // -r / --open_resource: the folder VS Code opens. NOT -o.
    "-r",
    "./test/ui/fixture-workspace",
  ]);
} finally {
  await gateway.stop();
}
process.exit(status);
```

Add to `package.json` scripts, after `"test:coverage"`:

```json
    "test:ui": "node scripts/run-ui-tests.mjs",
```

- [ ] **Step 4: Create the fixture workspace**

`test/ui/fixture-workspace/src/session.ts` — content is asserted against, so keep it stable:

```ts
export interface Session {
  id: string;
  userId: string;
}

export function createSession(userId: string): Session {
  return { id: `s-${userId}`, userId };
}
```

`test/ui/fixture-workspace/src/auth.ts`:

```ts
export function isAuthorized(userId: string): boolean {
  return userId.length > 0;
}
```

`test/ui/fixture-workspace/.vscode/settings.json` — a committed placeholder; the runner overwrites `nimbus.socketPath` on every run:

```json
{
  "nimbus.socketPath": "",
  "nimbus.autoStartGateway": false,
  "nimbus.egress.showStatusBarBadge": false,
  "nimbus.briefs.showHoverBlame": false,
  "window.dialogStyle": "custom"
}
```

Three of these suppress noise: no attempt to spawn a real Gateway, no status-bar polling, and no hover firing an RPC on every mouse rest.

`window.dialogStyle` is different — it is **load-bearing**. VS Code renders a modal `showWarningMessage` as a native OS dialog by default, and Selenium cannot see or click a native dialog; ExTester's `ModalDialog` drives only the HTML one. Since the pre-flight gate is entirely modal, every Group B spec would hang without it. Keep it in both this committed file and the runner's generated version — the runner overwrites this file, so a setting present in only one of them is a setting that does not apply.

- [ ] **Step 5: Write the smoke spec**

Create `test/ui/specs/smoke.test.ts`:

```ts
import { expect } from "chai";
import { EditorView, VSBrowser, Workbench } from "vscode-extension-tester";

// The harness's own health check: if this fails, nothing else in the suite is
// meaningful. It proves VS Code launched, the extension activated, and its
// commands are reachable — not that any brief works.
describe("harness smoke", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
  });

  it("opens the fixture workspace", async () => {
    const title = await new Workbench().getTitleBar().getTitle();
    expect(title).to.contain("fixture-workspace");
  });

  it("registers the Nimbus brief commands", async () => {
    const prompt = await new Workbench().openCommandPrompt();
    await prompt.setText(">Nimbus: Why is this here?");
    const picks = await prompt.getQuickPicks();
    expect(picks.length).to.be.greaterThan(0);
    await prompt.cancel();
  });

  after(async () => {
    await new EditorView().closeAllEditors();
  });
});
```

- [ ] **Step 6: Run it**

Run: `bun run test:ui`
Expected: ExTester downloads VS Code 1.104.0 and chromedriver on first run (slow — several minutes), then both smoke cases PASS.

If the workbench never appears, check in this order: the compile step wrote `out/ui/`; the fake started (its socket path is printed by the runner if you add a log); `extest` resolved. Report BLOCKED with the actual failure rather than guessing.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add package.json bun.lock .gitignore tsconfig.ui.json .mocharc.ui.js scripts/run-ui-tests.mjs test/ui/
git commit -m "test(ui): boot a real VS Code against the fake Gateway"
```

---

### Task 3: Group A — the flows that never send

**Files:**
- Create: `test/ui/specs/briefs-no-send.test.ts`

**Interfaces:**
- Consumes: the running harness from Task 2; `FakeGateway.requests()` / `.reset()` from Task 1.

Every case here asserts the extension's behaviour *up to* the send. The strongest assertion available is that the fake received nothing.

**Reaching the fake from a spec:** the specs run inside Mocha in the same Node process the runner started, so import the singleton the runner created. Add to `scripts/run-ui-tests.mjs` before the `extest` call:

```js
globalThis.__nimbusFakeGateway = gateway;
```

and read it in specs via a tiny helper — create `test/ui/helpers/gateway.ts`:

```ts
import type { FakeGateway } from "../fake-gateway.js";

export function fake(): FakeGateway {
  const gw = (globalThis as { __nimbusFakeGateway?: FakeGateway }).__nimbusFakeGateway;
  if (gw === undefined) throw new Error("fake gateway not started by the runner");
  return gw;
}
```

- [ ] **Step 1: Write the spec**

```ts
import { expect } from "chai";
import { EditorView, InputBox, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

async function runCommand(name: string): Promise<void> {
  await new Workbench().executeCommand(name);
}

describe("briefs that never send", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
    await VSBrowser.instance.openResources("test/ui/fixture-workspace/src/session.ts");
  });

  // Reset AFTER each case, not before: a failing test leaves the fake's state
  // intact for inspection, and a queued error can never leak into a later case.
  afterEach(() => {
    fake().reset();
  });

  after(async () => {
    await new EditorView().closeAllEditors();
  });

  it("prefills the janitor prompt with the active file's relative ref", async () => {
    await runCommand("Nimbus: Is this idle?");
    const input = await InputBox.create();
    expect(await input.getText()).to.equal("src/session.ts");
    await input.cancel();
    expect(fake().requests()).to.deep.equal([]);
  });

  it("rejects a negative idle-days value with an inline message", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    await days.setText("-5");
    const message = await days.getMessage();
    expect(message).to.contain("whole number of days");
    await days.cancel();
    expect(fake().requests()).to.deep.equal([]);
  });

  it("accepts a blank idle-days value", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    expect(await days.getMessage()).to.not.contain("whole number");
    await days.cancel();
  });

  // The behaviour the unit tests pin, proven here against a real input box:
  // Escape is not the same answer as an empty string.
  it("sends nothing when the idle-days prompt is escaped", async () => {
    await runCommand("Nimbus: Is this idle?");
    const ref = await InputBox.create();
    await ref.setText("svc/legacy");
    await ref.confirm();
    const days = await InputBox.create();
    await days.cancel();
    expect(fake().requests()).to.deep.equal([]);
  });

  it("cancels preflight when the namespace is left empty", async () => {
    await runCommand("Nimbus: Safe to deploy?");
    const ref = await InputBox.create();
    await ref.setText("release-1.4");
    await ref.confirm();
    const ns = await InputBox.create();
    await ns.setText("");
    await ns.confirm();
    expect(fake().requests()).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun run test:ui`
Expected: all five PASS, plus the two smoke cases.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
git add test/ui/specs/briefs-no-send.test.ts test/ui/helpers/gateway.ts scripts/run-ui-tests.mjs
git commit -m "test(ui): cover the brief flows that never send"
```

---

### Task 4: Group B — through the gate

**Files:**
- Create: `test/ui/specs/briefs-gated.test.ts`

**Interfaces:**
- Consumes: `fake()` from Task 3's helper.

This is where the fake's recording earns its place: the assertions are on what actually reached the wire.

- [ ] **Step 1: Write the spec**

```ts
import { expect } from "chai";
import { EditorView, InputBox, ModalDialog, TextEditor, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

describe("briefs through the gate", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
    await VSBrowser.instance.openResources("test/ui/fixture-workspace/src/session.ts");
  });

  afterEach(async () => {
    fake().reset();
    await new EditorView().closeAllEditors();
  });

  it("shows a pre-flight modal naming the ref, and Cancel sends nothing", async () => {
    await new Workbench().executeCommand("Nimbus: Who knew this code?");
    const dialog = new ModalDialog();
    expect(await dialog.getDetails()).to.contain("src/session.ts");
    await dialog.pushButton("Cancel");
    expect(fake().requests()).to.deep.equal([]);
  });

  it("sends and renders the brief when the modal is confirmed", async () => {
    await new Workbench().executeCommand("Nimbus: Who knew this code?");
    await new ModalDialog().pushButton("Send");
    const editor = new TextEditor();
    const text = await editor.getText();
    expect(text).to.contain("Who knew");
    expect(text).to.contain("Dana");
    expect(fake().requests().map((r) => r.method)).to.deep.equal(["agents.ghost"]);
  });

  // VS Code counts lines from 0 and the Gateway counts from 1. This asserts the
  // conversion at the wire, which no unit test can do.
  it("sends a 1-based line for why", async () => {
    const editor = new TextEditor();
    await editor.moveCursor(3, 1);
    await new Workbench().executeCommand("Nimbus: Why is this here?");
    await new ModalDialog().pushButton("Send");
    const sent = fake().requests().find((r) => r.method === "agents.why");
    expect(sent?.params).to.deep.equal({ ref: "src/session.ts", line: 3 });
  });

  it("surfaces the Gateway's own error detail with a Retry", async () => {
    fake().queueError("agents.huddle", "no peers configured");
    await new Workbench().executeCommand("Nimbus: Team huddle");
    await new ModalDialog().pushButton("Send");
    const notifications = await new Workbench().getNotifications();
    const messages = await Promise.all(notifications.map((n) => n.getMessage()));
    expect(messages.join(" ")).to.contain("no peers configured");
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun run test:ui`
Expected: all four PASS.

If the modal's button labels differ from `Send` / `Cancel`, read them from the running dialog and correct the spec — do not change `src/`.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
git add test/ui/specs/briefs-gated.test.ts
git commit -m "test(ui): cover briefs through the pre-flight gate"
```

---

### Task 5: Group C — the participant records without prompting

**Files:**
- Create: `test/ui/specs/participant.test.ts`

- [ ] **Step 1: Write the spec**

```ts
import { expect } from "chai";
import { EditorView, TextEditor, VSBrowser, Workbench } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

// The participant's ops briefs record rather than prompt: a modal must not
// interrupt a chat turn. The proof is that the request reached the fake with no
// dialog in between, and that the path was redacted on the way.
describe("the participant records without prompting", () => {
  before(async () => {
    await VSBrowser.instance.waitForWorkbench();
    await VSBrowser.instance.openResources("test/ui/fixture-workspace/src/session.ts");
  });

  afterEach(async () => {
    fake().reset();
    await new EditorView().closeAllEditors();
  });

  it("sends a redacted basename for a bare /blast, with no modal", async () => {
    await new Workbench().executeCommand("Nimbus: Blast radius");
    const sent = fake().requests().find((r) => r.method === "agents.impact");
    expect(sent?.params).to.deep.equal({ fileOrPrUrl: "session.ts" });
    const params = JSON.stringify(sent?.params ?? {});
    expect(params).to.not.contain("fixture-workspace");
  });

  it("shows the recorded payload in Show Last Outbound Payload", async () => {
    await new Workbench().executeCommand("Nimbus: Blast radius");
    await new Workbench().executeCommand("Nimbus: Show Last Outbound Payload");
    const text = await new TextEditor().getText();
    expect(text).to.contain("session.ts");
  });
});
```

**If `/blast` is only reachable through the Chat view** rather than a command, drive it through the chat participant instead: open the Chat view, type `@nimbus /blast`, and submit. Read the actual command ids from `package.json` before writing this spec and adapt — report what you found.

- [ ] **Step 2: Run it**

Run: `bun run test:ui`
Expected: both PASS.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
git add test/ui/specs/participant.test.ts
git commit -m "test(ui): prove the participant records without a modal"
```

---

### Task 6: The CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the job**

Append a `ui-test` job after `build-test`, matching that job's hardened style exactly — pinned action SHAs, `harden-runner`, the same bun version:

```yaml
  ui-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit

      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: 1.3.14

      - name: Install
        run: bun install --frozen-lockfile

      # Keyed on BOTH the pinned VS Code version (in run-ui-tests.mjs) and
      # package.json, which carries the ExTester version. Raised in review:
      # keying on the script alone means bumping vscode-extension-tester leaves
      # a cached chromedriver that its new version may not accept, and the
      # resulting CI failure looks like a test bug. Over-invalidating costs one
      # re-download; under-invalidating costs an afternoon.
      - name: Cache VS Code + chromedriver
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: test-resources
          key: ${{ runner.os }}-extest-${{ hashFiles('scripts/run-ui-tests.mjs', 'package.json') }}

      - name: Build
        run: bun run build

      # VS Code is an Electron app with no headless mode; xvfb supplies the
      # display. This is why the suite is Linux-only in CI.
      - name: Run UI tests
        run: xvfb-run -a bun run test:ui
```

- [ ] **Step 2: Verify the YAML parses**

Run: `node -e "const {readFileSync}=require('node:fs');const s=readFileSync('.github/workflows/ci.yml','utf8');if(!s.includes('ui-test:'))throw new Error('job missing');console.log('ui-test job present')"`
Expected: `ui-test job present`.

There is no way to run GitHub Actions locally here; the job proves itself on the PR. Say so in your report rather than claiming it passed.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the UI suite on every PR"
```

---

## Self-Review

**Spec coverage.** Fake Gateway + NDJSON + two-step + recording + queued errors → Task 1. Platform-aware socket path and PID-keyed collision avoidance → Task 1. Fixture workspace and `nimbus.socketPath` wiring → Task 2. Pinned VS Code version in one place, cache keyed on it → Tasks 2 and 6. Page objects only → used throughout Tasks 3-5 (no raw selectors appear; `test/ui/helpers/selectors.ts` is deliberately NOT created, per YAGNI — add it only when a page object genuinely cannot reach something). `fake.reset()` in a root `afterEach` → Tasks 3-5. Group A/B/C coverage → Tasks 3/4/5. Mocha retries of 2 and explicit waits → Task 2's `.mocharc.ui.js`. CI job with xvfb and its own timeout → Task 6. Typed fixtures as the drift guard → Task 1, enforced by the root tsconfig already including `test/**/*`.

**Plan review dispositions** ([2026-08-11-ui-test-harness-review.md](./2026-08-11-ui-test-harness-review.md)) — all four accepted:

- **`window.dialogStyle: "custom"` — fixed, and it was a blocker.** VS Code renders a modal `showWarningMessage` as a native OS dialog by default; Selenium cannot see one, and ExTester's `ModalDialog` drives only the HTML variant. Since the pre-flight gate is entirely modal, every Group B spec would have hung until timeout, presenting as a broken extension rather than a missing setting. Added to both the committed fixture settings and the runner's generated copy.
- **CI cache key — fixed.** Now hashes `package.json` as well as the runner, so bumping `vscode-extension-tester` cannot leave a cached chromedriver its new version rejects.
- **Unlink a stale socket — fixed.** Added, with the reasoning that makes it safe rather than reckless: the path carries our PID, so a live process cannot own it and anything present is debris from a crashed run. PID reuse on a long-lived machine is the real scenario, and `EADDRINUSE` is a maximally confusing way to discover it.
- **Cold-start timeout — fixed.** Mocha's timeout raised 60s → 120s. Worth noting for anyone reading the number later: the VS Code download happens in `extest setup-and-run` *before* mocha starts and is not on this clock; workbench init is.

**Known risks, stated rather than hidden:**
- **Task 2 is the real risk.** Everything after it is incremental; if the harness will not boot, the plan stops there. Its smoke spec exists to make that failure obvious and early rather than tangled up with a brief assertion.
- **Selector and label drift.** The specs assume the modal's buttons read `Send` and `Cancel` and that commands are titled as `package.json` declares. Tasks 4 and 5 tell the implementer to read the real labels and adapt the spec rather than change `src/`.
- **`/blast` reachability.** Task 5 assumes a command; if it is only reachable through the Chat view, the spec must drive the chat participant instead. Flagged in the task.
- **Runtime.** First CI run downloads VS Code (~120 MB) and chromedriver; the cache makes subsequent runs much faster. 25 minutes is deliberately generous for the cold case.
