# A UI test harness for the briefs, over a fake Gateway

**Status:** design, approved 2026-08-11. To ship inside the briefs PR 3 branch
(`feat/briefs-pr3`), by explicit decision — see *Delivery* for what that costs.

## The problem

`bun run test` stubs `vscode` (`test/unit/vscode-stub.ts`, aliased in
`vitest.config.ts`). That is the right shape for the pure modules and it carries
932 tests, but by construction it cannot prove that a command is reachable, that
an input box appears, that a validation message renders, that a modal blocks a
send, or that a parameter survives the trip to a socket. The repo's own
`verify-extension` skill acknowledges this and defines Layer 2 as *press F5 and
drive it by hand*.

For the briefs that manual pass is six checks long, and it has to be repeated on
every change to the surface. This design replaces it with tests.

## What is verified, and what is assumed

Every protocol claim below was checked against the installed client
(`@nimbus-dev/client` 0.16.0, `@nimbus-dev/sdk` 1.16.0) rather than recalled:

- **Framing is NDJSON** — one JSON-RPC 2.0 object per line, over a Unix socket
  or a Windows named pipe (`dist/ipc-transport.js`, using `NdjsonLineReader`
  from `@nimbus-dev/sdk/ipc`).
- **Connecting requires no handshake.** `NimbusClient.open` constructs an
  `IPCClient` and awaits `ipc.connect()` — a plain socket connect. A server that
  merely listens is enough for the extension to report *connected*.
- **Briefs are two-step.** `agents.<name>` responds `{ sessionId }` immediately;
  the Gateway then emits **either** `<agent>.briefReady` with
  `{ sessionId, brief, findings }` **or** `<agent>.briefError` with
  `{ sessionId, error }` (`dist/agents.js`). The typed client method resolves or
  rejects off that notification. A fake that answers only the request hangs the
  call until the 30 s agent timeout.
- **The socket path is overridable** from the `nimbus.socketPath` setting, which
  reaches `discoverSocket(override?)` in `src/connection/connection-manager.ts`.

The one thing this design **assumes** rather than verifies is that the fake's
canned responses match what a real Gateway would send. See *Drift* below.

## Decisions taken

### A fake Gateway, not a real one

The extension is a thin IPC client: a brief produces nothing without a Gateway
answering on a socket. Running a real Gateway in CI would need an install, an
index of the workspace, and an LLM provider — cost, network, and
non-determinism, in the flakiest possible place. A fake gives deterministic
responses, needs no model, and runs anywhere.

It also buys something a real Gateway would not: the fake **records what it
receives**, so the suite can assert at the wire what the unit tests can only
approximate — that `why` sends a 1-based line, that `/blast` sends a basename
rather than a home directory, and that Cancel sends *nothing at all*. That is
the invariant this branch exists to protect, checked at the boundary where it
would actually be violated.

### All six briefs, not just PR 3's two

The harness costs the same whether it drives two briefs or six. The briefs
surface was built across three PRs and none of it has ever been exercised
against a real VS Code, so the suite drives `why`, `ghost`, `huddle`,
`janitor` and `preflight` end to end through the gate. `conflicts` is not
driven by any spec — it is only asserted present in the editor context menu
(Coverage, Group A), which is a narrower claim than the other five get.

### A separate, PR-gating CI job

A suite that does not gate merges relies on somebody remembering to run it,
which is the manual pass with extra steps. It runs as its own job so its runtime
and its flakes are isolated from the existing 15-minute `build-test` job.

## Architecture

Three pieces under a new `test/ui/`, kept apart from `test/unit/` because they
share no runner, no stub, and no assumptions.

### `test/ui/fake-gateway.ts`

A `net.createServer` speaking the protocol above. Responsibilities, and nothing
else:

- Parse NDJSON requests; write NDJSON responses and notifications.
- For `agents.*`: reply `{ sessionId }`, then emit `<agent>.briefReady` with a
  canned `findings` payload — or `<agent>.briefError` when a test has queued a
  failure for that method.
- For everything the extension calls incidentally (`searchRanked`,
  `egressHead`, `queryItems`, …): a minimal canned reply, enough not to break
  the surfaces under test.
- **Record every request** — method and params — and expose them for assertions.
- Expose a small control surface to the specs: `queueError(method, detail)`,
  `requests()`, `reset()`.

It is a test fixture, not a Gateway simulator. It does not index, rank, or
reason; it returns shapes.

#### It listens on a Unix socket **or** a Windows named pipe

Raised in review, and more load-bearing than it first appears: this repo's
primary developer works on Windows. A fake that only binds a Unix socket would
mean the person who asked for these tests cannot run them on their own machine —
the manual pass would survive locally and only CI would be automated.

`net.createServer` binds a named pipe transparently given a `\\.\pipe\<name>`
path, and the client's transport already speaks both (`dist/ipc-transport.js`
imports `platform` from `node:os` for exactly this). **Verified on win32 during
this design**, not assumed: a named pipe carried the full NDJSON two-step
exchange — request → `{sessionId}` → `janitor.briefReady` — end to end.

So the path is chosen by platform:

```ts
const socketPath = process.platform === "win32"
  ? `\\\\.\\pipe\\nimbus-ui-${process.pid}`
  : join(tmpdir(), `nimbus-ui-${process.pid}.sock`);
```

#### Lifecycle, and why the path carries the PID

Also raised in review. The runner owns the fake: it starts before the ExTester
session and is killed in a `finally`, so a crashed or interrupted run cannot
leave one behind.

The **PID in the path is the real defence**, not the cleanup. A fixed path plus a
stale socket file is `EADDRINUSE`, and the failure mode is miserable — the next
run fails for a reason that has nothing to do with the change under test. A
per-process path makes a leftover harmless. On POSIX the runner also unlinks its
own socket file on exit; Windows named pipes are kernel objects and disappear
with the process, so there is nothing to unlink there.

### `test/ui/fixture-workspace/`

A checked-in workspace ExTester opens: two or three small source files to run
briefs against, and a `.vscode/settings.json` pointing `nimbus.socketPath` at
the fake's socket. Its files are fixtures — their content is asserted against,
so they must not be edited casually.

### `test/ui/specs/`

ExTester ([`vscode-extension-tester`](https://github.com/redhat-developer/vscode-extension-tester),
8.23.0) specs, driving VS Code through Selenium at the DOM level: `InputBox`,
`QuickPick`, notifications, modal dialogs, the editor, and the activity-bar
tree.

**Page objects only.** Specs use ExTester's own page objects (`InputBox`,
`QuickPick`, `ActivityBar`, `Notification`, `ModalDialog`) and never raw CSS or
XPath. Raised in review and worth making a rule rather than a preference: a raw
selector is a bet on VS Code's internal DOM, and losing that bet looks like a
product regression rather than a broken locator. Where a page object genuinely
cannot reach something, the selector is isolated in
`test/ui/helpers/selectors.ts` — one file to fix when an upgrade moves the DOM,
instead of a search across the suite.

**One pinned VS Code version, in one place.** Also from review, and it matters
because a VS Code upgrade is the single most likely cause of a Selenium suite
breaking overnight. The version is pinned once — in the `test:ui` script's
ExTester invocation — and both local runs and CI read it from there. CI's
download cache is keyed on that same value, so a bump invalidates the cache in
the same commit that changes the version, and local and CI can never silently
diverge.

## Coverage

**Group A — flows that never send.** Nothing reaches the fake; these assert the
extension's own behaviour up to the send.

| Case | Asserts |
|---|---|
| Editor context menu | why / ghost / conflicts present; janitor / preflight absent |
| Command palette | all six briefs offered |
| Janitor prompt | prefilled with the active file's repo-relative ref |
| Idle-days validation | `-5`, `2.5`, `0`, `abc` each show the inline message; `30` and blank accepted |
| Escape on idle-days | no request reaches the fake, and no error notification appears |
| Preflight namespace | empty answer cancels; nothing sent |
| Namespace prefill | first run types it; second run in the same folder offers it back |
| Non-file editor | a brief invoked over a read-only tab reports "Open a file to run …" |

**Group B — through the gate.**

| Case | Asserts |
|---|---|
| Modal content | names the brief and the ref it would send |
| Cancel | `fake.requests()` is empty |
| Send | the brief renders in a read-only tab with the fixture's content |
| Line number | the recorded `why` params carry the **1-based** line |
| Brief error | a queued `briefError` surfaces the Gateway's detail with a **Retry** |

**Group C — the participant. Mostly NOT ACHIEVABLE; corrected during implementation.**

This group rested on an assumption that proved false: that the ops slash commands could be invoked the way the briefs are. They cannot. `/incident`, `/deploys`, `/owns` and `/blast` are contributed only under `contributes.chatParticipants[].commands` and are reachable exclusively by typing `@nimbus /blast` into VS Code's built-in Chat view — none has a command-palette entry.

And **ExTester 8.23.0 ships no page object for the Chat view.** Verified: `@redhat-developer/page-objects/out/components/` contains no chat component at all. Driving it would require raw CSS or XPath against VS Code's internal DOM, which this design rules out — and rules out for exactly the reason that would bite here, since such a selector breaks on a VS Code upgrade and the breakage reads as a product regression.

| Case | Status |
|---|---|
| Ledger — *Show Last Outbound Payload* reflects a real recorded send | ✅ covered, via an editor brief driven through the gate |
| `/blast` answers with **no modal** | ❌ not achievable; stays unit-test-only |
| Redaction — the recorded `impact` params carry a basename | ❌ not achievable; stays unit-test-only |

The redaction gap is the one that stings, because that behaviour is load-bearing: `/blast` with no argument previously sent an absolute local path containing the OS username, and the fix landed in this same branch. Unit tests do assert the whole RPC payload with `toEqual`, which is real coverage — just not the wire-level, real-VS-Code proof this suite was meant to add. Recorded here rather than quietly dropped: a coverage claim nobody checks is worse than a stated gap.

Revisit if ExTester gains a Chat page object.

## Drift, and the limit of this approach

A fake can pass while the real contract has moved. Two mitigations, and one
acknowledged gap:

- **Type the fixtures with the real SDK types** — `const brief: JanitorBrief =
  {…}`. A client bump that changes a brief's shape then fails `bun run
  typecheck` rather than passing against a fiction.
- **Reuse the published mock where it exists.** `MockNimbusClient` ships
  `WHY_BRIEF_FIXTURE`; use it for `why` rather than hand-rolling.
- **The gap:** neither catches *behavioural* drift — a Gateway that starts
  rejecting a parameter, or renames a notification. Only a real Gateway catches
  that. This design accepts the gap; a scheduled run against a real Gateway is
  the natural follow-up if drift ever bites, and is explicitly not built here.

## CI

**Not wired up.** The `ui-test` job this section originally specified —
`ubuntu-24.04` under `xvfb`, running `bun run test:ui` — was added to
`.github/workflows/ci.yml` and then removed: ExTester's `openResources` relies
on a CLI "reuse window" handshake that never reaches the chromedriver-launched
VS Code instance on headless Linux, a known, unfixed upstream limitation
([redhat-developer/vscode-extension-tester#506](https://github.com/redhat-developer/vscode-extension-tester/issues/506)).
All nine of the job's failures on its first real run traced back to that one
mechanism. See `.superpowers/sdd/2026-08-11-ui-test-harness/ci-failure-diagnosis.md`
for the full diagnosis.

The suite ships **local-only** for now: run it yourself with `bun run
test:ui` (`xvfb-run -a bun run test:ui` on headless Linux). A follow-up will
add the CI job back once a workaround — driving the folder/file open through
Selenium instead of the CLI reuse handshake — is verified against a real run.

The lean Windows job is unchanged: it stays typecheck + test + build + the two
bundle guards, and runs no UI tests.

## Flake control

Selenium suites are the flakiest thing in most repos that have them, and this
one gates merges. Three rules from the start, not after the first bad week:

1. **Explicit waits on conditions**, never fixed sleeps.
2. **Mocha retries of 2** for the whole UI suite — a genuine regression fails
   three times; a race usually does not.
3. **Keep it tight.** If a case is better covered by a unit test, it belongs in
   `test/unit/`. This suite exists for what only a real VS Code can prove.
4. **`fake.reset()` in a root `afterEach`.** Raised in review. The fake carries
   two pieces of mutable state — the recorded requests and any queued error — and
   both leak across tests if not cleared. A leaked queued error is the worse of
   the two: it surfaces as a *later, unrelated* brief failing, which reads as a
   product bug and is expensive to chase. Resetting in `afterEach` rather than
   `beforeEach` also leaves the state intact for inspection when a test fails.

A test that flakes twice in a week gets deleted or fixed, not retried harder.

## Delivery

This lands inside the `feat/briefs-pr3` branch, by explicit decision. The cost,
recorded so it is not a surprise: the branch had already passed its final
whole-branch review at `969294b`, so the added harness needs that review re-run
over it before merge, and the PR grows by a runner, a fake server, a fixture
workspace and a CI job.

Suggested commit sequencing: the fake Gateway and its own tests first (it is
pure Node and unit-testable), then the fixture workspace and runner config, then
the specs by group, then the CI job.

## Out of scope

- **Quick Ask, the SCM trio, the chat webview, the other sidebar trees.**
  Reachable with the same harness later; including them now would make the test
  infrastructure larger than the feature it ships beside.
- **A real Gateway anywhere in CI.** See *Drift*.
- **Windows UI runs *in CI*.** The lean Windows job stays lean and runs no UI
  tests. Local Windows runs are explicitly *in* scope — see the named-pipe
  section above; this exclusion is about CI cost, not developer platform.
- **A `--headless` flag.** Raised in review, and declined on feasibility rather
  than effort. VS Code is an Electron app with no supported headless mode, so
  there is nothing for such a flag to bind to on Windows or macOS — the two
  platforms the suggestion was meant to help. On Linux the answer already exists
  and is what CI uses: run the suite under `xvfb-run`, which needs no flag from
  us. Adding a `--headless` option that works on one platform and silently does
  nothing on the others would be worse than not having it. Documenting the
  `xvfb-run` invocation for Linux developers covers the real need.
- **Replacing any unit test.** This suite is additive. Nothing in `test/unit/`
  is deleted because a UI test now covers it — they fail for different reasons
  and that is the point.
