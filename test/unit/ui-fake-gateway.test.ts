import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { createFakeGateway, type FakeGateway } from "../ui/fake-gateway.js";

let gw: FakeGateway | undefined;

afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

// Speaks the same NDJSON the real client speaks: one JSON object per line.
function call(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; notifications: unknown[] }> {
  return new Promise((resolve, reject) => {
    const notifications: unknown[] = [];
    let result: unknown;
    const sock = net.connect(socketPath, () => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; method?: string };
        if (msg.id === 1) result = msg.result;
        else notifications.push(msg);
      }
      // A brief is done when the response AND its notification have arrived.
      if (result !== undefined && notifications.length > 0) {
        sock.end();
        resolve({ result, notifications });
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("fake gateway did not answer")), 3000);
  });
}

describe("fake gateway", () => {
  test("a brief answers with a sessionId and then a briefReady notification", async () => {
    gw = createFakeGateway();
    await gw.start();
    const { result, notifications } = await call(gw.socketPath, "agents.janitor", {
      resourceRef: "svc/legacy",
    });
    expect(result).toEqual({ sessionId: expect.any(String) });
    const note = notifications[0] as { method: string; params: { findings: { kind: string } } };
    expect(note.method).toBe("janitor.briefReady");
    expect(note.params.findings.kind).toBe("janitor");
  });

  // The agent name, not the brief kind: agents.conflicts emits conflicts.briefReady
  // even though the brief's own `kind` is the singular "conflict".
  test("the notification is named for the agent, not the brief kind", async () => {
    gw = createFakeGateway();
    await gw.start();
    const { notifications } = await call(gw.socketPath, "agents.conflicts", { file: "a.ts" });
    expect((notifications[0] as { method: string }).method).toBe("conflicts.briefReady");
  });

  test("a queued error emits briefError instead", async () => {
    gw = createFakeGateway();
    await gw.start();
    gw.queueError("agents.preflight", "namespace not found");
    const { notifications } = await call(gw.socketPath, "agents.preflight", {
      ref: "r",
      namespace: "n",
    });
    const note = notifications[0] as { method: string; params: { error: string } };
    expect(note.method).toBe("preflight.briefError");
    expect(note.params.error).toBe("namespace not found");
  });

  test("every request is recorded with its params", async () => {
    gw = createFakeGateway();
    await gw.start();
    await call(gw.socketPath, "agents.why", { ref: "src/a.ts", line: 7 });
    expect(gw.requests()).toEqual([{ method: "agents.why", params: { ref: "src/a.ts", line: 7 } }]);
  });

  test("reset clears recorded requests and queued errors", async () => {
    gw = createFakeGateway();
    await gw.start();
    gw.queueError("agents.janitor", "boom");
    await call(gw.socketPath, "agents.why", { ref: "a.ts" });
    gw.reset();
    expect(gw.requests()).toEqual([]);
    const { notifications } = await call(gw.socketPath, "agents.janitor", { resourceRef: "x" });
    expect((notifications[0] as { method: string }).method).toBe("janitor.briefReady");
  });

  test("two gateways never collide on a socket path", () => {
    const a = createFakeGateway();
    const b = createFakeGateway();
    expect(a.socketPath).not.toBe(b.socketPath);
  });
});
