import type {
  ConnectorAddMcpResult,
  ConnectorAuthResult,
  ConnectorHealthHistoryEntry,
  ConnectorReindexResult,
  ConnectorRemoveResult,
  ConnectorSetConfigParams,
  ConnectorSetConfigResult,
  ConnectorStatusResult,
  ConnectorSyncStatus,
} from "@nimbus-dev/client";

import { formatInterval } from "./interval.js";
import { type ConnectorOutcome, fromGated, fromOk, fromThrown } from "./outcome.js";

/**
 * The Gateway capability this surface needs, as a structural seam. None of
 * these RPCs takes a prompt or returns a completion — they reach no model, so
 * this surface sits outside the pre-flight gate exactly as searchRanked does.
 */
export interface ConnectorClientLike {
  connectorListStatus(params?: { serviceId?: string }): Promise<ConnectorSyncStatus[]>;
  connectorStatus(params: {
    serviceId: string;
    includeStats?: boolean;
  }): Promise<ConnectorStatusResult>;
  connectorHealthHistory(params: {
    service: string;
    limit?: number;
  }): Promise<ConnectorHealthHistoryEntry[]>;
  connectorPause(params: { serviceId: string }): Promise<{ ok: boolean }>;
  connectorResume(params: { serviceId: string }): Promise<{ ok: boolean }>;
  connectorSetConfig(params: ConnectorSetConfigParams): Promise<ConnectorSetConfigResult>;
  connectorSync(params: { serviceId: string; full?: boolean }): Promise<{ ok: boolean }>;
  connectorReindex(params: {
    service: string;
    depth?: "metadata_only" | "summary" | "full";
  }): Promise<ConnectorReindexResult>;
  connectorAuth(
    params: { serviceId: string } & Record<string, unknown>,
  ): Promise<ConnectorAuthResult>;
  connectorAddMcp(params: {
    serviceId: string;
    commandLine: string;
  }): Promise<ConnectorAddMcpResult>;
  connectorRemove(params: { serviceId: string }): Promise<ConnectorRemoveResult>;
}

export type ReindexDepth = "metadata_only" | "summary" | "full";

export interface ConnectorOps {
  list(): Promise<ConnectorSyncStatus[]>;
  detail(serviceId: string): Promise<ConnectorStatusResult>;
  history(serviceId: string): Promise<ConnectorHealthHistoryEntry[]>;
  pause(serviceId: string): Promise<ConnectorOutcome>;
  resume(serviceId: string): Promise<ConnectorOutcome>;
  sync(serviceId: string): Promise<ConnectorOutcome>;
  fullSync(serviceId: string): Promise<ConnectorOutcome>;
  setConfig(params: ConnectorSetConfigParams): Promise<ConnectorOutcome>;
  reindex(serviceId: string, depth: ReindexDepth): Promise<ConnectorOutcome>;
  auth(serviceId: string, fields: Record<string, unknown>): Promise<ConnectorOutcome>;
  addMcp(serviceId: string, commandLine: string): Promise<ConnectorOutcome>;
  remove(serviceId: string): Promise<ConnectorOutcome>;
}

const NOT_CONNECTED = "Not connected to the Nimbus Gateway.";

/** One screenful of history; the Gateway clamps to 1..500. */
const HISTORY_LIMIT = 15;

// connectorHealthHistory takes built-in connector ids only — the client says so,
// and the Gateway rejects a user MCP id. Skipping beats surfacing an error the
// user cannot act on.
const MCP_ID = /^mcp_/;

export function createConnectorOps(getClient: () => ConnectorClientLike | undefined): ConnectorOps {
  // Resolved per call, never captured: a Gateway restart replaces the client,
  // and a captured one would be stranded (PR #103).
  const need = (): ConnectorClientLike => {
    const client = getClient();
    if (client === undefined) throw new Error(NOT_CONNECTED);
    return client;
  };

  const mutate = async (run: (c: ConnectorClientLike) => Promise<ConnectorOutcome>) => {
    try {
      return await run(need());
    } catch (e) {
      return fromThrown(e);
    }
  };

  const configDetail = (p: ConnectorSetConfigParams): string =>
    [
      p.intervalMs === undefined ? undefined : `interval ${formatInterval(p.intervalMs)}`,
      p.depth === undefined ? undefined : `depth ${p.depth}`,
      p.enabled === undefined ? undefined : p.enabled ? "enabled" : "disabled",
    ]
      .filter((s): s is string => s !== undefined)
      .join(", ");

  return {
    list: async () => await need().connectorListStatus(),
    detail: async (serviceId) => await need().connectorStatus({ serviceId, includeStats: true }),
    history: async (serviceId) =>
      MCP_ID.test(serviceId)
        ? []
        : await need().connectorHealthHistory({ service: serviceId, limit: HISTORY_LIMIT }),

    pause: (serviceId) => mutate(async (c) => fromOk(await c.connectorPause({ serviceId }))),
    resume: (serviceId) => mutate(async (c) => fromOk(await c.connectorResume({ serviceId }))),
    sync: (serviceId) =>
      mutate(async (c) => fromOk(await c.connectorSync({ serviceId }), "sync started")),
    fullSync: (serviceId) =>
      mutate(async (c) =>
        fromOk(await c.connectorSync({ serviceId, full: true }), "full re-sync started"),
      ),
    setConfig: (params) =>
      mutate(async (c) => {
        await c.connectorSetConfig(params);
        // The result reads null for anything not requested — that means "not
        // part of this call", NOT "cleared", so we report the request instead.
        return { kind: "applied", detail: configDetail(params) };
      }),
    reindex: (serviceId, depth) =>
      mutate(async (c) => {
        const r = await c.connectorReindex({ service: serviceId, depth });
        return { kind: "applied", detail: `${r.itemsAffected} items · ${r.mode}` };
      }),
    auth: (serviceId, fields) =>
      mutate(async (c) => {
        const r = await c.connectorAuth({ serviceId, ...fields });
        return { kind: "applied", detail: `scopes: ${r.scopesGranted.join(", ")}` };
      }),
    addMcp: (serviceId, commandLine) =>
      mutate(async (c) =>
        fromGated(
          await c.connectorAddMcp({ serviceId, commandLine }),
          (r) => `added ${r.serviceId}`,
        ),
      ),
    remove: (serviceId) =>
      mutate(async (c) =>
        fromGated(await c.connectorRemove({ serviceId }), (r) => `${r.itemsDeleted} items deleted`),
      ),
  };
}
