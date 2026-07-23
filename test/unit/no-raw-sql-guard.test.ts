import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Stage 1 exposed typed methods for what the extension used to reach via raw
// SQL. Guard the call shape (`querySql(`), not the bare identifier, so a
// leftover import alone cannot satisfy the test in reverse.
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("no raw-SQL client calls in src/", () => {
  test("querySql( appears nowhere in src/", () => {
    const offenders = listTsFiles(join(__dirname, "..", "..", "src")).filter((f) =>
      readFileSync(f, "utf8").includes("querySql("),
    );
    expect(offenders).toEqual([]);
  });
});
