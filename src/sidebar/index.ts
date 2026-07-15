import { asFiniteNumber, asNonEmptyString, asRecord } from "./parse-helpers.js";
import type { SidebarItem } from "./tree-view.js";

// The closed itemType enum mirrored from NimbusItem (we do not import the SDK).
export type IndexItemType = "file" | "folder" | "email" | "event" | "photo" | "task";

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

const ITEM_TYPES: ReadonlySet<string> = new Set<string>([
  "file",
  "folder",
  "email",
  "event",
  "photo",
  "task",
]);

const ITEM_TYPE_ICONS: Record<IndexItemType, string> = {
  file: "file",
  folder: "folder",
  email: "mail",
  event: "calendar",
  photo: "device-camera",
  task: "checklist",
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
  const id = asNonEmptyString(rec["id"]);
  if (id === undefined) return undefined;

  const item: IndexItem = {
    id,
    name: asNonEmptyString(rec["name"]) ?? id,
    service: asNonEmptyString(rec["service"]) ?? "",
  };
  const itemType = rec["itemType"];
  if (typeof itemType === "string" && ITEM_TYPES.has(itemType)) {
    item.itemType = itemType as IndexItemType;
  }
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

export function iconForItemType(itemType: IndexItem["itemType"]): string {
  return itemType === undefined ? "file" : ITEM_TYPE_ICONS[itemType];
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
