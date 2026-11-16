import type { HitlRequest } from "@nimbus-dev/client";
import { describe, expect, test, vi } from "vitest";
import {
  createHitlRouter,
  type HitlDecision,
  type HitlRouterDeps,
} from "../../src/hitl/hitl-router.js";

function makeDeps(opts: { chatVisibleAndFocused: boolean; alwaysModal?: boolean }): HitlRouterDeps {
  return {
    chatPanelVisibleAndFocused: () => opts.chatVisibleAndFocused,
    streamRegistered: (sid) => sid === "active-stream",
    showInline: vi.fn(async () => "approve" as const),
    showToast: vi.fn(async () => "approve" as const),
    showModal: vi.fn(async () => "approve" as const),
    askTyped: vi.fn(async () => undefined as string | undefined),
    sendResponse: vi.fn(async () => undefined),
    onCountChange: vi.fn(),
    alwaysModal: () => opts.alwaysModal ?? false,
  };
}

const REQ: HitlRequest = { requestId: "req-1", prompt: "Approve action?" };

describe("HitlRouter", () => {
  test("routes inline when stream-tagged AND chat is visible+focused", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: true });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ, streamId: "active-stream" });
    expect(deps.showInline).toHaveBeenCalled();
    expect(deps.showToast).not.toHaveBeenCalled();
    expect(deps.showModal).not.toHaveBeenCalled();
  });

  test("routes toast for background HITL by default", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ });
    expect(deps.showToast).toHaveBeenCalled();
    expect(deps.showModal).not.toHaveBeenCalled();
  });

  test("routes modal when nimbus.hitlAlwaysModal is true", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false, alwaysModal: true });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ });
    expect(deps.showModal).toHaveBeenCalled();
    expect(deps.showToast).not.toHaveBeenCalled();
  });

  test("dedupes duplicate requestIds", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false });
    const router = createHitlRouter(deps);
    await Promise.all([router.handle({ ...REQ }), router.handle({ ...REQ })]);
    expect(deps.showToast).toHaveBeenCalledTimes(1);
  });

  test("emits count changes (+1 on enqueue, -1 on response)", async () => {
    const deps = makeDeps({ chatVisibleAndFocused: false });
    const router = createHitlRouter(deps);
    await router.handle({ ...REQ });
    expect(deps.onCountChange).toHaveBeenCalled();
    const counts = (
      deps.onCountChange as unknown as { mock: { calls: [number][] } }
    ).mock.calls.map(([n]) => n);
    expect(counts).toEqual(expect.arrayContaining([1, 0]));
  });

  test("snapshot returns currently-pending requests", async () => {
    const deps: HitlRouterDeps = {
      ...makeDeps({ chatVisibleAndFocused: false }),
      showToast: vi.fn((): Promise<HitlDecision | undefined> => new Promise(() => undefined)),
    };
    const router = createHitlRouter(deps);
    void router.handle({ requestId: "r-pending", prompt: "p" });
    await new Promise((r) => setTimeout(r, 5));
    expect(router.snapshot().map((r) => r.requestId)).toContain("r-pending");
  });

  describe("type-to-confirm", () => {
    const CONFIRM: HitlRequest = { ...REQ, confirmText: "github/merge org/repo#7" };

    test("uses the input box only, whatever the surface preference, and never a button surface", async () => {
      for (const alwaysModal of [false, true]) {
        const deps = makeDeps({ chatVisibleAndFocused: true, alwaysModal });
        vi.mocked(deps.askTyped).mockResolvedValueOnce("github/merge org/repo#7");
        await createHitlRouter(deps).handle({ ...CONFIRM, streamId: "active-stream" });
        expect(deps.askTyped).toHaveBeenCalledTimes(1);
        expect(deps.showInline).not.toHaveBeenCalled();
        expect(deps.showToast).not.toHaveBeenCalled();
        expect(deps.showModal).not.toHaveBeenCalled();
      }
    });

    test("sends the typed text unchanged, even when it does not match", async () => {
      const deps = makeDeps({ chatVisibleAndFocused: false });
      vi.mocked(deps.askTyped).mockResolvedValueOnce(" Github/Merge ");
      await createHitlRouter(deps).handle(CONFIRM);
      expect(deps.sendResponse).toHaveBeenCalledWith("req-1", "approve", " Github/Merge ");
    });

    test("a dismissed box rejects", async () => {
      const deps = makeDeps({ chatVisibleAndFocused: false });
      await createHitlRouter(deps).handle(CONFIRM);
      expect(deps.sendResponse).toHaveBeenCalledWith("req-1", "reject");
    });

    test("two typed requests are asked one at a time, and the second does not reject the first", async () => {
      const deps = makeDeps({ chatVisibleAndFocused: false });
      const open: string[] = [];
      const answers = new Map<string, (typed: string | undefined) => void>();
      vi.mocked(deps.askTyped).mockImplementation(
        (req) =>
          new Promise<string | undefined>((resolve) => {
            open.push(req.requestId);
            answers.set(req.requestId, resolve);
          }),
      );
      const router = createHitlRouter(deps);
      const first = router.handle({ ...CONFIRM, requestId: "a" });
      const second = router.handle({ ...CONFIRM, requestId: "b" });
      await Promise.resolve();
      await Promise.resolve();
      // Only the first box is open: VS Code would have replaced it with the second.
      expect(open).toEqual(["a"]);
      expect(deps.sendResponse).not.toHaveBeenCalled();
      answers.get("a")?.("typed-a");
      await first;
      expect(open).toEqual(["a", "b"]);
      answers.get("b")?.(undefined);
      await second;
      expect(vi.mocked(deps.sendResponse).mock.calls).toEqual([
        ["a", "approve", "typed-a"],
        ["b", "reject"],
      ]);
    });

    test("a typed prompt that fails does not block the next one", async () => {
      const deps = makeDeps({ chatVisibleAndFocused: false });
      vi.mocked(deps.askTyped)
        .mockRejectedValueOnce(new Error("window closed"))
        .mockResolvedValueOnce("typed-b");
      const router = createHitlRouter(deps);
      await expect(router.handle({ ...CONFIRM, requestId: "a" })).rejects.toThrow("window closed");
      await router.handle({ ...CONFIRM, requestId: "b" });
      expect(deps.sendResponse).toHaveBeenCalledWith("b", "approve", "typed-b");
    });

    test("an ordinary request never opens the input box", async () => {
      const deps = makeDeps({ chatVisibleAndFocused: false });
      await createHitlRouter(deps).handle(REQ);
      expect(deps.askTyped).not.toHaveBeenCalled();
    });
  });
});
