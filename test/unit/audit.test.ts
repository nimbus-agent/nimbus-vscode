import { describe, expect, test } from "vitest";

import {
  type AuditEntry,
  auditEntryToItem,
  formatAuditDetail,
  formatRelativeTime,
  iconForStatus,
  parseAuditEntry,
} from "../../src/sidebar/audit.js";

const base: AuditEntry = {
  id: 7,
  actionType: "drive.file.read",
  hitlStatus: "approved",
  actionJson: '{"path":"/q.txt"}',
  timestamp: 1_000_000,
};

describe("parseAuditEntry", () => {
  test("parses a well-formed row", () => {
    expect(parseAuditEntry({ ...base })).toEqual(base);
  });

  test("defaults id/actionJson and coerces an unknown hitlStatus to not_required", () => {
    const e = parseAuditEntry({ actionType: "x", timestamp: 5, hitlStatus: "weird" });
    expect(e).toEqual({
      id: 0,
      actionType: "x",
      hitlStatus: "not_required",
      actionJson: "",
      timestamp: 5,
    });
  });

  test("rejects rows missing actionType or timestamp, and non-objects", () => {
    expect(parseAuditEntry({ timestamp: 1 })).toBeUndefined();
    expect(parseAuditEntry({ actionType: "x" })).toBeUndefined();
    expect(parseAuditEntry(null)).toBeUndefined();
    expect(parseAuditEntry("nope")).toBeUndefined();
  });
});

describe("iconForStatus", () => {
  test("maps each status to a codicon id", () => {
    expect(iconForStatus("approved")).toBe("pass");
    expect(iconForStatus("rejected")).toBe("error");
    expect(iconForStatus("not_required")).toBe("dash");
  });
});

describe("formatRelativeTime", () => {
  test("buckets deltas from just-now to days", () => {
    const now = 1_000_000_000;
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now, now - 30_000)).toBe("30s ago");
    expect(formatRelativeTime(now, now - 5 * 60_000)).toBe("5m ago");
    expect(formatRelativeTime(now, now - 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeTime(now, now - 2 * 86_400_000)).toBe("2d ago");
  });

  test("treats future timestamps as just now", () => {
    expect(formatRelativeTime(1000, 5000)).toBe("just now");
  });
});

describe("auditEntryToItem", () => {
  test("renders actionType + relative time + status icon + open command", () => {
    const item = auditEntryToItem(base, base.timestamp + 60_000);
    expect(item.label).toBe("drive.file.read");
    expect(item.description).toBe("1m ago");
    expect(item.iconId).toBe("pass");
    expect(item.command?.command).toBe("nimbus.openAuditEntry");
    expect(item.command?.arguments?.[0]).toBe(base);
  });
});

describe("formatAuditDetail", () => {
  test("pretty-prints the entry with actionJson expanded inline", () => {
    const detail = formatAuditDetail({ ...base });
    expect(detail?.title).toBe("audit-7.json");
    const parsed = JSON.parse(detail?.content ?? "{}");
    expect(parsed.action).toEqual({ path: "/q.txt" });
    expect(parsed.actionType).toBe("drive.file.read");
    expect(typeof parsed.timestampIso).toBe("string");
  });

  test("falls back to the raw string when actionJson is not valid JSON", () => {
    const detail = formatAuditDetail({ ...base, actionJson: "not json" });
    expect(JSON.parse(detail?.content ?? "{}").action).toBe("not json");
  });

  test("returns undefined for an unparseable row", () => {
    expect(formatAuditDetail({ nope: true })).toBeUndefined();
  });
});
