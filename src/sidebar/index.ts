import type { NimbusItem } from "@nimbus-dev/client";
import { asFiniteNumber, asNonEmptyString, asRecord } from "./parse-helpers.js";
import type { SidebarItem } from "./tree-view.js";

// Sourced from the SDK contract via the client — do NOT re-declare it here. A
// private mirror of this vocabulary is what made this view render no types for
// its entire life: the gateway emits dozens of itemTypes, the mirror listed six,
// and everything else was silently dropped.
export type IndexItemType = NimbusItem["itemType"];

// View-model projected from a NimbusItem row. Field names mirror NimbusItem so
// the defensive parse reads the real keys; we own this type.
export interface IndexItem {
  id: string;
  name: string;
  service: string;
  itemType?: IndexItemType;
  url?: string;
  updatedMs?: number;
}

export interface ServiceGroup {
  service: string;
  items: IndexItem[];
}

// Covers the types a live index actually contains plus the common ops types.
// Deliberately NOT all of the SDK's emitted types — unmapped types take the
// fallback in iconForItemType. Every id here is a real VS Code codicon
// (https://microsoft.github.io/vscode-codicons/dist/codicon.html).
const ITEM_TYPE_ICONS: Readonly<Record<string, string>> = {
  file: "file",
  folder: "folder",
  email: "mail",
  ci_run: "play-circle",
  pr: "git-pull-request",
  issue: "issues",
  web_clip: "link",
  deployment: "rocket",
  incident: "flame",
  message: "comment",
  page: "book",
  event: "calendar",
  photo: "device-camera",
};

// Brand-cased display names for known gateway service ids. Anything not listed
// is prettified (see prettifyService); the "(unknown)" sentinel from
// groupByService passes through unchanged.
const SERVICE_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  notion: "Notion",
  gdrive: "Google Drive",
  gmail: "Gmail",
  local_files: "Local Workspace",
};

// A sensible codicon per known service; unknown services fall back to "folder"
// (the generic collapsible-group look).
const SERVICE_ICONS: Record<string, string> = {
  github: "github",
  gitlab: "github",
  slack: "comment-discussion",
  notion: "notebook",
  gdrive: "cloud",
  gmail: "mail",
  local_files: "file-submodule",
};

// Coerce one queryItems row (or any unknown) into an IndexItem, or undefined
// when it lacks a usable id. Reads NimbusItem field names: name/service/
// itemType/url, plus updatedMs from modifiedAt ?? createdAt ?? updatedMs (the
// last lets a re-parsed command argument keep its sort key).
export function parseIndexRow(raw: unknown): IndexItem | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  // Prefer the gateway's composite key (`service:external_id`) when present, so
  // rows from different services cannot collide on a shared bare id.
  const id = asNonEmptyString(rec["indexPrimaryKey"]) ?? asNonEmptyString(rec["id"]);
  if (id === undefined) return undefined;

  const item: IndexItem = {
    id,
    name: asNonEmptyString(rec["name"]) ?? id,
    service: asNonEmptyString(rec["service"]) ?? "",
  };
  // The enum is open and the client has already validated the row, so accept
  // any non-empty string rather than gate on a private allow-list.
  const itemType = asNonEmptyString(rec["itemType"]);
  if (itemType !== undefined) item.itemType = itemType;
  const url = asNonEmptyString(rec["url"]);
  if (url !== undefined) item.url = url;
  const updatedMs =
    asFiniteNumber(rec["modifiedAt"]) ??
    asFiniteNumber(rec["createdAt"]) ??
    asFiniteNumber(rec["updatedMs"]);
  if (updatedMs !== undefined) item.updatedMs = updatedMs;
  return item;
}

// Group items by service. Services sorted alphabetically; items newest-first by
// updatedMs (Array.sort is stable, so equal/absent timestamps keep input order).
export function groupByService(items: IndexItem[]): ServiceGroup[] {
  const byService = new Map<string, IndexItem[]>();
  for (const item of items) {
    const key = item.service.length > 0 ? item.service : "(unknown)";
    const bucket = byService.get(key);
    if (bucket === undefined) byService.set(key, [item]);
    else bucket.push(item);
  }
  const groups: ServiceGroup[] = [];
  for (const [service, bucket] of byService) {
    const sorted = [...bucket].sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
    groups.push({ service, items: sorted });
  }
  groups.sort((a, b) => a.service.localeCompare(b.service));
  return groups;
}

/**
 * Icon for an item type, falling back for anything unmapped.
 *
 * The fallback is `symbol-misc` and must never be `file` or `folder` — those
 * are real item types, so reusing them would assert a type the row does not
 * have. The previous implementation returned "file" for an absent type, which
 * did exactly that. The `?? "symbol-misc"` is load-bearing: indexing a
 * `Record<string, string>` yields `string | undefined` under
 * noUncheckedIndexedAccess, unlike the old total `Record<IndexItemType, string>`.
 */
export function iconForItemType(itemType: string | undefined): string {
  return (itemType !== undefined ? ITEM_TYPE_ICONS[itemType] : undefined) ?? "symbol-misc";
}

// "local_files" -> "Local Files": the display fallback for services without an
// explicit brand label. charAt (not value[0]!) keeps us clear of the
// noNonNullAssertion lint rule.
function prettifyService(service: string): string {
  return service
    .split(/[_-]/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// User-facing service group label: brand-cased when known, prettified
// otherwise, with the "(unknown)" sentinel passed through verbatim.
export function labelForService(service: string): string {
  if (SERVICE_LABELS[service] !== undefined) return SERVICE_LABELS[service];
  return service === "(unknown)" ? service : prettifyService(service);
}

export function iconForService(service: string): string {
  return SERVICE_ICONS[service] ?? "folder";
}

function itemToRow(item: IndexItem): SidebarItem {
  return {
    label: item.name,
    iconId: iconForItemType(item.itemType),
    contextValue: "nimbusIndexItem",
    // Carried so the view/item/context "Ask" command (which receives this node,
    // not command.arguments) can recover the IndexItem.
    payload: item,
    ...(item.itemType !== undefined ? { description: item.itemType } : {}),
    ...(item.url !== undefined
      ? {
          tooltip: item.url,
          command: { command: "nimbus.openIndexItem", title: "Open", arguments: [item] },
        }
      : {}),
  };
}

// Two-level tree: a collapsible parent per service (label + item count), each
// carrying its item rows as `children`.
export function indexToTree(groups: ServiceGroup[]): SidebarItem[] {
  return groups.map((group) => ({
    label: labelForService(group.service),
    description: `${group.items.length}`,
    iconId: iconForService(group.service),
    children: group.items.map(itemToRow),
  }));
}

// A structured, copy-pasteable prompt seeded into the chat panel.
export function buildAskPrompt(item: IndexItem): string {
  const lines = [
    "Tell me about this indexed item:",
    `- Name: ${item.name}`,
    `- Service: ${item.service.length > 0 ? item.service : "unknown"}`,
    `- Type: ${item.itemType ?? "unknown"}`,
  ];
  if (item.url !== undefined) lines.push(`- URL: ${item.url}`);
  return lines.join("\n");
}

// A NEUTRAL metadata block for an index attachment that has no fetchable
// snippet — name, service, type, URL, and nothing else. Deliberately not
// `buildAskPrompt`: that one opens with an imperative ("Tell me about this
// indexed item:") written to seed a fresh chat turn on its own, and an
// attachment block is prepended AHEAD of whatever the user actually typed —
// the spec's whole point is that the user's own text reads last, as the
// instruction. No verb, no "Tell me" — just the facts the item carries.
export function buildIndexMetadataBlock(item: IndexItem): string {
  const lines = [
    `Name: ${item.name}`,
    `Service: ${item.service.length > 0 ? item.service : "unknown"}`,
    `Type: ${item.itemType ?? "unknown"}`,
  ];
  if (item.url !== undefined) lines.push(`URL: ${item.url}`);
  return lines.join("\n");
}
