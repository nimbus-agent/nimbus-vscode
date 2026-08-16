import { BRIEF_CATALOG } from "../briefs/catalog.js";
import type { Offer } from "./offers.js";
import type { SignalSection } from "./signals.js";

// The host↔webview contract, mirroring chat-protocol.ts — plus the validation
// that makes it safe. A webview is untrusted input: nothing it posts may reach
// executeCommand without passing both the id allowlist and an argument check.

export type ExtensionToContextView =
  | {
      type: "render";
      generation: number;
      sections: readonly SignalSection[];
      offers: readonly Offer[];
      isDirty: boolean;
    }
  | { type: "paused"; reason: "hidden" | "disabled" };

export type ContextViewToExtension =
  | { type: "ready" }
  | { type: "run"; command: string; args?: readonly unknown[] };

export type InboundResult =
  | { kind: "ready" }
  | { kind: "run"; command: string; args: readonly unknown[] }
  | { kind: "rejected"; reason: string };

export function allowedCommandIds(): ReadonlySet<string> {
  return new Set(BRIEF_CATALOG.map((spec) => spec.command));
}

// Briefs whose command signature accepts one optional EditorTarget. Every other
// allowlisted command takes none, so anything it is handed is refused.
const TAKES_EDITOR_TARGET = new Set([
  "nimbus.brief.why",
  "nimbus.brief.ghost",
  "nimbus.brief.conflicts",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEditorTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value["ref"] === "string" && typeof value["line"] === "number";
}

function validateArgs(command: string, args: readonly unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  if (!TAKES_EDITOR_TARGET.has(command)) return `${command} takes no arguments`;
  if (args.length > 1) return `${command} takes at most one argument`;
  if (!isEditorTarget(args[0])) return `${command} needs { ref: string, line: number }`;
  return undefined;
}

export function validateInbound(raw: unknown): InboundResult {
  if (!isRecord(raw)) return { kind: "rejected", reason: "message is not an object" };
  if (raw["type"] === "ready") return { kind: "ready" };
  if (raw["type"] !== "run") return { kind: "rejected", reason: "unknown message type" };

  const command = raw["command"];
  if (typeof command !== "string") return { kind: "rejected", reason: "command is not a string" };
  if (!allowedCommandIds().has(command)) {
    return { kind: "rejected", reason: `command not allowlisted: ${command}` };
  }

  const rawArgs = raw["args"];
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    return { kind: "rejected", reason: "args is not an array" };
  }
  const args: readonly unknown[] = rawArgs ?? [];
  const problem = validateArgs(command, args);
  if (problem !== undefined) return { kind: "rejected", reason: problem };
  return { kind: "run", command, args };
}
