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
  **Review**, **Docstring**); a non-empty list **replaces** them.
- Replace semantics — to add one preset while keeping the defaults, start from
  this block:

  ```jsonc
  "nimbus.quickAsk.presets": [
    { "label": "Explain", "prompt": "Explain what this code does, step by step." },
    { "label": "Fix", "prompt": "Identify and fix any bugs or issues in this code. Show the corrected code and explain the changes." },
    { "label": "Review", "prompt": "Review this code for correctness, clarity, and potential improvements." },
    { "label": "Docstring", "prompt": "Write a docstring / doc comment for this code." }
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
