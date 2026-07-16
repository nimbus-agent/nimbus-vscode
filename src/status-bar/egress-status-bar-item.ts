import type { StatusBarItemHandle } from "../vscode-shim.js";

export interface EgressBadgeInputs {
  // Set on a fresh successful egressHead() read.
  head: { head: string; count: number } | undefined;
  // Last successful count, tracked by the controller across polls; drives the
  // stale render when a later poll errors.
  lastKnownCount: number | undefined;
  // Message from the last failed poll (undefined on success / first read).
  error: string | undefined;
  connected: boolean;
  showBadge: boolean;
}

export interface EgressBadgeRender {
  text: string;
  tooltip: string;
  command: string | undefined;
}

// Pure view-model for the egress badge. Returns undefined when the item should
// be hidden: badge disabled, not connected, or an error before any good read.
// The count is NEVER replaced by a literal word — always a number or nothing.
export function formatEgressBadge(inp: EgressBadgeInputs): EgressBadgeRender | undefined {
  if (!inp.showBadge || !inp.connected) return undefined;
  if (inp.head !== undefined) {
    const shortHead = inp.head.head.slice(0, 6);
    return {
      text: `$(shield) ${inp.head.count} $(check)`,
      tooltip: `Egress ledger: ${inp.head.count} rows · head ${shortHead}… · click to open · run "Verify ledger" for a cryptographic check`,
      command: "nimbus.egressView.focus",
    };
  }
  if (inp.lastKnownCount !== undefined) {
    const suffix = inp.error !== undefined ? ` (${inp.error})` : "";
    return {
      text: `$(shield) ${inp.lastKnownCount} $(warning)`,
      tooltip: `Egress ledger: couldn't refresh — showing last known ${inp.lastKnownCount} rows${suffix}`,
      command: "nimbus.egressView.focus",
    };
  }
  return undefined;
}

export interface EgressStatusBarController {
  update(inp: EgressBadgeInputs): void;
  dispose(): void;
}

export function createEgressStatusBarController(
  item: StatusBarItemHandle,
): EgressStatusBarController {
  return {
    update(inp): void {
      const r = formatEgressBadge(inp);
      if (r === undefined) {
        item.hide();
        return;
      }
      item.text = r.text;
      item.tooltip = r.tooltip;
      item.command = r.command;
      item.show();
    },
    dispose(): void {
      item.dispose();
    },
  };
}
