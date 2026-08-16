import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDebouncer, DEBOUNCE_MS } from "../../src/context/debounce.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createDebouncer", () => {
  test("runs once for a burst of triggers", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    for (let i = 0; i < 20; i += 1) d.trigger();
    expect(calls).toBe(0);
    vi.advanceTimersByTime(300);
    expect(calls).toBe(1);
  });

  test("runs again for a later, separate burst", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    d.trigger();
    vi.advanceTimersByTime(300);
    d.trigger();
    vi.advanceTimersByTime(300);
    expect(calls).toBe(2);
  });

  test("each trigger restarts the wait — a fast typist never collects mid-burst", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    for (let i = 0; i < 10; i += 1) {
      d.trigger();
      vi.advanceTimersByTime(299);
    }
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
  });

  test("dispose cancels a pending run", () => {
    let calls = 0;
    const d = createDebouncer(300, () => {
      calls += 1;
    });
    d.trigger();
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(0);
  });

  test("carries the spec's three tiers", () => {
    expect(DEBOUNCE_MS).toEqual({ selection: 300, editor: 150, diagnostics: 500 });
  });
});
