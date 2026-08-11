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
(`@nimbus-dev/client` 0.15.1, `@nimbus-dev/sdk` 1.10.0) rather than recalled:

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
against a real VS Code, so the suite covers `why`, `ghost`, `conflicts`,
`huddle`, `janitor` and `preflight`.

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

**Group C — the participant.**

| Case | Asserts |
|---|---|
| `/blast` | answers with **no modal** |
| Redaction | the recorded `impact` params carry a basename, never an absolute path |
| Ledger | *Show Last Outbound Payload* shows the recorded send |

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

A new `ui-test` job in `.github/workflows/ci.yml`:

- `ubuntu-24.04`, same hardened setup as `build-test` (pinned action SHAs,
  `harden-runner` with `egress-policy: audit` — the VS Code and chromedriver
  downloads are network egress and are permitted-and-logged under that policy).
- `xvfb` for a display.
- The ExTester VS Code download cached, keyed on the pinned VS Code version.
- Its own timeout (~25 minutes), so it cannot consume `build-test`'s 15.
- Runs `bun run test:ui`.

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
- **Windows UI runs.** The lean Windows job stays lean; named-pipe support in
  the fake is not built until something needs it.
- **Replacing any unit test.** This suite is additive. Nothing in `test/unit/`
  is deleted because a UI test now covers it — they fail for different reasons
  and that is the point.
