import { errMsg, type Logger } from "../logging.js";
import type { WindowApi } from "../vscode-shim.js";
import { PROGRESS_LOCATION_NOTIFICATION } from "../vscode-shim.js";
import { type AuthField, authFieldsFor } from "./catalog.js";
import type { ConnectorOps, ReindexDepth } from "./connector-client.js";
import { parseInterval } from "./interval.js";
import { type ConnectorOutcome, describeOutcome } from "./outcome.js";
import { connectorPayloadOf } from "./rows.js";

export interface ConnectorCommandDeps {
  window: WindowApi;
  ops: ConnectorOps;
  refresh: () => void;
  log: Logger;
}

type Target = { serviceId: string; itemCount: number };

export function createConnectorCommands(
  deps: ConnectorCommandDeps,
): Record<string, (node?: unknown) => Promise<void>> {
  // Guards a double-click, or a click on a menu built from a stale row. Keyed
  // per connector AND per command, so pausing one while another syncs is fine.
  const inFlight = new Set<string>();

  /**
   * The row VS Code passed, or — when there is none — a picker over the
   * registered connectors. These commands are palette-visible, so `node` is
   * undefined whenever one is run from the palette, a keybinding, or another
   * extension's executeCommand. Returning silently there would look broken;
   * this mirrors what the workflow commands already do with a missing target.
   */
  const resolveTarget = async (node?: unknown): Promise<Target | undefined> => {
    if (typeof node === "object" && node !== null) {
      const payload = connectorPayloadOf(node as { label: string; payload?: unknown });
      if (payload !== undefined) return payload;
    }
    let statuses: Awaited<ReturnType<ConnectorOps["list"]>>;
    try {
      statuses = await deps.ops.list();
    } catch (e) {
      void deps.window.showErrorMessage(`Nimbus: could not list connectors: ${errMsg(e)}`);
      return undefined;
    }
    if (statuses.length === 0) {
      // An empty picker looks broken; say what is actually true.
      void deps.window.showInformationMessage(
        "Nimbus: no connectors registered. Register one with the Nimbus CLI, or add an MCP connector.",
        {},
      );
      return undefined;
    }
    const chosen = await deps.window.showQuickPick(
      statuses.map((s) => ({
        label: s.serviceId,
        description: `${s.enabled ? s.status : "disabled"} · ${s.itemCount.toLocaleString("en-US")} items`,
        serviceId: s.serviceId,
        itemCount: s.itemCount,
      })),
      { placeHolder: "Pick a connector", matchOnDescription: true },
    );
    if (chosen === undefined) return undefined;
    return { serviceId: chosen.serviceId, itemCount: chosen.itemCount };
  };

  const report = (verb: string, serviceId: string, outcome: ConnectorOutcome): void => {
    const text = describeOutcome(verb, serviceId, outcome);
    // A denial is a decision, so it is information, not an error dialog.
    if (outcome.kind === "failed") void deps.window.showErrorMessage(text);
    else void deps.window.showInformationMessage(text, {});
    deps.refresh();
  };

  const run = async (
    key: string,
    verb: string,
    serviceId: string,
    op: () => Promise<ConnectorOutcome>,
  ): Promise<void> => {
    const guard = `${serviceId}:${key}`;
    if (inFlight.has(guard)) return;
    inFlight.add(guard);
    try {
      report(verb, serviceId, await op());
    } catch (e) {
      // ConnectorOps normalises its own failures, so this is unreachable in
      // production — but a command handler that can reject is worse than a
      // branch that never fires. Refresh here too: `report()` always does,
      // and leaving the view stale after a throw would be an asymmetry with
      // no justification.
      void deps.window.showErrorMessage(`${verb} ${serviceId} failed: ${errMsg(e)}`);
      deps.refresh();
    } finally {
      // Released on every path: a guard that leaked on failure would wedge the
      // command until the window reloaded.
      inFlight.delete(guard);
    }
  };

  // The two HITL-gated calls block until the owner answers. The Gateway bounds
  // that wait and reports an expiry through the same denial shape, so we add no
  // timer of our own — and offer no Cancel, because there is nothing to cancel.
  const awaitingConsent = async <T>(title: string, task: () => Promise<T>): Promise<T> =>
    await deps.window.withProgress(
      { location: PROGRESS_LOCATION_NOTIFICATION, title, cancellable: false },
      // Reporter FIRST — the argument order that broke every workflow run once.
      async (_progress, _token) => await task(),
    );

  const promptField = async (field: AuthField): Promise<string | undefined> =>
    await deps.window.showInputBox({
      prompt: field.label,
      password: field.secret,
      ignoreFocusOut: true,
      ...(field.placeholder === undefined ? {} : { placeHolder: field.placeholder }),
      validateInput: (value) =>
        field.required && value.trim() === "" ? "This field is required." : undefined,
    });

  return {
    "nimbus.syncConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      await run("sync", "Syncing", t.serviceId, () => deps.ops.sync(t.serviceId));
    },

    "nimbus.fullResyncConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const answer = await deps.window.showWarningMessage(
        `Full re-sync of ${t.serviceId}? This clears its sync cursor and re-reads everything from the source.`,
        { modal: true },
        "Full re-sync",
      );
      if (answer !== "Full re-sync") return;
      await run("full-resync", "Re-syncing", t.serviceId, () => deps.ops.fullSync(t.serviceId));
    },

    "nimbus.pauseConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      await run("pause", "Pausing", t.serviceId, () => deps.ops.pause(t.serviceId));
    },

    "nimbus.resumeConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      await run("resume", "Resuming", t.serviceId, () => deps.ops.resume(t.serviceId));
    },

    "nimbus.configureConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const choice = await deps.window.showQuickPick(
        [
          { label: "Sync interval" },
          { label: "Index depth" },
          { label: "Enable" },
          { label: "Disable" },
        ],
        { placeHolder: `Configure ${t.serviceId}` },
      );
      if (choice === undefined) return;
      if (choice.label === "Sync interval") {
        const raw = await deps.window.showInputBox({
          prompt: `Sync interval for ${t.serviceId}`,
          placeHolder: "15m",
          ignoreFocusOut: true,
          validateInput: (value) => {
            const parsed = parseInterval(value);
            return "error" in parsed ? parsed.error : undefined;
          },
        });
        if (raw === undefined) return;
        const parsed = parseInterval(raw);
        if ("error" in parsed) return;
        await run("config", "Configuring", t.serviceId, () =>
          deps.ops.setConfig({ serviceId: t.serviceId, intervalMs: parsed.ms }),
        );
        return;
      }
      if (choice.label === "Index depth") {
        const depth = await deps.window.showQuickPick(
          [{ label: "metadata_only" }, { label: "summary" }, { label: "full" }],
          { placeHolder: `Index depth for ${t.serviceId}` },
        );
        if (depth === undefined) return;
        await run("config", "Configuring", t.serviceId, () =>
          deps.ops.setConfig({ serviceId: t.serviceId, depth: depth.label as ReindexDepth }),
        );
        return;
      }
      const enabled = choice.label === "Enable";
      await run("config", "Configuring", t.serviceId, () =>
        deps.ops.setConfig({ serviceId: t.serviceId, enabled }),
      );
    },

    "nimbus.reindexConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const depth = await deps.window.showQuickPick(
        [{ label: "metadata_only" }, { label: "summary" }, { label: "full" }],
        { placeHolder: `Re-index ${t.serviceId} at which depth?` },
      );
      if (depth === undefined) return;
      const chosen = depth.label as ReindexDepth;
      if (chosen === "full") {
        const answer = await deps.window.showWarningMessage(
          `Re-index ${t.serviceId} at full depth? This needs your approval and can take a while.`,
          { modal: true },
          "Re-index",
        );
        if (answer !== "Re-index") return;
        await run("reindex", "Re-indexing", t.serviceId, () =>
          awaitingConsent(`Re-indexing ${t.serviceId} — waiting for your consent…`, () =>
            deps.ops.reindex(t.serviceId, chosen),
          ),
        );
        return;
      }
      await run("reindex", "Re-indexing", t.serviceId, () => deps.ops.reindex(t.serviceId, chosen));
    },

    "nimbus.authenticateConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const fields = authFieldsFor(t.serviceId);
      const collected: Record<string, unknown> = {};
      for (const field of fields) {
        const value = await promptField(field);
        // Cancelling any prompt abandons the flow: nothing partial is sent.
        if (value === undefined) return;
        collected[field.name] = value.trim();
      }
      if (fields.length === 0) {
        void deps.window.showInformationMessage(
          `${t.serviceId} authenticates in the browser — the Gateway will open it and listen locally.`,
          {},
        );
      }
      // Field VALUES never reach the log; the field names are safe to name.
      deps.log.info(
        `connector auth: ${t.serviceId} (${Object.keys(collected).join(", ") || "no fields"})`,
      );
      await run("auth", "Authenticating", t.serviceId, () => deps.ops.auth(t.serviceId, collected));
    },

    "nimbus.addMcpConnector": async () => {
      const serviceId = await deps.window.showInputBox({
        prompt: "Connector id",
        placeHolder: "mcp_acme",
        ignoreFocusOut: true,
        validateInput: (value) =>
          /^mcp_[a-z0-9_]{1,62}$/.test(value.trim())
            ? undefined
            : "Must look like mcp_name (lowercase letters, digits, underscores).",
      });
      if (serviceId === undefined) return;
      const commandLine = await deps.window.showInputBox({
        prompt: "Command line the Gateway will run",
        placeHolder: "npx -y @acme/mcp-server",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() === "" ? "This field is required." : undefined),
      });
      if (commandLine === undefined) return;
      const id = serviceId.trim();
      await run("add-mcp", "Adding", id, () =>
        awaitingConsent(`Adding ${id} — waiting for your consent…`, () =>
          deps.ops.addMcp(id, commandLine.trim()),
        ),
      );
    },

    "nimbus.removeConnector": async (node) => {
      const t = await resolveTarget(node);
      if (t === undefined) return;
      const count = t.itemCount.toLocaleString("en-US");
      const answer = await deps.window.showWarningMessage(
        `Remove ${t.serviceId}? This deletes its ${count} indexed items and clears its stored credentials.`,
        { modal: true },
        "Remove",
      );
      if (answer !== "Remove") return;
      await run("remove", "Removing", t.serviceId, () =>
        awaitingConsent(`Removing ${t.serviceId} — waiting for your consent…`, () =>
          deps.ops.remove(t.serviceId),
        ),
      );
    },
  };
}
