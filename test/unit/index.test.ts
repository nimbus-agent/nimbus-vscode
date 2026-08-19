import { describe, expect, test } from "vitest";

import {
  buildAskPrompt,
  buildIndexMetadataBlock,
  groupByService,
  type IndexItem,
  iconForItemType,
  iconForService,
  indexToTree,
  labelForService,
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

  test("name falls back to id; an unknown itemType is preserved, not dropped", () => {
    const item = parseIndexRow({ id: "i2", itemType: "wormhole" });
    expect(item?.name).toBe("i2");
    // Was: expect(item?.itemType).toBeUndefined() — that assertion encoded the
    // bug. The vocabulary is open; dropping an unrecognised type is data loss.
    expect(item?.itemType).toBe("wormhole");
  });

  test("keeps an ops item type", () => {
    const item = parseIndexRow({
      id: "run-1",
      service: "github",
      itemType: "ci_run",
      name: "nightly build",
      modifiedAt: 1_700_000_000_000,
    });
    expect(item?.itemType).toBe("ci_run");
    expect(item?.updatedMs).toBe(1_700_000_000_000);
  });

  test("keeps an item type this extension build does not know", () => {
    const item = parseIndexRow({
      id: "x1",
      service: "x",
      itemType: "dora_metric",
      name: "n",
    });
    expect(item?.itemType).toBe("dora_metric");
  });

  test("prefers the composite indexPrimaryKey for identity when present", () => {
    const item = parseIndexRow({
      id: "run-1",
      indexPrimaryKey: "github:run-1",
      service: "github",
      itemType: "ci_run",
      name: "nightly build",
    });
    expect(item?.id).toBe("github:run-1");
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
  test("maps the emitted types and falls back without claiming a type", () => {
    expect(iconForItemType("email")).toBe("mail");
    expect(iconForItemType("event")).toBe("calendar");
    expect(iconForItemType("photo")).toBe("device-camera");
    expect(iconForItemType("folder")).toBe("folder");
    expect(iconForItemType("ci_run")).toBe("play-circle");
    expect(iconForItemType("pr")).toBe("git-pull-request");
  });

  test("falls back without claiming the item is a file", () => {
    expect(iconForItemType("ci_run")).toBe("play-circle");
    expect(iconForItemType("totally_new_type")).toBe("symbol-misc");
    expect(iconForItemType(undefined)).toBe("symbol-misc");
    // The fallback must never be a real item type's icon.
    expect(iconForItemType("totally_new_type")).not.toBe("file");
    expect(iconForItemType("totally_new_type")).not.toBe("folder");
  });
});

describe("labelForService / iconForService", () => {
  test("brand-cases known services with a matching codicon", () => {
    expect(labelForService("github")).toBe("GitHub");
    expect(iconForService("github")).toBe("github");
    expect(labelForService("local_files")).toBe("Local Workspace");
    expect(iconForService("slack")).toBe("comment-discussion");
  });

  test("prettifies unknown services and falls back to the folder icon", () => {
    expect(labelForService("custom_source")).toBe("Custom Source");
    expect(iconForService("custom_source")).toBe("folder");
  });

  test("passes the (unknown) sentinel through verbatim", () => {
    expect(labelForService("(unknown)")).toBe("(unknown)");
    expect(iconForService("(unknown)")).toBe("folder");
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
    expect(parent?.label).toBe("Slack");
    expect(parent?.iconId).toBe("comment-discussion");
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

describe("buildIndexMetadataBlock", () => {
  test("includes name/service/type and url when present, with no instruction", () => {
    const block = buildIndexMetadataBlock({
      id: "i",
      name: "Q3 Deck",
      service: "gdrive",
      itemType: "file",
      url: "https://x",
    });
    expect(block).toContain("Name: Q3 Deck");
    expect(block).toContain("Service: gdrive");
    expect(block).toContain("Type: file");
    expect(block).toContain("URL: https://x");
  });

  test("omits the URL line and shows unknown type/service when absent", () => {
    const block = buildIndexMetadataBlock({ id: "i", name: "x", service: "" });
    expect(block).not.toContain("URL:");
    expect(block).toContain("Type: unknown");
    expect(block).toContain("Service: unknown");
  });

  // The entire point of this helper versus buildAskPrompt: it carries no
  // instruction. It is prepended AHEAD of the user's own typed question by
  // the attachment assembler, and the spec requires the user's text to read
  // last, as the instruction — an imperative here would upstage it.
  test("carries no imperative — unlike buildAskPrompt, which is written to seed a fresh turn on its own", () => {
    const item: IndexItem = { id: "i", name: "Q3 Deck", service: "gdrive" };
    expect(buildIndexMetadataBlock(item)).not.toContain("Tell me about");
    expect(buildAskPrompt(item)).toContain("Tell me about this indexed item:");
  });
});
