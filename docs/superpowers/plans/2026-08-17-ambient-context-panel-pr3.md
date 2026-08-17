# Ambient Context Panel — PR 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the ambient context panel — fix the five defects the first
real-editor pass found, add the `nimbus.context.enabled` toggle, cover the
surface with a real-VS-Code spec, and bring the docs level with what ships.

**Architecture:** No new subsystem. Every change lands in a module that already
exists: the two pure signal collectors (`src/context/signals.ts`), the git seam
(`src/scm/git-types.ts` + `real-git.ts`), the `vscode` glue
(`src/context/real-context-view.ts`), the shared egress preview
(`src/egress/preflight.ts`), and the manifest. The one genuinely new file is the
ExTester spec.

**Tech Stack:** TypeScript (strict, no `any`), Vitest with the `vscode` stub,
esbuild, ExTester/Selenium for the real-VS-Code layer, `@nimbus-dev/client` for
typed IPC.

**Spec:** [`docs/superpowers/specs/2026-08-16-ambient-context-panel-design.md`](../specs/2026-08-16-ambient-context-panel-design.md)
— PR 3 is the *polish* slice at the end of its Delivery section.

**Findings this plan answers:** [`2026-08-17-context-panel-f5-findings.md`](./2026-08-17-context-panel-f5-findings.md)
(F1–F5). Read it before Task 1: it is the record of what the panel actually does
in a real editor, and several tasks below exist only because of it.

## Global Constraints

- TypeScript **strict**, **no `any`** — use `unknown` for external data. Biome
  enforces `noExplicitAny`, `noConsole` in `src/`, `noNonNullAssertion`.
- Log through the output channel (`src/logging.ts`), never `console`.
- The `vscode` API is touched only in the glue files that already touch it —
  in `src/context/` that is `real-context-view.ts` and nothing else.
- `src/context/` must never reach `.agentInvoke` or `.askStream`.
  `test/unit/egress-choke-point.test.ts` fails if it does.
- Every `nimbus.*` setting must be documented in `docs/settings.md` or
  `bun run check-settings-docs` fails in CI.
- The full local gate is: `bun run test && bun run typecheck && bun run lint &&
  bun run build && bun run check-bundle && bun run check-vsix-contents &&
  bun run check-settings-docs`.
- Conventional-Commit titles: the repo squash-merges and Release Please reads
  the PR title.

---

### Task 1: Related stops listing the open file's own symbols

**Files:**
- Modify: `src/context/signals.ts:179-218` (`relatedSection`)
- Test: `test/unit/context-signals-related.test.ts`

**Interfaces:**
- Consumes: `ContextClientLike["searchRanked"]`, whose items are
  `RankedSearchItem` — `NimbusItem & { score, indexPrimaryKey, … }`, where
  `NimbusItem` carries `rawMeta?: Record<string, unknown>`.
- Produces: no signature change. `relatedSection(snapshot, deps)` keeps
  returning `Promise<SignalSection>`.

**Why:** F2. The current self-exclusion is `i.name !== snapshot.path`. Index item
names are symbol names (`"runOpsCommand (function)"`), never repo-relative paths,
so it never fires. Observed in a real editor: three identical
`runOpsCommand (function)` rows on `ops-commands.ts`, six alternating
`createLogger`/`errMsg` rows on `logging.ts` — every row a symbol from the file
already on screen. The field that can actually carry the answer is
`rawMeta.file`, which the live Gateway populates with the repo-relative path.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/context-signals-related.test.ts`. Note the existing `item()`
helper takes `(name, service)`; add a second helper rather than changing it, so
the file's other cases keep compiling unchanged:

```ts
const itemInFile = (name: string, service: string, file: string): Item =>
  ({
    name,
    service,
    indexPrimaryKey: `${service}:${name}:${file}`,
    score: 1,
    rawMeta: { file },
  }) as unknown as Item;
```

```ts
test("excludes items whose rawMeta.file is the open file", async () => {
  const section = await relatedSection(
    buildSnapshot({ generation: 10, editor }),
    deps(
      stub([
        itemInFile("aThing (function)", "filesystem", "src/a.ts"),
        itemInFile("bThing (function)", "filesystem", "src/b.ts"),
      ]),
    ),
  );
  expect(section.rows.map((r) => r.label)).toEqual(["bThing (function)"]);
});

test("collapses duplicate rows for the same symbol in the same file", async () => {
  const section = await relatedSection(
    buildSnapshot({ generation: 11, editor }),
    deps(
      stub([
        itemInFile("bThing (function)", "filesystem", "src/b.ts"),
        itemInFile("bThing (function)", "filesystem", "src/b.ts"),
        itemInFile("bThing (function)", "filesystem", "src/c.ts"),
      ]),
    ),
  );
  expect(section.rows.map((r) => r.label)).toEqual(["bThing (function)", "bThing (function)"]);
  expect(section.rows.map((r) => r.detail)).toEqual(["filesystem", "filesystem"]);
});

test("excludes the open file when the index holds it under a longer root", async () => {
  // The live index really does carry both shapes: rawMeta.file is
  // repo-root-relative, so a file indexed while it sat in a git worktree keeps
  // that prefix, while snapshot.path is workspace-root-relative.
  const section = await relatedSection(
    buildSnapshot({ generation: 14, editor }),
    deps(
      stub([
        itemInFile("aThing (function)", "filesystem", ".claude/worktrees/wt/src/a.ts"),
        itemInFile("bThing (function)", "filesystem", "src/b.ts"),
      ]),
    ),
  );
  expect(section.rows.map((r) => r.label)).toEqual(["bThing (function)"]);
});

test("does not collapse same-named items from different services", async () => {
  const section = await relatedSection(
    buildSnapshot({ generation: 15, editor }),
    deps(stub([item("deploy failed", "jira"), item("deploy failed", "slack")])),
  );
  expect(section.rows.map((r) => r.detail)).toEqual(["jira", "slack"]);
});

test("collapses same-named items from one service that carry no file", async () => {
  // Five github_actions rows for one commit's re-runs differ only by run id.
  const section = await relatedSection(
    buildSnapshot({ generation: 16, editor }),
    deps(stub([item("nightly — success", "github_actions"), item("nightly — success", "github_actions")])),
  );
  expect(section.rows).toHaveLength(1);
});

test("keeps an item whose rawMeta carries no usable file", async () => {
  const section = await relatedSection(
    buildSnapshot({ generation: 12, editor }),
    deps(stub([item("an-incident", "pagerduty")])),
  );
  expect(section.rows.map((r) => r.label)).toEqual(["an-incident"]);
});

test("says the file has no neighbours when every hit is from the file itself", async () => {
  const section = await relatedSection(
    buildSnapshot({ generation: 13, editor }),
    deps(stub([itemInFile("aThing (function)", "filesystem", "src/a.ts")])),
  );
  expect(section.rows).toEqual([]);
  expect(section.empty).toBe("Nothing else in the local index looks related.");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/context-signals-related.test.ts`
Expected: FAIL — the `rawMeta.file` case still renders both rows, the duplicate
case renders three, and the empty text is the old
`"Nothing related in the local index."`.

- [ ] **Step 3: Implement**

Replace the `try` block body of `relatedSection` (`src/context/signals.ts:189-208`):

```ts
  try {
    const items = await client.searchRanked({ name: query, limit: deps.searchLimit() });
    // The file an item came from, when the Gateway recorded one. Typed as
    // unknown because rawMeta is Record<string, unknown> — an index that
    // stores something other than a string here must not throw.
    const fileOf = (i: (typeof items)[number]): string | undefined => {
      const raw = i.rawMeta?.["file"];
      return typeof raw === "string" ? raw : undefined;
    };
    // rawMeta.file is REPO-root-relative; snapshot.path is WORKSPACE-root-
    // relative. They coincide when the workspace is the repo root and diverge
    // otherwise — verified against this repo's own live index, which holds
    // ".claude/worktrees/ambient-context-panel/src/context/controller.ts"
    // beside "src/chat-participant/ops-commands.ts". An `===` test excludes the
    // second and silently keeps the first, which is the staler row and the one
    // most worth dropping. Comparing the whole relative path as a suffix
    // handles both and is still specific: "…/src/context/controller.ts" ends
    // with "/src/context/controller.ts"; "src/other/controller.ts" does not.
    // Both sides are POSIX-style already — the Gateway stores forward slashes,
    // toRelativeRef normalises to them — so no slash rewriting is done here.
    // Inventing one would hide a genuine mismatch rather than fix it.
    const sameFile = (file: string | undefined, path: string | undefined): boolean => {
      if (file === undefined || path === undefined) return false;
      return file === path || file.endsWith(`/${path}`) || path.endsWith(`/${file}`);
    };
    const seen = new Set<string>();
    const rows: SignalRow[] = [];
    for (const i of items) {
      const file = fileOf(i);
      // Self-exclusion, the version that actually fires. An item's `name` is a
      // SYMBOL name ("runOpsCommand (function)"), never a repo-relative path,
      // so the old `i.name !== snapshot.path` rule never matched anything and
      // the panel filled with the open file's own symbols. rawMeta.file is the
      // field that carries the path. The name comparison stays as a second
      // rule for services that key an item by its path.
      if (sameFile(file, snapshot.path)) continue;
      if (i.name === snapshot.path) continue;
      // The index can hold several rows for one symbol (a re-index that did not
      // supersede the old row, a duplicate chunk). Three identical rows waste
      // the section; one row per (name, file) does not.
      //
      // The fallback for an item with no file is its SERVICE, not "". The index
      // really does return same-named rows with no file — five github_actions
      // rows for one commit's re-runs, differing only by run id — and
      // collapsing those is the point. An empty fallback would also collapse a
      // Jira ticket and a Slack message that happen to share a title, which are
      // different things the user needs to see separately.
      //
      // "\u0000" as the separator, written as an escape and never as a raw
      // byte: a name containing the separator must not be able to collide with
      // a different (name, file) pair.
      const key = `${i.name}\u0000${file ?? i.service}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        label: i.name,
        ...(i.service.length > 0 ? { detail: i.service } : {}),
        iconId: "file",
      });
    }
    if (rows.length === 0) {
      // Says what is true after the exclusion above: the index may well hold
      // this file, just nothing ELSE that ranks against it.
      return { ...base, rows, empty: "Nothing else in the local index looks related." };
    }
    return { ...base, rows };
  } catch (e: unknown) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/context-signals-related.test.ts`
Expected: PASS, including the file's pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/context/signals.ts test/unit/context-signals-related.test.ts
git commit -m "fix(context): stop Related listing the open file's own symbols"
```

---

### Task 2: The changed-file count counts what its label claims

**Files:**
- Modify: `src/scm/git-types.ts:18-44` (add `stagedPathsNow` to `GitRepositoryLike`)
- Modify: `src/scm/real-git.ts` (implement it over the git extension's state)
- Modify: `src/context/real-context-view.ts:59-77` (`gitSummary`)
- Modify: `src/context/snapshot.ts` (`GitSummary.changedPaths` stays; no shape change)
- Modify: `src/context/signals.ts:100-116` (`gitSection`)
- Test: `test/unit/context-signals.test.ts`

**Interfaces:**
- Consumes: `GitRepositoryLike.changedPathsNow(): readonly string[]`.
- Produces: `GitRepositoryLike.stagedPathsNow(): readonly string[]` — the
  index-vs-HEAD paths the git extension has already materialised, repo-relative,
  no subprocess. Every fake `GitRepositoryLike` in `test/` must gain it.

**Why:** F3, which PR 2 predicted and this pass confirmed against `git status`:
a clean tree reads `0 changed files`; one untracked file reads `1 changed file`;
**staging that same file drops it back to `0 changed files`** while
`git status --short` shows `A  f5-untracked.txt`. `changedPathsNow` reads
`workingTreeChanges`, which is unstaged-only and (under the default
`git.untrackedChanges: "mixed"`) includes untracked files.

**The decision this task takes:** "changed files" means **not yet committed** —
the union of working-tree and index changes, deduped by path. That is what the
label already promises and what `git status` shows. The alternative (relabel to
"unstaged") keeps the seam smaller but leaves the panel disagreeing with the
number in the SCM view.

Also from F3: with nothing changed the row now reads `0 changed files`. It is
omitted instead — a zero row is noise, and the branch row already proves the
section looked.

- [ ] **Step 1: Write the failing tests**

In `test/unit/context-signals.test.ts`, alongside the existing `gitSection`
cases:

```ts
test("counts a path once when it is both staged and modified", () => {
  const section = gitSection(
    buildSnapshot({
      generation: 1,
      git: { branch: "main", changedPaths: ["src/a.ts", "src/b.ts"] },
    }),
  );
  expect(section.rows[1]?.label).toBe("2 changed files");
});

test("omits the count row entirely when nothing has changed", () => {
  const section = gitSection(
    buildSnapshot({ generation: 2, git: { branch: "main", changedPaths: [] } }),
  );
  expect(section.rows.map((r) => r.label)).toEqual(["main"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run test/unit/context-signals.test.ts`
Expected: FAIL on the second case — it currently renders `0 changed files`.

- [ ] **Step 3: Omit the zero row**

In `src/context/signals.ts`, replace the `if (changed !== undefined)` guard
(`:109`):

```ts
  const changed = git.changedPaths;
  // Only when the collector actually looked AND has something to report. An
  // unread changedPaths renders no row: "0 changed files" beside a correct
  // branch name is a statement the panel has not earned. A read that found
  // nothing renders no row either — the branch row already shows the section
  // looked, and a zero is noise on the majority of ticks.
  if (changed !== undefined && changed.length > 0) {
```

- [ ] **Step 4: Run to verify Step 1's tests pass**

Run: `bunx vitest run test/unit/context-signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the seam verb**

In `src/scm/git-types.ts`, after `changedPathsNow` (`:29`):

```ts
  /**
   * The INDEX-vs-HEAD paths the git extension has already materialised — what a
   * commit would contain. Same discipline as changedPathsNow: state in hand, no
   * subprocess, repo-relative. The context panel unions the two, because
   * `changedPathsNow` alone is unstaged-only, so staging a file made the panel's
   * "changed files" count FALL while `git status` still showed the change.
   */
  stagedPathsNow(): readonly string[];
```

- [ ] **Step 6: Implement it in the adapter**

In `src/scm/real-git.ts`, beside the existing `changedPathsNow` implementation,
add — matching however that one maps `repo.state.workingTreeChanges`:

```ts
    stagedPathsNow: () =>
      repo.state.indexChanges.map((c: { uri: { fsPath: string } }) =>
        toRepoRelative(repo.rootUri.fsPath, c.uri.fsPath),
      ),
```

Use the file's own existing helper for the repo-relative conversion rather than
introducing a second one — read `changedPathsNow` directly above and mirror it
exactly, including its typing of the git extension's state.

- [ ] **Step 7: Union the two in the glue**

In `src/context/real-context-view.ts`, in `gitSummary` (`:71`):

```ts
      // Working tree UNION index. changedPathsNow is unstaged-only and, under
      // the default git.untrackedChanges: "mixed", includes untracked files;
      // stagedPathsNow is index-vs-HEAD. Either alone makes the count fall as
      // the user stages, which is the opposite of what "changed files" means.
      const changedPaths = [...new Set([...repo.changedPathsNow(), ...repo.stagedPathsNow()])];
      return { branch: repo.branch(), changedPaths };
```

- [ ] **Step 8: Give every fake repository the new verb**

Run: `bunx vitest run 2>&1 | grep -i "stagedPathsNow" | head`
Then add `stagedPathsNow: () => []` (or the case's own fixture) to every object
literal that implements `GitRepositoryLike` in `test/`. `bun run typecheck` is
the authority on whether any were missed.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `bun run test && bun run typecheck`
Expected: both pass.

- [ ] **Step 10: Commit**

```bash
git add src/scm/git-types.ts src/scm/real-git.ts src/context/real-context-view.ts \
  src/context/signals.ts test/unit
git commit -m "fix(context): count changed files as git status does, and drop the zero row"
```

---

### Task 3: `nimbus.context.enabled`

**Files:**
- Modify: `package.json` (`contributes.configuration`)
- Modify: `src/settings.ts` (reader)
- Modify: `src/context/real-context-view.ts` (gate collection, post `paused`)
- Modify: `src/context/webview/main.ts:70-74` (render the disabled notice)
- Modify: `src/context/webview/render.ts` (the notice's markup)
- Modify: `src/extension.ts` (pass the reader through)
- Modify: `docs/settings.md`
- Test: `test/unit/context-webview-listener.test.ts`, `test/unit/manifest-context.test.ts`

**Interfaces:**
- Consumes: `NimbusSettings` from `src/settings.ts`.
- Produces: `NimbusSettings.contextEnabled(): boolean` (default `true`), and
  `registerContextView` gains a `contextEnabled: () => boolean` dep.
- The protocol needs no change: `{ type: "paused"; reason: "hidden" | "disabled" }`
  already exists in `src/context/protocol.ts:18`.

**Why:** the spec assigns the setting to PR 3, the README already tells users it
is coming, and the panel talks to the Gateway on a debounce with no user action —
that must be switchable off without hiding the view.

**The decision this task takes:** default `true` (matching what 0.18.0 already
does and what the README says), and switching it off **keeps the view visible**
and renders a short notice. A `when`-clause that removed the view would make the
only way back the settings UI, and would leave the `paused`/`"disabled"` branch
already in `protocol.ts` as dead code.

- [ ] **Step 1: Write the failing tests**

In `test/unit/manifest-context.test.ts`:

```ts
type Config = { properties?: Record<string, { type?: string; default?: unknown }> };
const configManifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
) as { contributes?: { configuration?: Config | Config[] } };

test("contributes nimbus.context.enabled, defaulting to on", () => {
  const raw = configManifest.contributes?.configuration;
  const blocks = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const property = blocks
    .flatMap((b) => Object.entries(b.properties ?? {}))
    .find(([key]) => key === "nimbus.context.enabled")?.[1];
  expect(property?.type).toBe("boolean");
  expect(property?.default).toBe(true);
});
```

In `test/unit/context-webview-listener.test.ts`, add a case in the style of the
file's existing ones (it drives the webview bundle's `message` listener against a
stub `acquireVsCodeApi`):

```ts
test("a disabled pause explains itself rather than blanking the panel", () => {
  post({ type: "paused", reason: "disabled" });
  expect(signalsMount().innerHTML).toContain("Context panel is off");
  expect(offersMount().innerHTML).toBe("");
});

test("a hidden pause paints nothing — the user cannot see it anyway", () => {
  post({ type: "paused", reason: "hidden" });
  expect(signalsMount().innerHTML).toBe("");
});
```

Match the helper names already used in that file (`post`, and however it reaches
the two mounts) rather than introducing new ones.

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run test/unit/manifest-context.test.ts test/unit/context-webview-listener.test.ts`
Expected: FAIL — no such setting; `paused` paints `""` for both reasons.

- [ ] **Step 3: Contribute the setting**

In `package.json`, beside `nimbus.diagnostics.showCodeActions` (`:834`):

```json
        "nimbus.context.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Keep the Context view collecting. When off, the view stays in the sidebar but stops reading your editor and stops asking the Gateway for blame and related items."
        },
```

- [ ] **Step 4: Read it in settings.ts**

In `src/settings.ts`, add to the `NimbusSettings` interface and its
implementation, mirroring `showEgressStatusBarBadge` (`:38`):

```ts
  contextEnabled(): boolean;
```

```ts
    contextEnabled: () => cfg().get<boolean>("context.enabled", true),
```

- [ ] **Step 5: Render the notice**

In `src/context/webview/render.ts`, export the notice so the listener has one
source for it:

```ts
// Shown when nimbus.context.enabled is false. The view deliberately stays in
// the sidebar when the setting is off, so it has to say why it is empty —
// a blank panel reads as a broken one.
//
// `.empty` and nothing else: that class already exists in styles.css and is
// what every other empty state in this panel uses, so this inherits the panel's
// theming for free. No <code> element — styles.css has no rule for one, so it
// would render in a browser-default font matching nothing else here.
export const DISABLED_NOTICE =
  `<p class="empty">Context panel is off — turn on nimbus.context.enabled to use it.</p>`;
```

- [ ] **Step 6: Use it in the webview listener**

In `src/context/webview/main.ts`, replace the `paused` branch (`:70-74`):

```ts
  if (typed.type === "paused") {
    // "hidden" paints nothing because nobody is looking; "disabled" has to
    // explain itself, because the view is on screen and would otherwise read
    // as a surface that has silently broken.
    paint("signals", typed.reason === "disabled" ? DISABLED_NOTICE : "");
    paint("offers", "");
    return;
  }
```

Import `DISABLED_NOTICE` alongside the existing `renderOffers, renderSignals`.

- [ ] **Step 7: Gate collection in the glue**

In `src/context/real-context-view.ts`: add `contextEnabled: () => boolean` to the
`deps` parameter type, then guard `collect` (`:111`) and add a configuration
listener:

```ts
  const collect = async (): Promise<void> => {
    if (view === undefined || !view.visible) return;
    // The setting is read per collection, not captured: it can change under a
    // long-lived view, and the config listener below only exists to repaint
    // promptly, not to be the authority.
    if (!deps.contextEnabled()) {
      controller.invalidateAll();
      view.webview.postMessage({ type: "paused", reason: "disabled" }).then(undefined, () => {});
      return;
    }
```

and in the returned `Disposable.from(...)` list (`:255`):

```ts
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("nimbus.context.enabled")) return;
      // Turning it back on must not wait for the next cursor move, and turning
      // it off must clear what is on screen now.
      recollect();
    }),
```

- [ ] **Step 8: Wire it in extension.ts**

At the `registerContextView({...})` call site, add:

```ts
      contextEnabled: () => settings.contextEnabled(),
```

- [ ] **Step 9: Document it**

In `docs/settings.md`, in the same place the alphabetical/grouped order puts it
(read the file's existing ordering and follow it), in the prose style of
`nimbus.diagnostics.showCodeActions`:

```markdown
### `nimbus.context.enabled`

`boolean` (default `true`). Keeps the **Context** view collecting. The view
follows the active editor on a short debounce and, while it is expanded and the
Gateway is connected, asks that **local** Gateway two questions on its own — who
last touched the cursor line (`agents.whyPeek`) and what in the local index looks
related (`index.searchRanked`) — sending the repository-relative path, the cursor
line, and the selected text when there is one. Neither call reaches a model, so
neither raises a pre-flight preview; clicking one of the briefs it offers does,
exactly as everywhere else. Collapsing the view already stops collection
entirely; set this to `false` to stop it while the view is open. The view stays
in the sidebar and says it is off rather than rendering blank.
```

- [ ] **Step 10: Run the gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run check-settings-docs`
Expected: all pass, and `check-settings-docs` now reports 17 settings.

- [ ] **Step 11: Commit**

```bash
git add package.json src/settings.ts src/context src/extension.ts docs/settings.md test/unit
git commit -m "feat(context): add nimbus.context.enabled"
```

---

### Task 4: Make the panel's cadence observable

**Files:**
- Modify: `src/context/controller.ts` (`collect`, and the invalidation entry points)
- Test: `test/unit/context-controller.test.ts`

**Interfaces:**
- Consumes: `Logger` from `src/logging.ts` — already on `deps.log`, and it has a
  `debug(msg: string): void` level gated by `nimbus.logLevel`.
- Produces: no signature change.

**Why:** F5. Four checklist points across the two plans — PR1 #7 and #15, PR2 #2
and #13 — are phrased as "watch the output channel" for debounce cadence, git
churn, and silence while hidden. The panel logs **nothing** per collection, so
none of them can be answered. This task makes them answerable; Task 9 then
answers them.

`debug` and not `info`: this fires on every cursor rest, and the channel is a
user-facing surface.

- [ ] **Step 1: Write the failing test**

In `test/unit/context-controller.test.ts`, using the file's existing fake-log and
fake-clock helpers:

```ts
test("logs one debug line per collection, naming the signals it ran", async () => {
  const { controller, log } = makeController();
  await controller.collect(snapshotFor("src/a.ts", 3));
  const debugs = log.lines.filter((l) => l.startsWith("[debug]"));
  expect(debugs).toHaveLength(1);
  expect(debugs[0]).toContain("src/a.ts:3");
});

test("says which signals were served from cache on a repeat collection", async () => {
  const { controller, log } = makeController();
  await controller.collect(snapshotFor("src/a.ts", 3));
  log.lines.length = 0;
  await controller.collect(snapshotFor("src/a.ts", 3));
  expect(log.lines.join("\n")).toContain("cached");
});
```

Adapt `makeController`/`snapshotFor` to the file's actual helper names — it
already builds a controller over fakes for the debounce and fence cases.

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/unit/context-controller.test.ts`
Expected: FAIL — no debug lines are emitted.

- [ ] **Step 3: Implement**

In `src/context/controller.ts`, inside `collect`, after the generation is stamped
and the run set is known, emit one line naming the context and how each signal
was served:

```ts
    // One line per collection, at debug. The cadence of this surface — debounce
    // tiers, cache hits, git churn — is otherwise unobservable, which made four
    // points of the PR 1 and PR 2 checklists unanswerable in a real editor.
    // Debug and not info: this fires on every cursor rest.
    deps.log.debug(
      `context collect #${mine} ${snapshot.path ?? "(no file)"}:${snapshot.line ?? "-"} ` +
        `[${served.map((s) => `${s.id}=${s.how}`).join(" ")}]`,
    );
```

where `served` is built where each signal is dispatched, with `how` being
`"cached"`, `"local"`, `"fetch"` or `"skipped"` (skipped = Gateway-backed while
disconnected). Build it from the same branch that already decides those cases
rather than re-deriving them.

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run test/unit/context-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/controller.ts test/unit/context-controller.test.ts
git commit -m "feat(context): log one debug line per collection"
```

---

### Task 5: The pre-flight note stops claiming a redaction it did not perform

**Files:**
- Modify: `src/egress/preflight.ts:43,71-77`
- Test: `test/unit/egress-preflight.test.ts` (the existing preview tests)

**Interfaces:**
- Consumes: `EgressPayload.files: readonly { name: string; note?: string }[]`.
- Produces: `REDACTION_NOTE` stays exported (tests and other surfaces name it);
  a second constant `RELATIVE_PATH_NOTE` joins it.

**Why:** F4. The modal raised from a panel offer displayed
`src/logging.ts:11` and, directly beneath it, "Paths sent as file names only — no
directories, no repository path." `footerLines` appends that note whenever a
payload has any files, but the briefs put the repo-relative `ref` in as the file
name (`src/briefs/commands.ts:84`, `:93`). The claim is false on exactly the
surfaces the context panel makes easiest to reach.

The payload is not the thing to change: the Gateway needs the repo-relative path
to resolve the file. The note is.

- [ ] **Step 1: Write the failing tests**

```ts
test("claims file-name-only redaction only when every file name is a bare name", () => {
  const preview = renderPreview(payload({ files: [{ name: "logging.ts" }] }));
  expect(preview).toContain(REDACTION_NOTE);
});

test("tells the truth when a file name carries a directory", () => {
  const preview = renderPreview(payload({ files: [{ name: "src/logging.ts:11" }] }));
  expect(preview).not.toContain(REDACTION_NOTE);
  expect(preview).toContain(RELATIVE_PATH_NOTE);
});

test("a line:column suffix is still a bare file name", () => {
  // A colon is not a directory separator, so "logging.ts:11" carries no
  // directory and the stronger claim is true of it.
  const preview = renderPreview(payload({ files: [{ name: "logging.ts:11" }] }));
  expect(preview).toContain(REDACTION_NOTE);
});

test("claims nothing at all for an absolute path", () => {
  const preview = renderPreview(payload({ files: [{ name: "C:/Users/asaf/logging.ts" }] }));
  expect(preview).not.toContain(REDACTION_NOTE);
  expect(preview).not.toContain(RELATIVE_PATH_NOTE);
});
```

Use the file's own payload builder and preview entry point rather than the names
above if they differ.

- [ ] **Step 2: Run to verify they fail**

Run: `bunx vitest run test/unit/egress-preflight.test.ts`
Expected: FAIL on the second case — `REDACTION_NOTE` is emitted for both.

- [ ] **Step 3: Implement**

```ts
export const RELATIVE_PATH_NOTE =
  "Paths sent relative to the repository root — no absolute paths, no machine layout.";
```

```ts
function footerLines(p: EgressPayload): string[] {
  const lines: string[] = [];
  if (p.files.length > 0) {
    // Which claim is true depends on what the call site actually put in. Quick
    // Ask and the SCM trio redact to a basename; the briefs send the
    // repo-relative ref, because that is what the Gateway resolves against.
    // Asserting the stronger claim over the weaker payload is the one failure
    // this surface cannot afford.
    //
    // Three states, not two. An ABSOLUTE name is neither a bare file name nor
    // repository-relative, so it gets no reassurance at all rather than the
    // weaker of two false claims — LEAK_WARNING below is what should speak
    // then. No surface is supposed to produce one (Quick Ask and the SCM trio
    // redact to a basename, the briefs send the repo-relative ref), which is
    // exactly why the fallback must not quietly assert something nice about it.
    const absolute = (name: string): boolean =>
      name.startsWith("/") || name.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(name);
    const names = p.files.map((f) => f.name);
    const bare = names.every((n) => !n.includes("/") && !n.includes("\\"));
    if (bare) lines.push(`  ${REDACTION_NOTE}`);
    else if (!names.some(absolute)) lines.push(`  ${RELATIVE_PATH_NOTE}`);
  }
  if (leaked(p)) lines.push(`  ${LEAK_WARNING}`);
  for (const omission of p.omissions) lines.push(`  ${omission}`);
  return lines;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun run test`
Expected: PASS — including every other preview test, several of which assert on
the old note for basename payloads.

- [ ] **Step 5: Commit**

```bash
git add src/egress/preflight.ts test/unit/egress-preflight.test.ts
git commit -m "fix(egress): stop the preview claiming a redaction it did not perform"
```

---

### Task 6: Give the view enough height to be seen

**Files:**
- Modify: `package.json` (`contributes.views.nimbus`)
- Test: `test/unit/manifest-context.test.ts`

**Interfaces:** none — manifest only.

**Why:** F1. On a profile with all seven Nimbus views visible, the Context
webview resolves to roughly two sections tall with an internal scrollbar:
Problems and Git are visible, and **History, Related and every offer button sit
below the fold**. The existing manifest test asserts the view is *first*; being
first is not being usable.

`initialSize` is understood to be a proportional weight among a container's
views, applied only when a profile has no stored layout for them — so it cannot
move an existing user's layout, which VS Code persists per profile.

**Verify that property is real before building on it.** The F5 pass could not
confirm it: no built-in or installed extension on that machine uses it, and the
workbench bundles could not be searched reliably (the same search misses
`contextualTitle`, which certainly is a valid property). Step 3 therefore starts
by checking the manifest schema, and Step 5 is what actually decides — a
property VS Code ignores produces no warning and no effect, which is exactly how
a silent non-fix ships. The fallback, `"visibility": "collapsed"` on the six tree
views, is a documented property and needs the same manifest test if it is what
lands.

- [ ] **Step 1: Write the failing test**

```ts
test("weights the context view above the tree views it sits over", () => {
  const context = views.find((v) => v.id === "nimbus.contextView");
  expect(context?.initialSize).toBeGreaterThanOrEqual(3);
  for (const v of views.filter((x) => x.id !== "nimbus.contextView")) {
    expect(v.initialSize ?? 1).toBeLessThan(context?.initialSize ?? 0);
  }
});
```

Widen the file's `View` type to `{ id: string; name: string; type?: string; initialSize?: number }`.

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/unit/manifest-context.test.ts`
Expected: FAIL — `initialSize` is undefined on every view.

- [ ] **Step 3: Confirm the property exists, then implement**

Open `package.json` in VS Code and check that `initialSize` is offered by the
manifest schema inside a `contributes.views.nimbus[]` entry (IntelliSense on the
key; an unknown property is flagged by the JSON schema). If it is not offered,
skip to the fallback in Step 5 and adjust Step 1's test to match before writing
any manifest change.

If it is offered: in `package.json`, `contributes.views.nimbus`, give
`nimbus.contextView` `"initialSize": 3` and each of the six tree views
`"initialSize": 1`.

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run test/unit/manifest-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm it in a real editor**

Launch an Extension Development Host **with a fresh profile**, since an existing
one has a stored layout that wins:

```bash
code --extensionDevelopmentPath=. --profile nimbus-pr3-check .
```

Expected: the Context view opens tall enough to show Problems, Git, History and
Related without scrolling inside it.

**This step, not the unit test, is what decides the task.** A manifest property
VS Code does not understand is silently ignored — the unit test would still pass
while the panel stayed 140 px tall. If the view is unchanged, switch to the
fallback: `"visibility": "collapsed"` on the six tree views, so the container
opens with Context holding the space. Replace Step 1's assertion with one that
pins the collapsed views, and re-run this step. Record which of the two shipped
in the findings doc (Task 9 Step 5) — the next person needs to know which lever
actually moved this.

- [ ] **Step 6: Commit**

```bash
git add package.json test/unit/manifest-context.test.ts
git commit -m "fix(context): give the context view usable initial height"
```

---

### Task 7: A real-VS-Code spec for the panel

**Files:**
- Create: `test/ui/specs/context-panel.test.ts`
- Modify: `test/ui/fake-gateway.ts` (only if `search.ranked` needs a non-empty fixture)
- Reference: `test/ui/specs/briefs-gated.test.ts`, `test/ui/specs/workflows-view.test.ts`

**Interfaces:**
- Consumes: `fake()` from `test/ui/helpers/gateway.js`; the canned
  `agents.whyPeek` → `WHY_PEEK` and `search.ranked` → `[]` already in
  `test/ui/fake-gateway.ts:55-63`.
- Produces: nothing other tasks consume.

**Why:** the spec assigns an ExTester spec to PR 3, and F5 showed the panel's
failure modes are exactly the runtime-only kind unit tests cannot see. This suite
is **local-only** — it does not run in CI, for the upstream headless-Linux reason
documented in `docs/development.md` — so it is a local gate, not a CI one.

Note the two automation facts from the F5 pass, recorded in the findings doc:
`SendKeys` does not reach an Electron window, and sidebar view headers are drag
handles.

- [ ] **Step 1: Write the spec**

```ts
import { expect } from "chai";
import { ActivityBar, VSBrowser, WebView } from "vscode-extension-tester";

import { fake } from "../helpers/gateway.js";

const FIXTURE_FILE = "test/ui/fixture-workspace/src/session.ts";

// The panel is a WebviewView, so every assertion about its CONTENT has to be
// made from inside its frame. Everything about the gate modal is made from
// outside it — a modal is workbench chrome, not webview content.
async function openContextView(): Promise<WebView> {
  const control = await new ActivityBar().getViewControl("Nimbus");
  if (control === undefined) throw new Error("no Nimbus control in the activity bar");
  await control.openView();
  return new WebView();
}

async function textInPanel(view: WebView): Promise<string> {
  await view.switchToFrame();
  try {
    const root = await view.findWebElement({ css: "#root" } as never);
    return await root.getText();
  } finally {
    await view.switchBack();
  }
}

describe("ambient context panel", function () {
  this.timeout(120_000);

  it("renders its sections for the open file", async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
    const view = await openContextView();
    await VSBrowser.instance.driver.wait(
      async () => (await textInPanel(view)).includes("HISTORY"),
      20_000,
      "the context panel never rendered its History section",
    );
    const text = await textInPanel(view);
    expect(text).to.include("PROBLEMS");
    expect(text).to.include("HISTORY");
    expect(text).to.include("RELATED");
    expect(text).to.include("ASK ABOUT THIS");
  });

  it("shows the blame the Gateway returned for the cursor line", async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
    const view = await openContextView();
    await VSBrowser.instance.driver.wait(
      async () => (await textInPanel(view)).includes(fake().whyPeekAuthor()),
      20_000,
      "the panel never rendered the canned blame author",
    );
  });

  it("routes an offer through the pre-flight gate", async () => {
    await VSBrowser.instance.openResources(FIXTURE_FILE);
    const view = await openContextView();
    await view.switchToFrame();
    try {
      const button = await view.findWebElement({ css: "button.offer" } as never);
      await button.click();
    } finally {
      await view.switchBack();
    }
    // Reuse briefs-gated.test.ts's waitForModal rather than re-implementing the
    // poll: ModalDialog's getters do a single findElement with no built-in wait.
    const dialog = await waitForModal();
    expect(await dialog.getMessage()).to.include("Send this to the Nimbus agent?");
    await dialog.pushButton("Cancel");
  });
});
```

`waitForModal` currently lives inside `briefs-gated.test.ts`. Lift it into
`test/ui/helpers/` and import it from both specs rather than copying it — a
second copy is the thing that drifts.

`fake().whyPeekAuthor()` does not exist yet; either add that accessor to
`FakeGateway` next to `queueError`, or assert on the literal author string in
`WHY_PEEK` and add a comment naming `test/ui/fake-gateway.ts` as its source.

- [ ] **Step 2: Run the UI suite**

Run: `bun run test:ui`
Expected: the new spec passes alongside the existing five. If the frame switch
proves flaky, keep the modal case (which needs the frame only for the click) and
record what failed in the plan's Task 9 notes — do not delete a case silently.

- [ ] **Step 3: Commit**

```bash
git add test/ui
git commit -m "test(context): drive the context panel in a real VS Code"
```

---

### Task 8: Bring the docs level with what ships

**Files:**
- Modify: `docs/ROADMAP.md` (Phase 2 row → *Already shipped*)
- Modify: `README.md` (the "coming next" sentence in the Context panel bullet)
- Modify: `CLAUDE.md` (the "lands in PR 3" and "not yet been exercised in a real
  editor" clauses in the Surface-today paragraph)
- Modify: `docs/architecture.md` if the git seam's new verb belongs in its seam
  table — check before assuming

**Interfaces:** none.

- [ ] **Step 1: Move the ROADMAP row**

Cut the **Ambient context panel** row out of the Phase 2 table
(`docs/ROADMAP.md:192`) and add it to *Already shipped* with its enabling RPCs
(`agentsWhyPeek`, `searchRanked`), naming the four signals, the offers, the
toggle, and — honestly — that the count means "not yet committed" and the panel
has now had a real-editor pass.

- [ ] **Step 2: Correct the README**

In the Context panel bullet (`README.md:69`), replace "a `nimbus.context.enabled`
setting to switch it off while it's open is coming next" with what the setting
now does, and make sure the sentence about what is sent still matches the code
after Task 1.

- [ ] **Step 3: Correct CLAUDE.md**

In the Surface-today paragraph, replace "a `nimbus.context.enabled` toggle for
switching it off while it is open lands in PR 3" and "this panel has **not yet
been exercised in a real editor**" with the shipped state, and cite the findings
doc for what the pass covered and what it did not.

- [ ] **Step 4: Run the docs gate**

Run: `bun run check-settings-docs && bun run lint`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add docs README.md CLAUDE.md
git commit -m "docs: record the context panel as finished, toggle and all"
```

---

### Task 9: Verify — the gate, then the editor

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Run the full automated gate**

```bash
bun run test && bun run typecheck && bun run lint && bun run build \
  && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Expected: every command passes; `check-settings-docs` reports 17 settings.

- [ ] **Step 2: Run the local UI suite**

Run: `bun run test:ui`
Expected: all six specs pass. This suite does not run in CI, so a green run here
is the only evidence it gives.

- [ ] **Step 3: Re-run the F5 checks this PR claims to fix**

Launch an Extension Development Host on this repo with a **running, indexed**
Gateway (`nimbus start && nimbus init`), and confirm each of F1–F5 by eye:

1. The view opens tall enough to show Problems, Git, History and Related without
   scrolling inside it. **This one needs a fresh profile** —
   `code --extensionDevelopmentPath=. --profile nimbus-pr3-check .` — because VS
   Code persists a container's layout per profile, and a profile that has already
   run Nimbus will keep the layout it stored, whatever the manifest now says.
   Checking on your everyday profile proves nothing either way.
2. Related lists neighbours from OTHER files, with no duplicate rows, and says
   "Nothing else in the local index looks related." when there are none.
3. `git status` and the panel agree: create an untracked file (count rises),
   stage it (count **stays**), commit it (row disappears).
4. An offer's modal shows `src/<file>:<line>` above the relative-path note, not
   the file-names-only claim.
5. With `nimbus.logLevel` at debug, one line appears per collection; typing
   steadily produces one line per debounce tier, not one per keystroke.
6. Set `nimbus.context.enabled` to `false`: the view stays in the sidebar, says
   it is off in the panel's own empty-state styling, and logs no further collect
   lines. Set it back: the panel refills **without a cursor move, a file switch,
   or a window reload** — that is the whole point of the configuration listener,
   and a listener that fires but collects nothing looks identical to a working
   one until you check.

- [ ] **Step 4: Run the checks the first pass could not**

These are the "Not run" list in the findings doc. Each is a real gap, not a
formality:

1. A multi-root window with two repos on different branches — the panel must
   report the branch of the repo containing the file on screen.
2. A second repository opened mid-session, then a branch switch in it.
3. Tab onto an offer button, then move the cursor in the editor: focus survives.
4. Hide the Context view entirely, keep editing for a minute: no collect lines
   at all (Task 4 makes this observable for the first time).
5. A file outside every workspace root: History degrades to "No history for this
   line yet" rather than blaming a same-named file elsewhere.
6. Visit a line so blame appears, commit it, return: the new sha shows.
7. Ctrl+A on a large file does not stall the editor.
8. A repository that has NOT been indexed: History names `nimbus init`.

- [ ] **Step 5: Record the outcome**

Append a "PR 3 pass" section to
`docs/superpowers/plans/2026-08-17-context-panel-f5-findings.md` — what passed,
what failed, what is still unchecked. A finding that survives this PR belongs
there, named, not dropped.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-17-context-panel-f5-findings.md
git commit -m "docs: record the PR 3 verification pass"
```

---

## Self-Review

**Spec coverage.** PR 3's list in the design doc is: action wiring end to end
(already shipped in PR 1 — verified working in the F5 pass, point 7, so no task);
the degraded states (the spec's six all render — verified as points 6, 10 and 13,
and `blameSection:149` already carries the not-indexed case — so the only gap
was the *disabled* state, which is Task 3); `nimbus.context.enabled` (Task 3);
`docs/settings.md` (Task 3 Step 9); the ROADMAP move (Task 8); the CLAUDE.md
paragraph (Task 8); and the ExTester spec (Task 7). Tasks 1, 2, 4, 5 and 6 are
not in the spec's list — they come from the F5 pass, which is the point of having
run it before writing this.

**Placeholder scan.** No TBDs. Three steps deliberately defer to the file being
edited rather than quoting it: Task 2 Step 6 (mirror `changedPathsNow`'s own
mapping in `real-git.ts`), Task 4 Step 3 (`served` is built where the dispatch
branch already decides those cases), and Task 7 Step 1 (`waitForModal` is lifted
from `briefs-gated.test.ts`). Each names the exact file and symbol to read, which
is the alternative to guessing at code the plan cannot see.

**Corrections from the 2026-08-17 plan review, recorded so they are not undone.**
See [`2026-08-17-ambient-context-panel-pr3-review.md`](./2026-08-17-ambient-context-panel-pr3-review.md).

- **Path comparison (review 1A).** The review asked whether `rawMeta.file` and
  `snapshot.path` share a format. Probed against the live index: both are
  POSIX-style, so no slash rewriting is needed — but they are relative to
  **different roots**, and the same index holds
  `.claude/worktrees/…/src/context/controller.ts` beside
  `src/chat-participant/ops-commands.ts`. Task 1 therefore compares by whole-path
  suffix (`sameFile`), not `===`. An `===` test would have kept precisely the
  stale worktree rows this task exists to drop.
- **Dedup fallback (review 2A).** Correct, and the index proves it: five
  `github_actions` rows share a name and carry no file. The key falls back to the
  item's **service**, so those collapse while a Jira ticket and a Slack message
  sharing a title do not. The separator is written as the escape `\u0000`, never as a raw byte: the
  first draft of this plan contained a raw NUL byte, which made the file
  unsearchable by grep.
- **Absolute paths in the pre-flight note (extends review 2C).** The review
  confirmed `logging.ts:11` is correctly "bare" — a colon is not a separator, and
  Task 5 now tests that. It has a third state though: an absolute name is neither
  bare nor repository-relative, so Task 5 emits **no** reassurance for one rather
  than the weaker of two false claims.
- **Disabled-state styling (review 3.2).** `DISABLED_NOTICE` uses `.empty`, the
  class every other empty state in this panel uses, and drops the `<code>`
  element the first draft had — `styles.css` has no rule for one.
- **No change needed (review 2B).** `changedPaths` is read in exactly one place
  (`src/context/signals.ts:108`) and only for `.length`, so a deleted path is
  never operated on. The review reached the same conclusion.
- **Already covered (review 1B, 3.1).** The fresh-profile requirement and the
  no-cursor-move reactivity check were both in the plan; Task 9 Step 3 items 1
  and 6 now state them outright instead of by cross-reference.

**Type consistency.** `stagedPathsNow()` is the name in Task 2 Steps 5, 6, 7 and
8. `contextEnabled()` is the name in Task 3 Steps 4, 7 and 8. `DISABLED_NOTICE`
is exported in Step 5 and imported in Step 6. `RELATIVE_PATH_NOTE` is defined and
asserted in Task 5. `GitSummary.changedPaths` keeps its type
(`readonly string[] | undefined`) — Task 2 changes what fills it, not its shape.
