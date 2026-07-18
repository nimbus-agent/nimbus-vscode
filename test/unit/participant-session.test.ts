import { describe, expect, test } from "vitest";
import {
  NIMBUS_SESSION_META_KEY,
  readPriorSessionId,
  toResultMetadata,
} from "../../src/chat-participant/session.js";

function responseTurn(sessionId?: string): unknown {
  return { result: { metadata: sessionId === undefined ? {} : { [NIMBUS_SESSION_META_KEY]: sessionId } } };
}

describe("readPriorSessionId", () => {
  test("returns undefined for empty history (new conversation)", () => {
    expect(readPriorSessionId([])).toBeUndefined();
  });

  test("returns the session id from the most recent response turn", () => {
    const history = [responseTurn("s1"), { prompt: "user turn, no result" }, responseTurn("s2")];
    expect(readPriorSessionId(history)).toBe("s2");
  });

  test("ignores turns without our metadata and falls back to an earlier one", () => {
    const history = [responseTurn("s1"), responseTurn(undefined)];
    expect(readPriorSessionId(history)).toBe("s1");
  });

  test("ignores non-string / empty metadata values", () => {
    const history = [{ result: { metadata: { [NIMBUS_SESSION_META_KEY]: "" } } }, { result: {} }];
    expect(readPriorSessionId(history)).toBeUndefined();
  });
});

describe("toResultMetadata", () => {
  test("wraps a real session id under the metadata key", () => {
    expect(toResultMetadata("s9")).toEqual({ [NIMBUS_SESSION_META_KEY]: "s9" });
  });

  test("returns an empty object for undefined or empty", () => {
    expect(toResultMetadata(undefined)).toEqual({});
    expect(toResultMetadata("")).toEqual({});
  });
});
