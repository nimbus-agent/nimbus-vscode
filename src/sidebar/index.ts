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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
    label: group.service,
    description: `${group.items.length}`,
    iconId: "folder",
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
