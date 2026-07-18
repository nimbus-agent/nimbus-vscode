# First-run Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a **Get Started with Nimbus** walkthrough (Welcome → Connect → Ask → Search → Quick Ask → Explore) that turns a fresh install into a working setup — the last remaining Phase 1 item.

**Architecture:** Almost entirely declarative — a `contributes.walkthroughs` manifest entry with 6 steps, each backed by a short markdown media file and completed by a real VS Code event. The only production code is a `nimbus.openWalkthrough` command (opens the built-in walkthrough) and a one-line `setContext("nimbus.connected", …)` on connection-state changes so the Connect step checks itself off on a genuine connection.

**Tech Stack:** TypeScript (strict), Vitest (vscode stubbed), Biome, esbuild. `vscode` only via `src/vscode-shim.ts`.

**Spec:** [docs/superpowers/specs/2026-07-17-walkthrough-design.md](../specs/2026-07-17-walkthrough-design.md)

## Global Constraints

- **No RPC** — VS Code Walkthroughs API + existing commands only. No reach past `@nimbus-dev/client`.
- **No `any`** (use `unknown`); TS strict; Biome (`noExplicitAny`, `noConsole` → log via `logging.ts`, `noNonNullAssertion`).
- **`vscode` only through `src/vscode-shim.ts`** — use the existing `deps.commands.executeCommand(...)` seam (the pattern the troubleshooter already uses); **do not** add bespoke `setContext`/`openWalkthrough` shim wrappers.
- **No new settings** → no docs-sync guard work.
- **Walkthrough id:** `nimbus-agent.nimbus-vscode#nimbusGettingStarted` (publisher `nimbus-agent`, name `nimbus-vscode`, walkthrough id `nimbusGettingStarted`).
- **Branch:** `feat/walkthrough` (already created; the design spec is committed there).
- **Local gate** (before each commit): `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-settings-docs`.

---

## File Structure

- **Task 1 — code + tests** — modify `src/extension.ts` (register `nimbus.openWalkthrough`; add `setContext("nimbus.connected", …)`), `package.json` (the `nimbus.openWalkthrough` command); extend `test/unit/extension.test.ts`.
- **Task 2 — declarative walkthrough + media + docs** — modify `package.json` (`contributes.walkthroughs`); create `resources/walkthrough/{welcome,connect,ask,search,quick-ask,explore}.md`; modify `README.md` and `CHANGELOG.md`.
- **Task 3 — verification** — full gate + Layer-2 EDH drive.

---

## Task 1: `nimbus.openWalkthrough` command + `nimbus.connected` context key

**Files:**
- Modify: `src/extension.ts`, `package.json`
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: existing `deps.commands.executeCommand`, the `connection.onState` listener, the `register(id, handler)` helper.
- Produces: command `nimbus.openWalkthrough`; the `nimbus.connected` VS Code context key (set on every connection-state change).

- [ ] **Step 1: Write the failing tests**

In `test/unit/extension.test.ts`, add tests that mirror the existing activation/connection tests (find one that calls `activateWithDeps(...)` + `await flush()` and reuse that exact idiom; `commands.executeCommand` in the fixture is a `vi.fn`). Add:

```ts
  test("nimbus.openWalkthrough opens the Get Started walkthrough", async () => {
    const fx = makeFixture({});
    await activateWithDeps(fx.ctx, fx.deps);
    await flush();
    await fx.commandHandlers.get("nimbus.openWalkthrough")?.();
    expect(fx.deps.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openWalkthrough",
      "nimbus-agent.nimbus-vscode#nimbusGettingStarted",
    );
  });

  test("sets nimbus.connected=true once the Gateway connects", async () => {
    const fx = makeFixture({}); // default openClient resolves → connected
    await activateWithDeps(fx.ctx, fx.deps);
    await flush();
    expect(fx.deps.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "nimbus.connected",
      true,
    );
  });

  test("sets nimbus.connected=false when the Gateway is unreachable", async () => {
    const fx = makeFixture({
      openClient: async () => {
        throw new Error("no gateway");
      },
    });
    await activateWithDeps(fx.ctx, fx.deps);
    await flush();
    expect(fx.deps.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "nimbus.connected",
      false,
    );
    expect(fx.deps.commands.executeCommand).not.toHaveBeenCalledWith(
      "setContext",
      "nimbus.connected",
      true,
    );
  });
```

> If the fixture accessor names differ (`fx.commandHandlers` vs `fx.captured.commandHandlers`, the activate call, or the `flush` helper), match the exact shape used by the neighbouring connection/command tests in this same file — do not invent new harness plumbing.
>
> **Activation-time initialization (review A):** the third test doubles as the "initialized at activation" check — `setContext("nimbus.connected", false)` is asserted for a fixture that *never* reaches `connected`, which can only happen because `connection.onState` fires the listener immediately on subscribe (idle/connecting → `false`) rather than only on a later transition. So a dedicated "initialized before any event" test is redundant; the disconnected case already pins it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- extension`
Expected: FAIL — `nimbus.openWalkthrough` handler is undefined; `executeCommand` never called with `setContext`.

- [ ] **Step 3: Add the `setContext` in the connection listener**

In `src/extension.ts`, the connection listener begins:

```ts
  const stateSub = connection.onState((s) => {
    renderStatusBar(s);
```

Add the context set immediately after `renderStatusBar(s);` (so it runs on **every** state — including `connected` — before the branch's early `return`, and fires at activation because `connection.onState` invokes the listener with the current state on subscription):

```ts
    renderStatusBar(s);
    void deps.commands.executeCommand("setContext", "nimbus.connected", s.kind === "connected");
```

- [ ] **Step 4: Register the `nimbus.openWalkthrough` command**

In `src/extension.ts`, alongside the other simple `register(...)` calls (e.g. near `nimbus.reconnect` / `nimbus.openLogs`), add:

```ts
  register("nimbus.openWalkthrough", async () => {
    await deps.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "nimbus-agent.nimbus-vscode#nimbusGettingStarted",
    );
  });
```

- [ ] **Step 5: Add the command to `package.json`**

In `contributes.commands`, add (keep the JSON array valid — comma after the previous last entry):

```json
      {
        "command": "nimbus.openWalkthrough",
        "title": "Open Walkthrough",
        "category": "Nimbus"
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test -- extension`
Expected: PASS.

- [ ] **Step 7: Full gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-settings-docs`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts package.json test/unit/extension.test.ts
git commit -m "feat(walkthrough): openWalkthrough command + nimbus.connected context key

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Get Started walkthrough (manifest + media) + docs

**Files:**
- Modify: `package.json` (`contributes.walkthroughs`), `README.md`, `CHANGELOG.md`
- Create: `resources/walkthrough/welcome.md`, `connect.md`, `ask.md`, `search.md`, `quick-ask.md`, `explore.md`

**Interfaces:**
- Consumes: the commands `nimbus.reconnect`, `nimbus.ask`, `nimbus.search`, `nimbus.quickAsk`, `workbench.view.extension.nimbus` (built-in container focus), and the `nimbus.connected` context key from Task 1.
- Produces: the `nimbusGettingStarted` walkthrough surfaced on the Welcome page + via `nimbus.openWalkthrough`.

- [ ] **Step 1: Create the six media markdown files**

Create `resources/walkthrough/welcome.md`:

```markdown
# Welcome to Nimbus

Nimbus is a **local-first** AI agent for your editor. It talks to a Nimbus Gateway running on *your* machine — this extension makes no cloud calls — and every byte it sends off-device is recorded in a verifiable **egress ledger**.

This short walkthrough gets you connected and shows you Ask, Search, and Quick Ask.

New here? See the [install guide](https://nimbus-agent.dev/install).
```

Create `resources/walkthrough/connect.md`:

```markdown
# Connect the Gateway

Nimbus needs a **Gateway** running locally. Once it's up, this extension connects automatically.

- Already running it? Click **Reconnect** below.
- Want the extension to start it for you? Enable the `nimbus.autoStartGateway` setting.
- Stuck? Run **Nimbus: Troubleshoot Connection** for a diagnosis and one-click fixes.

[Reconnect to the Gateway](command:nimbus.reconnect)

This step checks itself off once you're connected.
```

Create `resources/walkthrough/ask.md`:

```markdown
# Try Ask

**Ask** opens a streaming chat panel backed by your local index and agent. Responses stream in token-by-token, and a **Stop** button cancels a long answer while keeping what streamed so far.

[Ask Nimbus](command:nimbus.ask)
```

Create `resources/walkthrough/search.md`:

```markdown
# Try Search

**Search** runs a live ranked (semantic + keyword) query over your local Nimbus index. Results update as you type; pick one to open its source. Select code first and use **Search Selection** to seed the query.

[Search the index](command:nimbus.search)
```

Create `resources/walkthrough/quick-ask.md`:

```markdown
# Try Quick Ask

**Quick Ask** answers a one-shot question about your selection (or the whole file) in a read-only tab — no chat panel. Pick a preset (Explain / Fix / Review / Docstring) or ask your own.

[Quick Ask](command:nimbus.quickAsk)
```

Create `resources/walkthrough/explore.md`:

```markdown
# Explore Nimbus

You're set up. A few places worth knowing:

- **The Nimbus sidebar** — Audit, Sessions (resume a chat), Index, and Agents.
- **The egress badge** in the status bar — row count + a ledger-live ✓; click it to open the egress ledger and verify what's left your machine.
- **Nimbus: Troubleshoot Connection** — whenever the Gateway acts up.

[Open the Nimbus sidebar](command:workbench.view.extension.nimbus)
```

- [ ] **Step 2: Add `contributes.walkthroughs` to `package.json`**

Add a new top-level key inside `contributes` (a sibling of `configuration`):

```json
    "walkthroughs": [
      {
        "id": "nimbusGettingStarted",
        "title": "Get Started with Nimbus",
        "description": "Connect the Gateway and try Ask, Search, and Quick Ask.",
        "steps": [
          {
            "id": "welcome",
            "title": "Welcome to Nimbus",
            "description": "Local-first, egress-audited AI in your editor.\n[Install guide](https://nimbus-agent.dev/install)",
            "media": { "markdown": "resources/walkthrough/welcome.md" }
          },
          {
            "id": "connect",
            "title": "Connect the Gateway",
            "description": "Nimbus talks to a local Gateway.\n[Reconnect](command:nimbus.reconnect)",
            "media": { "markdown": "resources/walkthrough/connect.md" },
            "completionEvents": ["onContext:nimbus.connected"]
          },
          {
            "id": "ask",
            "title": "Try Ask",
            "description": "Chat with the Nimbus agent.\n[Ask Nimbus](command:nimbus.ask)",
            "media": { "markdown": "resources/walkthrough/ask.md" },
            "completionEvents": ["onCommand:nimbus.ask"]
          },
          {
            "id": "search",
            "title": "Try Search",
            "description": "Ranked search over your local index.\n[Search](command:nimbus.search)",
            "media": { "markdown": "resources/walkthrough/search.md" },
            "completionEvents": ["onCommand:nimbus.search"]
          },
          {
            "id": "quickAsk",
            "title": "Try Quick Ask",
            "description": "One-shot answer about your selection.\n[Quick Ask](command:nimbus.quickAsk)",
            "media": { "markdown": "resources/walkthrough/quick-ask.md" },
            "completionEvents": ["onCommand:nimbus.quickAsk"]
          },
          {
            "id": "explore",
            "title": "Explore Nimbus",
            "description": "Sidebar, egress badge, and troubleshooting.\n[Open the sidebar](command:workbench.view.extension.nimbus)",
            "media": { "markdown": "resources/walkthrough/explore.md" },
            "completionEvents": ["onCommand:workbench.view.extension.nimbus", "onView:nimbus.auditView"]
          }
        ]
      }
    ]
```

> **Why the Explore step has two completion events (review B):** `onCommand:workbench.view.extension.nimbus` fires when the user clicks the markdown link button, but a **direct click on the Nimbus activity-bar icon may not route through the command registry** in all VS Code versions. `onView:nimbus.auditView` fires when the sidebar's first view renders — which happens however the container is opened — so the step checks off robustly by either path. `completionEvents` is an OR: any listed event completes the step.

- [ ] **Step 3: Validate the manifest JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK`.

- [ ] **Step 4: Update README**

In `README.md`, under the **Quickstart** section, add a short line:

```markdown
First time? Run **`Nimbus: Open Walkthrough`** (or open it from the **Get Started** / Welcome page) for a guided setup — connect the Gateway, then try Ask, Search, and Quick Ask.
```

- [ ] **Step 5: Update CHANGELOG**

In `CHANGELOG.md`, add a fresh `## Unreleased` section at the top (above `## 0.3.0`):

```markdown
## Unreleased

- **Get Started walkthrough** — a first-run walkthrough (`Nimbus: Open Walkthrough`,
  also on the Welcome page) that guides you through connecting the Gateway and
  trying Ask, Search, and Quick Ask, then points at the sidebar and egress ledger.
  The "Connect the Gateway" step checks itself off on a real connection.
```

- [ ] **Step 6: Full gate + package sanity**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-settings-docs`
Expected: all pass (no code changed here, but the gate confirms nothing regressed).

Optionally confirm the media files are packaged (they ship by default; `.vscodeignore` does not exclude `resources/`):
Run: `bun run package && ls resources/walkthrough` (or inspect the `.vsix` contents). Expected: the six `.md` files present.

- [ ] **Step 7: Commit**

```bash
git add package.json resources/walkthrough README.md CHANGELOG.md
git commit -m "feat(walkthrough): Get Started walkthrough + step media

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verification

**Files:** none.

- [ ] **Step 1: Full gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-bundle && bun run check-settings-docs`
Expected: all green.

- [ ] **Step 2: Layer-2 EDH drive** (per the `verify-extension` skill — required, unit tests can't render a walkthrough)

F5 into an Extension Development Host with a Gateway available, then:
- Run **Nimbus: Open Walkthrough** → the "Get Started with Nimbus" walkthrough opens with all 6 steps.
- Each step's markdown renders in the media pane; the command-link buttons fire (Reconnect / Ask / Search / Quick Ask / Open sidebar).
- The **Connect** step auto-checks once the Gateway is connected (`onContext:nimbus.connected`), and the Ask/Search/Quick-Ask steps check off when their command runs.
- The **Explore** step: confirm it completes **both** ways — clicking the "Open the sidebar" link button, **and** clicking the Nimbus activity-bar icon directly (the `onView:nimbus.auditView` event should cover the direct click). If a version is found where neither the direct click's `onCommand` nor `onView` fires, note it — but `onView` is expected to be the robust path.
- Confirm the walkthrough also appears on the **Welcome / Get Started** page.

- [ ] **Step 3: Hand off to finishing-a-development-branch**

Use `superpowers:finishing-a-development-branch` to open the PR for `feat/walkthrough`.

---

## Notes for the implementer

- Line numbers drift; anchor edits on the quoted code (`renderStatusBar(s);` in the `connection.onState` listener; the `register(...)` block; the `contributes.commands` array).
- The `setContext` must sit **before** the listener's `if (s.kind === "connected") { … return; }` branch — right after `renderStatusBar(s);` — so it runs on the connected state too.
- Do **not** add shim wrappers for `setContext`/`openWalkthrough`; the generic `deps.commands.executeCommand` is the sanctioned seam.
- Media markdown is English-only (consistent with the extension; no l10n infra).
