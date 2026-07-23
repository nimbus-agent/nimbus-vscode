import { describe, expect, test } from "vitest";

import { type SessionSummary, sessionToItem } from "../../src/sidebar/sessions.js";

describe("sessionToItem", () => {
  const summary: SessionSummary = {
    sessionId: "0123456789abcdef-session",
    lastWriteAt: 1000,
    chunkCount: 4,
  };

  test("renders a shortened label, relative time + count, and an open command", () => {
    const item = sessionToItem(summary, summary.lastWriteAt + 120_000);
    expect(item.label).toBe("Session 01234567");
    expect(item.description).toBe("2m ago · 4 msgs");
    expect(item.iconId).toBe("comment-discussion");
    expect(item.command?.command).toBe("nimbus.openSession");
    expect(item.command?.arguments?.[0]).toBe(summary.sessionId);
    expect(item.tooltip).toContain(summary.sessionId);
  });

  test("singularizes the message count and keeps short ids whole", () => {
    const item = sessionToItem({ sessionId: "short", lastWriteAt: 0, chunkCount: 1 }, 0);
    expect(item.label).toBe("Session short");
    expect(item.description).toBe("just now · 1 msg");
  });
});
