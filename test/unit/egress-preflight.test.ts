import { describe, expect, test } from "vitest";

import {
  confirmationMessage,
  EGRESS_FILES_SHOWN,
  type EgressPayload,
  egressTitle,
  LEAK_WARNING,
  REDACTION_NOTE,
  RELATIVE_PATH_NOTE,
  renderFullEgress,
  summarizeEgress,
} from "../../src/egress/preflight.js";

function payload(over: Partial<EgressPayload> = {}): EgressPayload {
  return {
    kind: "scm",
    action: "Review Changes",
    prompt: "diff of a.ts",
    files: [{ name: "a.ts", note: "staged + unstaged" }],
    omissions: [],
    roots: [],
    ...over,
  };
}

describe("egressTitle", () => {
  test("names the action and asks", () => {
    expect(egressTitle(payload())).toBe("Send this to the Nimbus agent?");
  });
});

describe("summarizeEgress", () => {
  test("heads with the action, file count and grouped character count", () => {
    const s = summarizeEgress(payload({ prompt: "x".repeat(18412) }));
    expect(s.split("\n")[0]).toBe("Review Changes — 1 file, 18,412 characters");
  });
  test("omits the file count when nothing is attached", () => {
    const s = summarizeEgress(payload({ files: [], prompt: "hello" }));
    expect(s.split("\n")[0]).toBe("Review Changes — 5 characters");
  });
  test("lists each file with its note", () => {
    expect(summarizeEgress(payload())).toContain("  a.ts — staged + unstaged");
  });
  test(`shows at most ${EGRESS_FILES_SHOWN} files, then counts the rest`, () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.ts`, note: "staged" }));
    const s = summarizeEgress(payload({ files }));
    expect(s).toContain("  f0.ts — staged");
    expect(s).toContain("  f4.ts — staged");
    expect(s).not.toContain("f5.ts");
    expect(s).toContain("  … and 7 more");
  });
  test("states the redaction rule when files are attached", () => {
    expect(summarizeEgress(payload())).toContain(REDACTION_NOTE);
  });
  test("states no redaction rule when no files are attached", () => {
    expect(summarizeEgress(payload({ files: [] }))).not.toContain(REDACTION_NOTE);
  });
  test("lists omissions verbatim", () => {
    const s = summarizeEgress(payload({ omissions: ["2 files omitted (diff too large)."] }));
    expect(s).toContain("  2 files omitted (diff too large).");
  });
  test("warns when a root leaked into the prompt", () => {
    const s = summarizeEgress(
      payload({ prompt: "at C:\\gitrep\\nimbus\\a.ts", roots: ["C:\\gitrep\\nimbus"] }),
    );
    expect(s).toContain(LEAK_WARNING);
  });
  test("does not warn on a clean prompt", () => {
    expect(summarizeEgress(payload({ roots: ["C:\\gitrep\\nimbus"] }))).not.toContain(LEAK_WARNING);
  });
  test("claims file-name-only redaction only when every file name is a bare name", () => {
    const s = summarizeEgress(payload({ files: [{ name: "logging.ts", note: "whole file" }] }));
    expect(s).toContain(REDACTION_NOTE);
  });
  test("tells the truth when a file name carries a directory", () => {
    const s = summarizeEgress(payload({ files: [{ name: "src/logging.ts", note: "whole file" }] }));
    expect(s).not.toContain(REDACTION_NOTE);
    expect(s).toContain(RELATIVE_PATH_NOTE);
  });
  test("a line:column suffix is still a bare file name", () => {
    // A colon is not a directory separator, so "logging.ts:11" carries no
    // directory and the stronger claim is true of it.
    const s = summarizeEgress(payload({ files: [{ name: "logging.ts:11", note: "whole file" }] }));
    expect(s).toContain(REDACTION_NOTE);
  });
  test("claims nothing at all for an absolute path", () => {
    const s = summarizeEgress(
      payload({ files: [{ name: "C:/Users/asaf/logging.ts", note: "whole file" }] }),
    );
    expect(s).not.toContain(REDACTION_NOTE);
    expect(s).not.toContain(RELATIVE_PATH_NOTE);
  });
  test("claims nothing at all for a POSIX absolute path", () => {
    const s = summarizeEgress(
      payload({ files: [{ name: "/home/asaf/logging.ts", note: "whole file" }] }),
    );
    expect(s).not.toContain(REDACTION_NOTE);
    expect(s).not.toContain(RELATIVE_PATH_NOTE);
  });
  test("claims nothing at all for a backslash drive-letter path", () => {
    const s = summarizeEgress(
      payload({ files: [{ name: "C:\\Users\\asaf\\logging.ts", note: "whole file" }] }),
    );
    expect(s).not.toContain(REDACTION_NOTE);
    expect(s).not.toContain(RELATIVE_PATH_NOTE);
  });
  test("claims nothing at all for a UNC path", () => {
    const s = summarizeEgress(
      payload({ files: [{ name: "\\\\server\\share\\logging.ts", note: "whole file" }] }),
    );
    expect(s).not.toContain(REDACTION_NOTE);
    expect(s).not.toContain(RELATIVE_PATH_NOTE);
  });
});

describe("renderFullEgress", () => {
  test("lists every file, with no elision", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.ts`, note: "staged" }));
    const full = renderFullEgress(payload({ files }));
    expect(full).toContain("f11.ts");
    expect(full).not.toContain("… and");
  });
  test("ends with the verbatim prompt", () => {
    expect(renderFullEgress(payload({ prompt: "EXACT BYTES" }))).toContain("EXACT BYTES");
  });
  test("carries the relative-path note, not the redaction note, for a directory-carrying payload", () => {
    const full = renderFullEgress(
      payload({ files: [{ name: "src/logging.ts", note: "whole file" }] }),
    );
    expect(full).toContain(RELATIVE_PATH_NOTE);
    expect(full).not.toContain(REDACTION_NOTE);
  });
});

describe("confirmationMessage", () => {
  test("asks in the title and describes the payload in the message", () => {
    const c = confirmationMessage(payload({ kind: "lmTool", action: "Ask Nimbus", prompt: "hi" }));
    expect(c.title).toBe("Send this to the Nimbus agent?");
    expect(c.message).toContain("Ask Nimbus");
    expect(c.message).toContain("2 characters");
  });
  test("carries the leak warning into the card", () => {
    const c = confirmationMessage(
      payload({ kind: "lmTool", prompt: "at /home/asafg/x", roots: ["/home/asafg"] }),
    );
    expect(c.message).toContain(LEAK_WARNING);
  });
});
