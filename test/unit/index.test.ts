import { describe, expect, test } from "vitest";

import {
  buildAskPrompt,
  groupByService,
  iconForItemType,
  type IndexItem,
  indexToTree,
  parseIndexRow,
} from "../../src/sidebar/index.js";

describe("parseIndexRow", () => {
  test("reads NimbusItem fields and derives updatedMs from modifiedAt", () => {
    const item = parseIndexRow({
      id: "i1",
      name: "Report",
      service: "gdrive",
      itemType: "file",
      url: "https://x/y",
      createdAt: 100,
      modifiedAt: 200,
    });
    expect(item).toEqual({
      id: "i1",
      name: "Report",
      service: "gdrive",
      itemType: "file",
      url: "https://x/y",
      updatedMs: 200,
    });
  });

  test("falls back to createdAt when modifiedAt is absent", () => {
    expect(parseIndexRow({ id: "i", createdAt: 5 })?.updatedMs).toBe(5);
  });

  test("name falls back to id; unknown itemType is dropped", () => {
    const item = parseIndexRow({ id: "i2", itemType: "wormhole" });
    expect(item?.name).toBe("i2");
    expect(item?.itemType).toBeUndefined();
  });

  test("returns undefined without a usable id or for a non-object", () => {
    expect(parseIndexRow({ name: "no id" })).toBeUndefined();
    expect(parseIndexRow(null)).toBeUndefined();
    expect(parseIndexRow("nope")).toBeUndefined();
  });
});

describe("groupByService", () => {
  const items: IndexItem[] = [
    { id: "a", name: "A", service: "slack", updatedMs: 1 },
    { id: "b", name: "B", service: "gdrive", updatedMs: 3 },
    { id: "c", name: "C", service: "gdrive", updatedMs: 2 },
    { id: "d", name: "D", service: "" },
  ];

  test("groups by service, sorts groups alphabetically, items newest-first", () => {
    const groups = groupByService(items);
    expect(groups.map((g) => g.service)).toEqual(["(unknown)", "gdrive", "slack"]);
    const gdrive = groups.find((g) => g.service === "gdrive");
    expect(gdrive?.items.map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("empty input yields no groups", () => {
    expect(groupByService([])).toEqual([]);
  });
});

describe("iconForItemType", () => {
  test("maps each enum value and defaults to file", () => {
    expect(iconForItemType("email")).toBe("mail");
    expect(iconForItemType("event")).toBe("calendar");
    expect(iconForItemType("photo")).toBe("device-camera");
    expect(iconForItemType("task")).toBe("checklist");
    expect(iconForItemType("folder")).toBe("folder");
    expect(iconForItemType(undefined)).toBe("file");
  });
});

describe("indexToTree", () => {
  test("service rows are collapsible parents with counts; items carry open command only with a url", () => {
    const tree = indexToTree(
      groupByService([
        { id: "a", name: "Has URL", service: "slack", itemType: "email", url: "https://x" },
        { id: "b", name: "No URL", service: "slack" },
      ]),
    );
    expect(tree).toHaveLength(1);
    const parent = tree[0];
    expect(parent?.label).toBe("slack");
    expect(parent?.description).toBe("2");
    expect(parent?.children).toHaveLength(2);

    const withUrl = parent?.children?.find((c) => c.label === "Has URL");
    expect(withUrl?.contextValue).toBe("nimbusIndexItem");
    expect(withUrl?.description).toBe("email");
    expect(withUrl?.command?.command).toBe("nimbus.openIndexItem");
    expect(withUrl?.iconId).toBe("mail");
    expect(withUrl?.payload).toMatchObject({ id: "a", service: "slack", url: "https://x" });

    const noUrl = parent?.children?.find((c) => c.label === "No URL");
    expect(noUrl?.command).toBeUndefined();
    expect(noUrl?.contextValue).toBe("nimbusIndexItem");
  });
});

describe("buildAskPrompt", () => {
  test("includes name/service/type and url when present", () => {
    const prompt = buildAskPrompt({
      id: "i",
      name: "Q3 Deck",
      service: "gdrive",
      itemType: "file",
      url: "https://x",
    });
    expect(prompt).toContain("- Name: Q3 Deck");
    expect(prompt).toContain("- Service: gdrive");
    expect(prompt).toContain("- Type: file");
    expect(prompt).toContain("- URL: https://x");
  });

  test("omits the URL line and shows unknown type/service when absent", () => {
    const prompt = buildAskPrompt({ id: "i", name: "x", service: "" });
    expect(prompt).not.toContain("- URL:");
    expect(prompt).toContain("- Type: unknown");
    expect(prompt).toContain("- Service: unknown");
  });
});
