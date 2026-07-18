# First-run Walkthrough — Design

**Date:** 2026-07-17
**Status:** Approved (design), pending implementation plan
**Roadmap item:** Phase 1 — *First-run Walkthrough (install → connect Gateway → try Ask/Search/Quick-ask)*, effort M, **no RPC** (VS Code Walkthroughs API). The last remaining Phase 1 item after `0.3.0` shipped the other four.

## Goal

Turn a fresh install into a working setup: a **Get Started with Nimbus** walkthrough that guides a new user through connecting the Gateway and trying Ask / Search / Quick Ask, then points at the sidebar + trust surfaces.

## Context & non-negotiables

Thin IPC client (see [CLAUDE.md](../../../CLAUDE.md)). This feature is almost entirely **declarative** (`contributes.walkthroughs`) and needs **no RPC** — it uses only the VS Code Walkthroughs API and existing commands.

- **No `any`**, TypeScript strict, Biome (`noExplicitAny`, `noConsole` → log via `logging.ts`, `noNonNullAssertion`).
- **`vscode` only through `src/vscode-shim.ts`.**
- The committed `@nimbus-dev/client` stays a published `^x.y.z`.
- **No new settings** → no docs-sync guard work.

## Design decisions (from brainstorming)

1. **Trigger: passive + command.** Contribute the walkthrough so VS Code surfaces it on the Welcome / "Get Started" page for fresh installs, plus a `Nimbus: Open Walkthrough` command to open it anytime. **No `globalState`, no shim change** — keeping the code surface tiny.
   - *VS Code's own behavior (review Q2):* VS Code may still auto-open the walkthrough on install per the **user** setting `workbench.welcomePage.walkthroughs.openOnInstall` (default on). That is VS Code's standard, user-controlled behavior for *any* contributed walkthrough, and there is **no manifest field to suppress it**. "Passive" here therefore means the **extension adds no programmatic auto-open of its own** (no `globalState` first-run trigger) — it neither forces nor suppresses VS Code's built-in `openOnInstall`. This is the expected, correct behavior for a first-run walkthrough; the earlier "no auto-popup" phrasing was imprecise.
2. **Steps: core 5 + a closing "explore" step** (6 total).
3. **"Connect" step completes on a real connection** via a `nimbus.connected` context key (a one-line `setContext` on connection-state changes), so its checkmark means "actually connected," not "clicked a button."
4. **Media: markdown-only**, theme-neutral, shipped as static files. No screenshots (none exist; command links render as buttons).

## Components

### 1. `contributes.walkthroughs` (package.json — declarative)

One walkthrough, `id: "nimbusGettingStarted"`, `title: "Get Started with Nimbus"`, `description: "Connect the Gateway and try Ask, Search, and Quick Ask."`. Six steps; each step has `id`, `title`, `description` (short text + a command-link button), `media: { "markdown": "resources/walkthrough/<step>.md" }`, and `completionEvents`.

| # | Step id | Title | Media file | Button (command link) | `completionEvents` |
| --- | --- | --- | --- | --- | --- |
| 1 | `welcome` | Welcome to Nimbus | `welcome.md` | *(link to install docs)* | *(default — completes when selected)* |
| 2 | `connect` | Connect the Gateway | `connect.md` | `command:nimbus.reconnect` | `onContext:nimbus.connected` |
| 3 | `ask` | Try Ask | `ask.md` | `command:nimbus.ask` | `onCommand:nimbus.ask` |
| 4 | `search` | Try Search | `search.md` | `command:nimbus.search` | `onCommand:nimbus.search` |
| 5 | `quickAsk` | Try Quick Ask | `quick-ask.md` | `command:nimbus.quickAsk` | `onCommand:nimbus.quickAsk` |
| 6 | `explore` | Explore Nimbus | `explore.md` | `command:workbench.view.extension.nimbus` | `onCommand:workbench.view.extension.nimbus` **or** `onView:nimbus.auditView` |

Notes:
- A step is `{ id, title, description, media, completionEvents }` — there is no separate `button` field. The action button is a command link in the step's `description` markdown using the `command:` scheme (e.g. `[Ask Nimbus](command:nimbus.ask)`); the media pane shows the step's markdown file. Each referenced command already exists.
- Step 6 (`explore`) completes when the user **opens the Nimbus sidebar** — `workbench.view.extension.nimbus`, VS Code's auto-generated focus command for the `nimbus` activity-bar container (verified in `viewsContainers`). *(Review fix A: the earlier design completed this step by running `nimbus.troubleshootConnection`, which is counter-intuitive — it implies something is wrong right after a successful connect. Opening the sidebar is the positive "explore" action.)* Its copy still points at the sidebar views (Audit / Sessions / Index / Agents), the egress status-bar badge, and `Nimbus: Troubleshoot Connection` as things to notice — but the completing action is opening the sidebar. The step lists **both** `onCommand:workbench.view.extension.nimbus` (the markdown link button) **and** `onView:nimbus.auditView` (the sidebar's first view rendering) so it completes whether the user clicks the button or the activity-bar icon directly — a direct icon click may not route through the command registry in all VS Code versions.
- Optional `when` clauses are omitted — the walkthrough is always available.

### 2. `nimbus.openWalkthrough` command (extension.ts + package.json)

- `package.json` `contributes.commands`: `{ command: "nimbus.openWalkthrough", title: "Open Walkthrough", category: "Nimbus" }` (visible in the palette by default).
- `extension.ts`: register it to run the built-in opener:
  ```ts
  register("nimbus.openWalkthrough", async () => {
    await deps.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "nimbus-agent.nimbus-vscode#nimbusGettingStarted",
    );
  });
  ```
  The id is `<publisher>.<name>#<walkthroughId>` = `nimbus-agent.nimbus-vscode#nimbusGettingStarted` (publisher/name verified in `package.json`).

### 3. `nimbus.connected` context key (extension.ts)

In the connection state listener (the existing `connection.onState` / `stateSub` path that already calls `renderStatusBar`), add:
```ts
void deps.commands.executeCommand("setContext", "nimbus.connected", s.kind === "connected");
```
This drives step 2's `onContext:nimbus.connected` completion. It's a fire-and-forget VS Code context set — no RPC, no state stored by us. Set once per state change alongside the existing `renderStatusBar(s)`.

- **Initialized at activation (review fix B):** `connection.onState(listener)` invokes the listener **immediately with the current state** on subscription (`connection-manager.ts:106` — `listener(state)`), then again on every transition. So placing the `setContext` inside that listener initializes `nimbus.connected` at activation and keeps it current — a user who is *already* connected when they open the walkthrough sees step 2 checked without needing a fresh transition. No separate activation-time set is required.
- **Shim seam (review fix C):** both `setContext` and `workbench.action.openWalkthrough` go through the existing typed `deps.commands.executeCommand(...)` (`CommandsApi` in `vscode-shim.ts`) — the same seam the troubleshooter already uses to dispatch commands (`executeCommand(action.command, …)`). Verified present. No new shim surface is added: bespoke `deps.commands.setContext()` / `openWalkthrough()` wrappers were considered and **rejected** — they would duplicate the generic, already-shimmed `executeCommand` without benefit and diverge from the established pattern.

### 4. Media files — `resources/walkthrough/*.md`

Six short markdown files (`welcome.md`, `connect.md`, `ask.md`, `search.md`, `quick-ask.md`, `explore.md`), theme-neutral prose (a sentence or two + the relevant command link). `resources/` ships in the `.vsix` by default (`.vscodeignore` does not exclude it — verified).

## Data flow

Purely VS Code-native: the walkthrough is rendered by VS Code from the manifest; step completion is driven by VS Code observing `onCommand:*` / `onContext:*` events. The only extension code paths are (a) the `openWalkthrough` command → built-in opener, and (b) `setContext("nimbus.connected", …)` on connection changes. No Gateway interaction.

## Error handling

- `openWalkthrough` wraps the `executeCommand` (which cannot meaningfully fail for a built-in) — no special handling beyond the existing command-registration pattern; if VS Code ever rejects, it surfaces via the command's own error channel (no `console`).
- `setContext` is fire-and-forget (`void`) — a failure to set the context only means step 2 falls back to manual completion, never a crash.

## Testing

Unit tests (vscode stubbed), extending `test/unit/extension.test.ts`:
- **`nimbus.openWalkthrough`** invokes `commands.executeCommand("workbench.action.openWalkthrough", "nimbus-agent.nimbus-vscode#nimbusGettingStarted")`.
- **`nimbus.connected` context key:** on a connection transition to `connected`, `commands.executeCommand` is called with `("setContext", "nimbus.connected", true)`; on a non-connected state, with `false`.

Manifest/media correctness (the declarative walkthrough itself, markdown rendering, real step completion in the Welcome page) is **Layer 2** — verified by driving the walkthrough in an Extension Development Host (F5), since unit tests stub `vscode` and cannot render a walkthrough.

## Scope / out of scope

- **In:** the 6-step declarative walkthrough, `nimbus.openWalkthrough`, the `nimbus.connected` context key, 6 markdown media files, unit tests, README + CHANGELOG.
- **Out:** programmatic auto-open on first install, `globalState`, any shim change, screenshots/GIFs, telemetry, and any new setting.
- **Localization (review Q1):** **English-only**, consistent with the rest of the extension — there is no l10n / NLS infrastructure today (no `package.nls*.json`, no `l10n/` bundle; all UI strings are inline English). Localized walkthrough markdown (VS Code's l10n naming conventions) is out of scope; adding it for the walkthrough alone would be inconsistent with the codebase.

## Docs

- **README:** a short "Get Started" mention (the walkthrough appears on the Welcome page / via `Nimbus: Open Walkthrough`).
- **CHANGELOG:** a fresh `## Unreleased` entry (this ships in a release after `0.3.0`).
- **ROADMAP:** on ship, move the Walkthrough row from Phase 1 to **Already shipped** (completing Phase 1) — done at release time, per the graduation convention.

## Verification

Layer 1 gate (`test`, `typecheck`, `lint`, `build`, `check-bundle`, `check-settings-docs`) + Layer 2 EDH drive: open the walkthrough, confirm each step renders its markdown, the command buttons fire, and the "Connect" step auto-checks once a Gateway is connected.
