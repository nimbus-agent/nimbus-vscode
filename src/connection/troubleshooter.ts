import type { ConnectionState } from "./connection-manager.js";

export interface TroubleshootAction {
  label: string;
  command: string;
  args?: unknown[];
}

export interface TroubleshootReport {
  level: "info" | "warn" | "error";
  message: string;
  actions: TroubleshootAction[];
}

const OPEN_LOGS: TroubleshootAction = { label: "Open Logs", command: "nimbus.openLogs" };
const RECONNECT: TroubleshootAction = { label: "Reconnect Now", command: "nimbus.reconnect" };
const START_GATEWAY: TroubleshootAction = {
  label: "Start Gateway",
  command: "nimbus.startGateway",
};
const EDIT_SETTING: TroubleshootAction = {
  label: "Edit socketPath Setting",
  command: "workbench.action.openSettings",
  args: ["nimbus.socketPath"],
};

// Outcome of a live gateway.ping attempt, taken while the socket reports
// connected. Distinguishes "socket up, gateway responsive" from "socket up,
// gateway wedged" — a state the ConnectionState alone cannot see.
export type PingOutcome =
  | { ok: true; version: string; uptime: number }
  | { ok: false; error: string };

// Pure diagnosis: maps a ConnectionState to a user-facing report + fix actions.
// `platform` is injected so permission-denied guidance can differ (Unix socket
// modes vs Windows named-pipe access) without touching process in this module.
// `ping` is optional so non-connected states (and older callers) skip it.
export function buildTroubleshooter(
  state: ConnectionState,
  opts: { autoStartGateway: boolean; platform: NodeJS.Platform; ping?: PingOutcome },
): TroubleshootReport {
  switch (state.kind) {
    case "connected": {
      const ping = opts.ping;
      if (ping !== undefined && !ping.ok) {
        return {
          level: "warn",
          message: `Socket ${state.socketPath} is connected, but the Gateway is not responding to ping: ${ping.error}.`,
          actions: [RECONNECT, OPEN_LOGS],
        };
      }
      if (ping !== undefined) {
        const min = Math.round(ping.uptime / 60_000);
        return {
          level: "info",
          message: `Connected to the Gateway at ${state.socketPath} — v${ping.version}, up ${min} min.`,
          actions: [OPEN_LOGS],
        };
      }
      return {
        level: "info",
        message: `Connected to the Gateway at ${state.socketPath}.`,
        actions: [OPEN_LOGS],
      };
    }
    case "disconnected":
      if (opts.autoStartGateway) {
        return {
          level: "warn",
          message: `Waiting for the Gateway to start at ${state.socketPath}.`,
          actions: [RECONNECT, OPEN_LOGS],
        };
      }
      return {
        level: "error",
        message: `Nimbus can't reach the Gateway (not running) at ${state.socketPath}.`,
        actions: [START_GATEWAY, OPEN_LOGS],
      };
    case "permission-denied":
      return {
        level: "error",
        message:
          opts.platform === "win32"
            ? `Permission denied accessing ${state.socketPath} — check that the Gateway is running under your user account (named-pipe access), or adjust the socketPath setting.`
            : `Permission denied accessing the socket ${state.socketPath} — check the socket file's ownership/mode (chmod/chown) or the socketPath setting.`,
        actions: [EDIT_SETTING, OPEN_LOGS],
      };
    case "connecting":
    case "starting-gateway":
      return {
        level: "info",
        message: `Still connecting to ${state.socketPath}…`,
        actions: [RECONNECT, OPEN_LOGS],
      };
    case "idle":
      return {
        level: "warn",
        message: "Nimbus hasn't connected to the Gateway yet.",
        actions: [RECONNECT, OPEN_LOGS],
      };
  }
}
