import { describe, expect, test } from "vitest";

import {
  type Attachment,
  buildAttachedContext,
  clampToLineBoundary,
  looksBinary,
  PER_ATTACHMENT_BUDGET,
  TOTAL_BUDGET,
} from "../../src/chat/attachments.js";

const file = (path: string): Attachment => ({ kind: "file", path });

const selection = (path: string, text: string): Attachment => ({
  kind: "selection",
  path,
  startLine: 12,
  endLine: 30,
  text,
});

const indexItem = (name: string, snippet: string): Attachment => ({
  kind: "index",
  itemId: "i1",
  name,
  service: "github",
  snippet,
});

/** A reader that serves canned contents and records what it was asked for. */
function reader(files: Record<string, string>) {
  const asked: string[] = [];
  const read = (path: string): string | undefined => {
    asked.push(path);
    return files[path];
  };
  return { read, asked };
}

describe("clampToLineBoundary", () => {
  test("keeps whole lines only", () => {
    const text = "aaa\nbbb\nccc\n";
    expect(clampToLineBoundary(text, 5)).toBe("aaa\n");
  });

  test("returns everything when it already fits", () => {
    expect(clampToLineBoundary("aaa\nbbb\n", 999)).toBe("aaa\nbbb\n");
  });

  test("a single line longer than the budget yields nothing rather than half a line", () => {
    expect(clampToLineBoundary("a-very-long-single-line", 5)).toBe("");
  });

  test("a budget landing exactly on the newline still excludes that line — it doesn't fit", () => {
    // "aaa\nbbb\n" has its first newline at index 3; keeping it costs 4 chars.
    expect(clampToLineBoundary("aaa\nbbb\n", 3)).toBe("");
  });

  test("one under that boundary also excludes the line", () => {
    expect(clampToLineBoundary("aaa\nbbb\n", 2)).toBe("");
  });

  test("one over that boundary is exactly where the line starts fitting", () => {
    expect(clampToLineBoundary("aaa\nbbb\n", 4)).toBe("aaa\n");
  });
});

describe("looksBinary", () => {
  test("a NUL byte marks it binary", () => {
    expect(looksBinary("abc\0def")).toBe(true);
  });

  test("ordinary source is not binary", () => {
    expect(looksBinary("export const x = 1;\n")).toBe(false);
  });
});

describe("buildAttachedContext", () => {
  test("a plain file contributes a labelled block and a sent chip", () => {
    const r = reader({ "src/a.ts": "export const a = 1;\n" });
    const built = buildAttachedContext([file("src/a.ts")], r.read);
    expect(built.chips).toHaveLength(1);
    expect(built.chips[0]?.outcome.state).toBe("sent");
    expect(built.chips[0]?.label).toBe("src/a.ts");
    expect(built.blocks).toContain("src/a.ts");
    expect(built.blocks).toContain("export const a = 1;");
    // `chars` counts the whole block, header included, because that is what
    // enters the payload. Asserted against the built blocks rather than a
    // hand-counted body length, so the two can never disagree.
    expect(built.chips[0]?.outcome).toEqual({ state: "sent", chars: built.blocks.length });
    expect(built.totalChars).toBe(built.blocks.length);
  });

  // An absolute path outside the workspace (or attached with none open)
  // passes through `toRepoRelative` unchanged. Every other outbound surface
  // in this extension redacts an unresolvable path to its basename first —
  // the chip label and the block header must too, or the OS username and
  // directory layout leak into a payload Ask sends with no modal preview.
  test("a file attachment outside the workspace shows and sends only its basename, not the full host path", () => {
    const r = reader({ "C:\\Users\\me\\notes\\todo.md": "buy milk\n" });
    const built = buildAttachedContext([file("C:\\Users\\me\\notes\\todo.md")], r.read);
    expect(built.chips[0]?.label).toBe("todo.md");
    expect(built.blocks).toContain("--- file: todo.md ---");
    expect(built.blocks).not.toContain("C:\\Users\\me");
    expect(built.blocks).not.toContain("me\\notes");
  });

  test("a selection attachment outside the workspace shows and sends only its basename", () => {
    const built = buildAttachedContext(
      [selection("/Users/me/notes/todo.md", "buy milk\n")],
      reader({}).read,
    );
    expect(built.chips[0]?.label).toBe("todo.md");
    expect(built.blocks).toContain("--- selection: todo.md (lines 12-30) ---");
    expect(built.blocks).not.toContain("/Users/me");
  });

  test("a repo-relative path is shown and sent unchanged", () => {
    const r = reader({ "src/a.ts": "x\n" });
    const built = buildAttachedContext([file("src/a.ts")], r.read);
    expect(built.chips[0]?.label).toBe("src/a.ts");
    expect(built.blocks).toContain("--- file: src/a.ts ---");
  });

  test("THE INVARIANT: every chip's character count equals its block body, exactly", () => {
    const r = reader({
      "src/a.ts": "aaa\n",
      "src/b.ts": "bbbb\nbbbb\n",
    });
    const built = buildAttachedContext(
      [file("src/a.ts"), file("src/b.ts"), selection("src/c.ts", "sel\n"), indexItem("n", "snip")],
      r.read,
    );
    for (const chip of built.chips) {
      if (chip.outcome.state === "refused") {
        expect(chip.block).toBeUndefined();
        continue;
      }
      expect(chip.block).toBeDefined();
      expect(chip.block?.length).toBe(chip.outcome.chars);
    }
    const summed = built.chips
      .filter((c) => c.outcome.state !== "refused")
      .reduce((n, c) => n + (c.block?.length ?? 0), 0);
    expect(summed).toBe(built.totalChars);

    // The above only pins internal self-consistency (chars is assigned FROM
    // block.length, so it cannot disagree with itself). What actually leaves
    // is `blocks`, built as a separate `bodies.join("")` — assert that IT
    // matches what the chips report, so reordering or changing that join
    // could not silently make the chips misreport the payload.
    expect(
      built.chips
        .filter((c) => c.outcome.state !== "refused")
        .map((c) => c.block)
        .join(""),
    ).toBe(built.blocks);
    expect(built.blocks.length).toBe(built.totalChars);
  });

  test("a secret path is refused outright and reads nothing", () => {
    const r = reader({ ".env": "TOKEN=abc\n" });
    const built = buildAttachedContext([file(".env")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
    expect(built.chips[0]?.block).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  test("a selection from a secret file is refused too — the rule is the path, not the kind", () => {
    const built = buildAttachedContext([selection(".env", "TOKEN=abc\n")], reader({}).read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
  });

  // A path outside the workspace root passes through `toRepoRelative`
  // unchanged — backslashes and all on Windows, or with no workspace open at
  // all. Regression coverage at the assembler level (not just isSecretPath
  // directly): all three must come back refused as "secret", never reach the
  // reader. Verified against the pre-fix `isSecretPath` (no separator
  // normalization, no basename check): the BACKSLASH case fails there — the
  // reader gets asked and the block would carry the key. The forward-slash
  // case already passed; it stays as the fence around the one that did not.
  test("a secret file behind a Windows backslash absolute path outside the workspace is refused", () => {
    const r = reader({ "C:\\Users\\me\\keys\\.env": "TOKEN=abc\n" });
    const built = buildAttachedContext([file("C:\\Users\\me\\keys\\.env")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
    expect(r.asked).toEqual([]);
  });

  test("a secret file behind a forward-slash absolute path outside the workspace is refused", () => {
    const r = reader({ "/Users/me/keys/.env": "TOKEN=abc\n" });
    const built = buildAttachedContext([file("/Users/me/keys/.env")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
    expect(r.asked).toEqual([]);
  });

  test("a secret file inside the workspace, repo-relative, is refused", () => {
    const r = reader({ "keys/.env": "TOKEN=abc\n" });
    const built = buildAttachedContext([file("keys/.env")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "secret" });
    expect(r.asked).toEqual([]);
  });

  test("binary content is refused, and secret beats binary", () => {
    const r = reader({ "a.bin": "x\0y", "secrets/id_rsa": "x\0y" });
    const built = buildAttachedContext([file("a.bin"), file("secrets/id_rsa")], r.read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "non-textual" });
    expect(built.chips[1]?.outcome).toEqual({ state: "refused", reason: "secret" });
  });

  test("an oversized file is clamped at a line boundary and says how much was cut", () => {
    const line = `${"x".repeat(99)}\n`;
    const big = line.repeat(1000); // 100_000 chars
    const r = reader({ "big.ts": big });
    const built = buildAttachedContext([file("big.ts")], r.read);
    const outcome = built.chips[0]?.outcome;
    expect(outcome?.state).toBe("clamped");
    if (outcome?.state !== "clamped") throw new Error("expected clamped");
    expect(outcome.ofChars).toBe(100_000);
    // The BODY respects the budget; `chars` counts the block, so it is larger
    // by exactly the header. Asserting `chars <= budget` would fail against a
    // correct implementation.
    const body = built.chips[0]?.block?.split("\n").slice(1).join("\n") ?? "";
    expect(body.length).toBeLessThanOrEqual(PER_ATTACHMENT_BUDGET);
    expect(outcome.chars).toBe(built.blocks.length);
    expect(built.chips[0]?.block?.endsWith("\n")).toBe(true);
  });

  test("the turn budget stops later attachments rather than truncating them silently", () => {
    const line = `${"y".repeat(99)}\n`;
    const files: Record<string, string> = {};
    const list: Attachment[] = [];
    for (let i = 0; i < 5; i += 1) {
      files[`f${i}.ts`] = line.repeat(640); // 64_000 each
      list.push(file(`f${i}.ts`));
    }
    const built = buildAttachedContext(list, reader(files).read);
    expect(built.totalChars).toBeLessThanOrEqual(TOTAL_BUDGET);
    const omitted = built.chips.filter(
      (c) => c.outcome.state === "refused" && c.outcome.reason === "budget",
    );
    expect(omitted.length).toBeGreaterThan(0);
  });

  test("the total budget is enforced on the BLOCK, header included, not just the body", () => {
    // 60 files of fine-grained (2-char) lines, well past TOTAL_BUDGET in raw
    // size: budgeting only the body lets the header of whichever attachment
    // lands near the boundary ride in for free, pushing the real accumulated
    // bytes past TOTAL_BUDGET even though every individual body respected its
    // slice of it.
    const files: Record<string, string> = {};
    const list: Attachment[] = [];
    const perFile = Math.ceil(TOTAL_BUDGET / 60) + 200;
    const bodyLine = "a\n".repeat(Math.ceil(perFile / 2));
    for (let i = 0; i < 60; i += 1) {
      files[`file-${i}.ts`] = bodyLine;
      list.push(file(`file-${i}.ts`));
    }
    const built = buildAttachedContext(list, reader(files).read);
    expect(built.totalChars).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  test("a missing file is refused as unreadable, and the turn survives", () => {
    const built = buildAttachedContext([file("gone.ts")], reader({}).read);
    expect(built.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
    expect(built.blocks).toBe("");
  });

  test("empty content is unreadable, not a budget refusal — the reason must be true", () => {
    const emptyFile = buildAttachedContext([file("empty.ts")], reader({ "empty.ts": "" }).read);
    expect(emptyFile.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
    // An index hit whose semanticSnippet was absent arrives here as "".
    const emptyItem = buildAttachedContext([indexItem("n", "")], reader({}).read);
    expect(emptyItem.chips[0]?.outcome).toEqual({ state: "refused", reason: "unreadable" });
  });

  test("a selection ignores later edits to its file — the snapshot is what is sent", () => {
    const r = reader({ "src/c.ts": "THE FILE CHANGED ENTIRELY\n" });
    const built = buildAttachedContext([selection("src/c.ts", "original selected text\n")], r.read);
    expect(built.blocks).toContain("original selected text");
    expect(built.blocks).not.toContain("THE FILE CHANGED ENTIRELY");
    expect(r.asked).toEqual([]);
  });

  test("a file attachment DOES reflect a later edit — the asymmetry is deliberate", () => {
    const r = reader({ "src/c.ts": "edited\n" });
    const built = buildAttachedContext([file("src/c.ts")], r.read);
    expect(built.blocks).toContain("edited");
    expect(r.asked).toEqual(["src/c.ts"]);
  });

  test("a selection block names its line range", () => {
    const built = buildAttachedContext([selection("src/c.ts", "sel\n")], reader({}).read);
    expect(built.blocks).toContain("src/c.ts");
    expect(built.blocks).toContain("lines 12-30");
    expect(built.chips[0]?.detail).toContain("captured at attach");
  });

  test("an index item contributes its snippet and touches no file", () => {
    const r = reader({});
    const built = buildAttachedContext([indexItem("deploy.yml", "steps: [...]")], r.read);
    expect(built.chips[0]?.detail).toContain("from index");
    expect(built.blocks).toContain("steps: [...]");
    expect(r.asked).toEqual([]);
  });

  test("an entirely refused set still yields an empty block string, never a throw", () => {
    const built = buildAttachedContext([file(".env"), file("gone.ts")], reader({}).read);
    expect(built.blocks).toBe("");
    expect(built.totalChars).toBe(0);
    expect(built.chips).toHaveLength(2);
  });

  test("no attachments yields nothing at all", () => {
    const built = buildAttachedContext([], reader({}).read);
    expect(built).toEqual({ blocks: "", chips: [], totalChars: 0 });
  });
});
