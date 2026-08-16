---
name: nimbus-vscode-seams
description: >
  The boundaries and duplicated sites in nimbus-vscode that a change has to
  respect: which `vscode` imports are actually allowed (the "shim only" rule in
  five docs is not what the code does), what the egress choke-point test
  enforces, which test layer runs where and why the ExTester UI suite cannot run
  in CI, the exact 18 files that ship in the .vsix and why one directory ships
  with no guard at all, and the five places the Quick Ask preset list is copied.
  Use when asking "does this ship to users", "why didn't my UI test run in CI",
  "what else do I have to update", "can I call the Gateway directly", "where do
  I put a new vscode API call", or when touching .vscodeignore, vitest.config.ts,
  resources/walkthrough/, or a release.
---

# nimbus-vscode — seams, gates, and duplicated sites

`.claude/skills/verify-extension/SKILL.md` is the **procedure**: the seven-command
gate, then drive it in an Extension Development Host. Run that. This file is the
facts behind it — what each gate does not cover, and which sites move together.

## 1. IPC-only: the part that isn't in CLAUDE.md

`CLAUDE.md` and `CONTRIBUTING.md` already state the rule (no monorepo imports, no
`workspace:*`, no direct cloud calls, no raw SQL — the last enforced by
`test/unit/no-raw-sql-guard.test.ts`, which fails on the string `querySql(`
anywhere under `src/`). Two consequences they don't spell out:

- **`@nimbus-dev/client` sits in `devDependencies`, and that is not a bug.**
  `esbuild.mjs` inlines everything except `vscode`, and both `bun run package` and
  `publish.yml` pass `vsce package --no-dependencies`, so no `node_modules` reaches
  a user from either section. `marked` and `dompurify` are in `dependencies` and
  are inlined identically. Do not "fix" this.
- **A missing Gateway capability is a blocked feature, not a workaround.** New
  capability is reached by bumping the pinned `@nimbus-dev/client` (`^0.17.0`)
  first. This is why `CLAUDE.md` records the share surface as *blocked upstream*
  rather than deferred: the pinned client exposes no `share*` RPCs, so the feature
  cannot be written here at all.

`scripts/check-bundle.mjs` is the runtime half — it regex-scans `dist/extension.js`
for `require("…")` and fails on any specifier outside node builtins + `vscode`.
**It is meaningless without a fresh `bun run build` first**: it reads whatever
`dist/` happens to contain, so on a stale `dist/` it reports on the last build.

## 2. The `vscode` boundary is NOT "only `vscode-shim.ts`"

Five places say it is:

`CLAUDE.md:48` · `CONTRIBUTING.md:61` · `docs/architecture.md:66` ("touched
**only** through") · `docs/development.md:95-96` ("routing all `vscode` access
through") · `.coderabbit.yaml:27`

Taken literally all five are **false**, and following them sends you refactoring
code that is already correct. The real shape:

- `src/vscode-shim.ts` imports **nothing** from `vscode` — zero occurrences. It is
  `*Like` interfaces plus `PROGRESS_LOCATION_NOTIFICATION = 15` (the concrete enum
  is not importable from a pure module).
- `import * as vscode from "vscode"` appears in exactly **eight** files:
  `src/extension.ts`, and the seven `real-*.ts` adapters — `briefs/real-hover.ts`,
  `chat/real-chat-panel.ts`, `chat-participant/real-participant.ts`,
  `context/real-context-view.ts`, `diagnostics/real-provider.ts`,
  `lm-tools/real-lm-tools.ts`, `scm/real-git.ts`.
- What the docs *mean* is the useful rule: **logic modules take a narrow `*Like`
  interface; the `vscode` API itself lives in a `real-*.ts` adapter.** New
  `vscode` surface goes in an adapter. Nothing enforces the seven-file list — it
  is convention, not a gate.
- `vitest.config.ts:31` aliases `vscode` → `test/unit/vscode-stub.ts`, so a
  `real-*.ts` file *can* be unit-tested; `test/unit/diagnostics-provider.test.ts`
  does exactly that.

Correcting the five docs is a worthwhile PR. Correcting three of them is worse
than none — the remaining two keep sending the next reader the same way.

## 3. The one enforced architectural gate: the egress choke point

`test/unit/egress-choke-point.test.ts`. Read it before touching anything
agent-bound:

- `.agentInvoke(` / `.askStream(` / `.workflowRunStream(` may appear only in
  `src/egress/gated-client.ts` plus five allowlisted consumers (`ALLOWED`, lines
  26–33). The nine gated `agents*` calls (lines 39–49) may appear **only** in
  `gated-client.ts`.
- The last test **discovers** `/\.agents[A-Z]\w*\(/` across all of `src/`, so a
  brand-new brief call fails the suite even if nobody edits the list.
  `.agentsWhyPeek(` is the single permitted exemption (it reaches no model).
- **It scans comments too.** Never write a dotted call example with a paren in a
  `src/` comment — write `agents*`.
- The allowlist is honour-system on purpose: the injected seam's extra
  `EgressMeta` parameter does not stop a raw client satisfying it (TS assigns a
  narrower function to a wider one). The assertion carrying the weight is that
  `extension.ts` — the only place holding a real client — never *names*
  `.agentInvoke` / `.askStream` / `.workflowRunStream`, member access included, so
  `client.askStream.bind(client)` cannot slip past.

## 4. Test layers — what CI can and cannot prove

| Layer | Runner / config | Runs in CI? |
| --- | --- | --- |
| `test/unit/**/*.test.ts` | vitest, `vitest.config.ts` | **Yes** — Ubuntu + a lean Windows job |
| `test/ui/**` (6 specs) | mocha via `scripts/run-ui-tests.mjs` + `.mocharc.ui.js` | **No** |

`test/ui` is **typechecked and linted in CI but never executed there**: the root
`tsconfig.json` includes `test/**/*` (12 `test/ui` files enter the program), and
`biome check .` covers the whole repo. A UI spec is compile-gated, not run-gated —
green CI says nothing about whether it passes.

Why it can't run in CI: ExTester's `openResources` relies on a CLI "reuse window"
handshake that never reaches the chromedriver-launched VS Code under headless
Linux — unfixed upstream (`vscode-extension-tester#506`), see
`docs/development.md:75-81`.

**Two comments in that script describe CI wiring that does not exist.** No
workflow in `.github/` or `.gitlab-ci.yml` mentions `test:ui` or `VSCODE_VERSION`
at all:

- `scripts/run-ui-tests.mjs:4-5` — "CI keys its download cache on the same value".
- `scripts/run-ui-tests.mjs:22-26` — "CI's own `Build` step (ci.yml), which still
  runs immediately before `test:ui` there". This one asserts CI *runs the suite*,
  which is the more misleading of the two.
- Adjacent third, different file: `esbuild.mjs:6` names `CI/publish-vscode.yml`.
  That workflow does not exist; it is `publish.yml`.

Believe the workflows, not these comments.

Four things in `run-ui-tests.mjs` that each cost an afternoon to rediscover:

- **Keep the ExTester JS API (`setupAndRunTests`), never `bunx extest`.** The
  specs read the fake Gateway off `globalThis.__nimbusFakeGateway`; the CLI form
  forks a fresh Node process that can never see it. Already tried and reverted.
- **`rmSync("out")` before `tsc -p tsconfig.ui.json`.** tsc leaves compiled specs
  for deleted/renamed sources behind, and a stale one keeps passing — already
  observed as 13 passing where 12 were expected.
- Settings go in the **generated, gitignored** `out/ui-settings.json`, installed at
  USER scope. Do not resurrect `test/ui/fixture-workspace/.vscode/settings.json`:
  a live socket path in a tracked file dirtied the worktree and once landed a
  personal path in a commit (`177ba5f`), and a workspace-scope value would
  override the user-scope one anyway.
- **`"window.dialogStyle": "custom"`** is written into those settings. ExTester
  already defaults it to `"custom"` (see the note at `run-ui-tests.mjs:84-86`), so
  it is defence against an upstream default change, not something load-bearing
  today — but if it ever stops being set, a modal `showWarningMessage` renders as a
  **native OS dialog** that Selenium cannot see, and every modal-gate spec hangs to
  timeout.

The fake Gateway is itself covered by the unit suite —
`test/unit/ui-fake-gateway.test.ts` speaks real NDJSON to it over a real socket.
That is how the harness stays honest while its own suite sits outside CI.

**Ambient-types footnote:** `@types/mocha` reaches the program transitively via
`vscode-extension-tester`'s `.d.ts` (despite `types: ["node"]`), so `describe` /
`it` typecheck *everywhere*, including `test/unit/`. Vitest runs with globals off,
so a unit test missing `import { describe } from "vitest"` typechecks clean and
fails only under `bun run test`.

## 5. What ships in the .vsix — 18 files, six of them prose

`.vscodeignore` is an **allowlist** (`**`, then `!` re-includes), because vsce's
denylist default fails open — every new top-level directory silently joins the
artifact, and this repo shipped 140 such files before the inversion.

The payload today (`vsce listFiles`, PackageManager.None):

```
package.json  icon.png  README.md  CHANGELOG.md  LICENSE  SECURITY.md
dist/extension.js  media/webview.js  media/webview.css
media/context.js  media/context.css  resources/nimbus.svg
resources/walkthrough/{welcome,connect,ask,search,quick-ask,explore}.md
```

**Six of the eighteen are `resources/walkthrough/*.md`** — user-facing onboarding
copy, wired to `contributes.walkthroughs[].steps[].media.markdown` in
`package.json` and rendered in the Get Started walkthrough. They sit next to
`docs/` in a file tree and read like internal notes, so they are routinely missed
when a feature's docs change. It has already happened: `296c852` corrected four
preset-enumeration sites and `fbc259e` had to come back for the walkthrough.

**How much the second guard actually catches.** `scripts/check-vsix-contents.mjs`
enforces the payload from the other side, so a new **top-level** path is two edits:
a `!` line in `.vscodeignore` *and* an entry in `ALLOWED_FILES`. But
`ALLOWED_DIRS = ["dist/", "media/", "resources/"]` is matched with `startsWith`
(line 31), and `.vscodeignore` already carries `!resources/**` — so **a new file
dropped anywhere under `resources/` ships to users with zero edits and zero guard
failures.** That is exactly the walkthrough directory. Its only presence check is
the `missing` list at line 60 — `dist/extension.js`, `media/webview.js`,
`media/context.js`, `media/context.css`, `package.json`, there so an empty
payload cannot satisfy an allowlist trivially (the ambient context panel added
the two `media/context.*` entries; it is the one artifact pair whose *presence*
is guarded, since `media/webview.css` still is not) — so the guard also cannot
tell you a walkthrough markdown
file went *missing*: delete or rename one
and it simply stops shipping, silently, leaving a broken walkthrough step. Nothing
validates that the `media.markdown` paths in `package.json` resolve. Only
`quick-ask.md` has any content guard at all (§6).

Also: `**/*.map` is the **last** line of `.vscodeignore` (last match wins), so
sourcemaps are excluded even from the re-included `dist/**`.

## 6. `DEFAULT_QUICK_ASK_PRESETS` — one list, five copies

SSoT: `src/quick-ask-presets.ts:14`. Pinned by
`test/unit/quick-ask-presets.test.ts:115-136` across five sites:

| Site | Anchor the test requires | Ships to users? |
| --- | --- | --- |
| `package.json` settings description | `Empty uses the built-in defaults (` | **Yes** — the VS Code Settings UI |
| `README.md:58` | `live as **Quick Ask presets**` | **Yes** — Marketplace / Open VSX listing |
| `docs/settings.md:73` | `Empty shows the built-in defaults (` | No |
| `docs/architecture.md:85` | `Resolves the configurable quick-ask preset actions (` | No |
| `resources/walkthrough/quick-ask.md` | `then pick a preset (` | **Yes** — in the .vsix |

Plus a sixth assertion over the copy-this-block jsonc at `docs/settings.md:83-89`.

Three things to know before touching the list:

- **`resolvePresets` replaces; it does not merge** (`src/quick-ask-presets.ts:70-85`).
  A non-array, or a list whose every entry is invalid, falls back to the defaults —
  but a list with even one valid entry replaces them **wholesale**. That is why
  `docs/settings.md` offers a full five-entry starter block: anyone who copies a
  stale four-entry block permanently loses the fifth default, with nothing to tell
  them. Adding a default means editing that block too.
- **The guard's strength is per-label, not per-file.** The anchor proves the
  *sentence* still exists, but the label check is `src.includes(label)` over the
  **whole file** (lines 132–135). So whether a dropped label is caught depends on
  the label: outside the enumeration sentence, `Write tests` occurs **0** times in
  `package.json` and **0** in `docs/architecture.md` (dropping it there really does
  fail), while `Explain` occurs **4** times in `package.json` (dropping it there
  passes silently). `resources/walkthrough/quick-ask.md` is the only fully tight
  site — 0 other occurrences of any label. Read the sentences; a green run does not
  mean all five are intact.
- The site list is itself an allowlist and has gone stale once already — see §5.

Two adjacent facts: the ops presets (`Blast radius` / `Ownership` /
`Recent changes`, via `filePresetsFor`) are prepended **on infra files only** and
cannot then be configured away — Terraform, Dockerfiles, `.github/workflows/*.yml`,
or YAML that looks like Kubernetes/Helm; `filePresetsFor` returns `[]` for anything
else (`src/quick-ask-presets.ts:47-63`, wired at `src/extension.ts:1054-1059`). And
`bun run check-settings-docs` catches **none** of this — for each of the 16
`nimbus.*` properties it asserts only that a `### \`nimbus.x\`` heading exists in
`docs/settings.md` and a `| \`nimbus.x\` |` row exists in `README.md`. Presence,
never content.

## 7. Coverage exclusions live in two files, and have drifted

`vitest.config.ts:15-23` (`coverage.exclude`) and `sonar-project.properties`
(`sonar.coverage.exclusions`) are independent lists. A file must be in **both** to
leave both denominators. Current state:

- `src/scm/real-git.ts` — excluded in vitest, **not** in Sonar (and undocumented).
- `src/chat/webview/main.ts` — excluded in Sonar, deliberately measured by vitest
  under jsdom (documented in the properties file).
- `src/briefs/real-hover.ts` — a `vscode`-touching adapter in **neither** list and
  with no test of its own.

Sonar's gate blocks via `sonar.qualitygate.wait=true`, but the whole analysis step
is `if: env.SONAR_TOKEN != ''` — so **a green Sonar check does not prove a scan
ran.** (The 80%-on-new-code figure comes from `vitest.config.ts:25`, not from
SonarCloud's own configuration; treat it as the local intent.)

## 8. Release: the PR title, the tag identity, and one dated credential

Full runbook is `docs/releasing.md`. The parts that bite:

- `pr-title-lint.yml` (amannn/action-semantic-pull-request) fails a
  non-Conventional PR title — and the title is what release-please reads.
- **The tag identity matters more than the tag.** `release-please.yml` mints a
  "Nimbus Release Bot" App token (org secrets `RELEASE_BOT_CLIENT_ID` /
  `RELEASE_BOT_PRIVATE_KEY`) precisely because a tag pushed by `GITHUB_TOKEN`
  **does not fire `publish.yml`**. If a release PR merges and nothing publishes,
  check that first.
- `publish.yml` stamps the version from the tag (`npm pkg set version`), re-runs
  the same pre-build gates CI runs, and packages `nimbus-<version>.vsix`.
- **`VSCE_PAT` and `OVSX_PAT` are still repository secrets**, not `release`
  environment secrets — every workflow on this repo can read them. The
  `environment: release` declaration plus its `main` + `v*` branch policy narrows
  who can *deploy*, not who can *read*. Closing it means deleting the repo-scoped
  copies (`docs/releasing.md:41-55`).
- **`VSCE_PAT` has a declared expiry of `2026-09-20`** (`scripts/secret-health.ts:61`).
  `secret-health.yml` (Mondays 09:00 UTC) warns from 90 days out and escalates to a
  **job failure plus a filed issue at 14 days — i.e. from 2026-09-06**
  (`EXPIRY_CRITICAL_DAYS = 14`, `severityOf` → `hard`). That map is a **mirror**;
  the source of truth is `scripts/release/credential-registry.ts` in
  `nimbus-agent/Nimbus`. Update the registry first, the mirror second. Drift can
  only cause a spurious warning — a live probe is never softened by a date.
- The GitLab warm-standby mirror (`.gitlab-ci.yml`) carries an
  `apt-get install git` step that is load-bearing: `oven/bun` ships without git,
  and biome's `vcs.useIgnoreFile: true` then scans `node_modules`.

## Coupled sites — change one, change all

- New shippable **top-level** file → `.vscodeignore` **and**
  `scripts/check-vsix-contents.mjs`. Under `resources/`, neither — see §5.
- New CI gate → `.github/workflows/ci.yml` **and** `.gitlab-ci.yml`, whose
  `build-test` job re-lists the same seven `bun run` gates in order and whose own
  header says it is kept in sync with `package.json` scripts.
- New `nimbus.*` setting → `package.json` **and** `docs/settings.md` (`###`
  heading) **and** the `README.md` table row (`check-settings-docs` enforces all
  three).
- New default Quick Ask preset → `src/quick-ask-presets.ts` **and** all five sites
  in §6 **and** the jsonc starter block.
- New coverage exclusion → `vitest.config.ts` **and** `sonar-project.properties`.
- New contributed command / view / LM tool → `package.json` **and** the matching
  `test/unit/manifest-*.test.ts`, which pin the manifest against the source SSoT
  (`BRIEF_CATALOG`, `DIAGNOSTIC_COMMANDS`, …).
- Any edit to `.github/workflows/dependabot-lockfile.yml` → four safety properties
  are pinned by `test/unit/dependabot-lockfile-workflow.test.ts` (actor gate,
  `--ignore-scripts`, `persist-credentials: false`, `head.sha` checkout). It is the
  only `pull_request_target` workflow that checks out **the PR author's tree** with
  a write-capable token; a unit test failing there is the intended signal.
  `cla.yml` is the other `pull_request_target` workflow — also write-capable
  (`actions`/`pull-requests`/`statuses: write`) — but it checks out nothing and has
  no pinning test.
- Any new agent-bound call → route it through `src/egress/gated-client.ts`. Do not
  widen `ALLOWED` in `egress-choke-point.test.ts`.

## Running the gates

`.claude/settings.json` pre-approves `bun run test|typecheck|lint|build|check-bundle|check-settings-docs`
and `bunx vitest run`. It does **not** cover `check-vsix-contents`, `test:ui` or
`package` — those prompt. Worth knowing before you assume a run stalled.
