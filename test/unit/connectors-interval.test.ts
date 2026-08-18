import { describe, expect, test } from "vitest";

import { formatInterval, MIN_INTERVAL_MS, parseInterval } from "../../src/connectors/interval.js";

describe("parseInterval", () => {
  test("accepts minutes, hours and days", () => {
    expect(parseInterval("15m")).toEqual({ ms: 900_000 });
    expect(parseInterval("2h")).toEqual({ ms: 7_200_000 });
    expect(parseInterval("1d")).toEqual({ ms: 86_400_000 });
  });

  test("accepts seconds at or above the floor, and surrounding whitespace", () => {
    expect(parseInterval(" 90s ")).toEqual({ ms: 90_000 });
  });

  test("rejects anything under the Gateway's minimum before the round trip", () => {
    expect(parseInterval("30s")).toEqual({
      error: "The Gateway enforces a minimum of 60s.",
    });
  });

  test("rejects unparseable input", () => {
    expect(parseInterval("soon")).toEqual({ error: "Use a duration like 15m, 2h or 1d." });
    expect(parseInterval("")).toEqual({ error: "Use a duration like 15m, 2h or 1d." });
    expect(parseInterval("0m")).toEqual({ error: "The Gateway enforces a minimum of 60s." });
  });
});

describe("formatInterval", () => {
  test("round-trips the units it prints", () => {
    expect(formatInterval(900_000)).toBe("15m");
    expect(formatInterval(7_200_000)).toBe("2h");
    expect(formatInterval(86_400_000)).toBe("1d");
    expect(formatInterval(90_000)).toBe("90s");
  });
});

test("the floor matches what the client documents", () => {
  expect(MIN_INTERVAL_MS).toBe(60_000);
});
