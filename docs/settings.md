# Settings

Every setting the extension contributes lives under the `nimbus.*` namespace and
is defined in [`package.json`](../package.json) (`contributes.configuration`).
Typed accessors are in [`src/settings.ts`](../src/settings.ts). Edit them via
**Settings → Extensions → Nimbus**, or directly in `settings.json`.

## Reference

### `nimbus.socketPath`

- **Type:** string · **Default:** `""` (auto-detect)
- Override the Gateway IPC socket path. Leave empty to auto-detect via
  `gateway.json` or the platform default. Set this only if you run the Gateway
  with a non-standard socket location.
- **Restricted Mode:** ignored at the workspace level in an untrusted workspace
  (`capabilities.untrustedWorkspaces.restrictedConfigurations` in
  `package.json`), so a workspace cannot redirect the IPC socket. Your user-level
  value still applies.

### `nimbus.autoStartGateway`

- **Type:** boolean · **Default:** `false`
- When `true`, the extension spawns `nimbus start` if the Gateway socket is
  unreachable. Leave `false` if you manage the Gateway lifecycle yourself (e.g. a
  service or a separate terminal); enable it for a one-step "just works" setup.
- **Restricted Mode:** ignored at the workspace level in an untrusted workspace,
  so opening an untrusted folder cannot spawn a process. Your user-level value
  still applies.

### `nimbus.statusBarPollMs`

- **Type:** number · **Default:** `30000` · **Minimum:** `5000`
- Polling interval, in milliseconds, for connector-health updates in the status
  bar. Lower it for snappier health feedback at the cost of more IPC chatter;
  raise it to reduce background polling.

### `nimbus.transcriptHistoryLimit`

- **Type:** number · **Default:** `50` · **Range:** `1`–`500`
- How many turns to rehydrate from `engine.getSessionTranscript` when the Webview
  reloads. Raise it to see more history after a panel reload; lower it if
  rehydration feels heavy on long sessions.

### `nimbus.search.limit`

- **Type:** number · **Default:** `50` · **Range:** `1`–`500`
- Maximum results requested from the local index per search (`searchRanked`).
  Raise it to see more matches at once; lower it for a tighter list. The Gateway
  clamps out-of-range values to 1–500, and the extension defensively clamps a
  hand-edited value too.

### `nimbus.askAgent`

- **Type:** string · **Default:** `""` (Gateway default)
- Optional default agent name passed to `askStream`. Blank uses the Gateway's
  default agent. Set it to pin Ask to a specific agent.

### `nimbus.agents`

- **Type:** array · **Default:** `[]`
- Agents listed in the **Agents** sidebar view. Each item is an object with a
  required `id` and optional `label`/`description`; clicking one opens a chat
  scoped to that agent. Leave empty to show no custom agents.

### `nimbus.quickAsk.presets`

- **Type:** array · **Default:** `[]`
- Preset actions offered in a picker before the **Quick Ask** input box. Each
  item is an object with a required `label` and `prompt` and an optional
  `description` (shown as picker detail). Picking one pre-fills the input box
  with its `prompt`, editable before you send; a **Custom question…** row keeps
  the free-form flow. Empty shows the built-in defaults (**Explain**, **Fix**,
  **Review**, **Docstring**, **Write tests**); a non-empty list **replaces** them.
- Separately, on an infrastructure file the extension prepends three **ops
  presets** — **Blast radius**, **Ownership**, **Recent changes** — regardless of
  this setting. They are not part of the replaceable list and cannot be
  configured away here.
- Replace semantics — to add one preset while keeping the defaults, start from
  this block:

  ```jsonc
  "nimbus.quickAsk.presets": [
    { "label": "Explain", "prompt": "Explain what this code does, step by step." },
    { "label": "Fix", "prompt": "Identify and fix any bugs or issues in this code. Show the corrected code and explain the changes." },
    { "label": "Review", "prompt": "Review this code for correctness, clarity, and potential improvements." },
    { "label": "Docstring", "prompt": "Write a docstring / doc comment for this code." },
    { "label": "Write tests", "prompt": "Write focused unit tests for this code, following the project's existing test framework and conventions." }
  ]
  ```

### `nimbus.scm.skipSecretFiles`

- **Type:** boolean · **Default:** `true`
- Exclude likely-secret files — `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`,
  `*.pfx` — from the diffs that **Generate Commit Message** and **Review
  Changes** send to the agent. Skipped files are reported, never dropped
  silently. Turn this off only if you genuinely need those files reviewed.

### `nimbus.scm.egressProofTrailer`

- **Type:** boolean · **Default:** `false`
- When on, **Generate Commit Message** appends a `Nimbus-Egress-Proof` trailer:
  the digest of the last-24h egress window plus an Ed25519 signature and public
  key from the gateway's signing keypair, so a reviewer can verify what left
  this machine while the change was authored. Best-effort by design — a missing
  signing key, an older gateway, or a prove failure skips the trailer (with a
  log line) rather than blocking the message.

### `nimbus.egress.showStatusBarBadge`

`boolean` (default `true`). Shows a second status-bar item while connected: the egress ledger row count plus a `$(check)` that means *the ledger head was read successfully* — not a cryptographic verification. Click it to open the Egress view; run **Verify Egress Ledger** for the offline chain check. Set to `false` to hide the badge. Poll cadence follows [`nimbus.statusBarPollMs`](#nimbusstatusbarpollms).

### `nimbus.briefs.showHoverBlame`

`boolean` (default `true`). Hovering a line shows who last changed it, when, the commit subject, and any linked PR or ticket — with a **Why? →** link that opens the full `Why is this here?` brief for that exact line. Backed by `agents.whyPeek`, which is a synchronous git-and-index lookup: it carries no model call, so it is not routed through the pre-flight egress gate. It does fire one IPC request per mouse-rest (after a 150 ms settle, one in flight per file); set to `false` to turn it off. Requires the repo root to be indexed — run `nimbus init` — or the hover finds nothing and stays hidden.

### `nimbus.briefs.defaultNamespace`

`string` (default `""`). Prefills the namespace prompt for **Safe to deploy?** (`agents.preflight`), which requires a namespace the extension has no way to derive. It is only a prefill: the prompt still appears and you still confirm it. Nimbus deliberately does not infer the namespace from the branch name or `package.json` — a wrong namespace does not error, it returns a confident `preflight` answer computed for something you never asked about. A namespace you have already typed in this workspace folder takes precedence over this setting.

### `nimbus.diagnostics.showCodeActions`

`boolean` (default `true`). Puts up to three Nimbus actions on the lightbulb for an error or a warning: **Explain this problem**, **Suggest a fix** (shown as a diff you apply yourself — Nimbus never edits your code), and **Find prior occurrences** (a search of the local index for the same error, which reaches no model — offered only when the message normalizes to enough of a query to be worth searching, so some diagnostics show two entries rather than three). `Information` and `Hint` diagnostics are never offered. Where a line carries several diagnostics, exactly one is chosen — highest severity first — so the lightbulb gains at most three entries, never three per diagnostic. The two model-bound actions route through the pre-flight egress gate; all three need a connected Gateway. Set to `false` to turn the lightbulb entries off.

### `nimbus.hitlAlwaysModal`

- **Type:** boolean · **Default:** `false`
- When `true`, out-of-chat human-in-the-loop (HITL) consent renders as a blocking
  **modal** instead of a non-modal toast. Enable it if you never want a consent
  prompt to be missed; leave it off for a less interruptive flow.

### `nimbus.logLevel`

- **Type:** `error` | `warn` | `info` | `debug` · **Default:** `info`
- Verbosity of the **Nimbus** output channel. Use `debug` when diagnosing
  connection or streaming issues. Stream errors always log at `error` regardless
  of this setting.

## Example `settings.json`

```jsonc
{
  // Let the extension start the Gateway for me, and pin a specific agent.
  "nimbus.autoStartGateway": true,
  "nimbus.askAgent": "research",
  // Verbose logging while I debug a connection problem.
  "nimbus.logLevel": "debug"
}
```
