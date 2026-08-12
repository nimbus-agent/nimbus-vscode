import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIEF_BY_AGENT, WHY_PEEK } from "./fixtures/briefs.js";

// A test-only Gateway. It speaks the real wire protocol and returns fixed
// shapes; it does not index, rank or reason. See the design doc for why a fake
// rather than a real Gateway, and for the limits of that choice.
//
// Protocol (verified against @nimbus-dev/client 0.15.1):
//   - NDJSON: one JSON-RPC 2.0 object per line.
//   - agents.<agent>  -> { sessionId }, then a <agent>.briefReady notification.
//   - agents.whyPeek  -> a direct result; it is NOT a brief and has no notification.

export interface RecordedRequest {
  method: string;
  params: unknown;
}

export interface FakeGateway {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  requests(): readonly RecordedRequest[];
  queueError(method: string, detail: string): void;
  reset(): void;
}

let counter = 0;

// The PID (plus a counter, so one process can run two) is the real defence
// against EADDRINUSE: a leftover socket from a crashed run can never collide
// with the next one. On win32 a named pipe is a kernel object and disappears
// with the process, so there is nothing to unlink there.
function newSocketPath(): string {
  counter += 1;
  const name = `nimbus-ui-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

const CANNED: Record<string, unknown> = {
  "agents.whyPeek": WHY_PEEK,
  searchRanked: [],
  "search.ranked": [],
  egressHead: { head: "0".repeat(64), count: 0 },
  "egress.head": { head: "0".repeat(64), count: 0 },
  queryItems: [],
};

export function createFakeGateway(): FakeGateway {
  const socketPath = newSocketPath();
  const recorded: RecordedRequest[] = [];
  const queuedErrors = new Map<string, string>();
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;

  const send = (sock: net.Socket, msg: unknown): void => {
    sock.write(`${JSON.stringify(msg)}\n`);
  };

  // `handle` runs inside the socket's "data" listener below. An exception
  // thrown from an EventEmitter listener is unhandled and kills the Node
  // process hosting ExTester and Mocha — the whole UI suite would abort with
  // a stack trace instead of a single spec failing. A malformed frame (bad
  // JSON, or a shape with no string `method`) must fail that one request, not
  // the runner.
  const handle = (sock: net.Socket, line: string): void => {
    let req: { id?: number | string; method?: string; params?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      send(sock, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const method = req.method;
    if (typeof method !== "string") {
      send(sock, {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32600, message: "no method" },
      });
      return;
    }
    recorded.push({ method, params: req.params ?? {} });

    if (method.startsWith("agents.") && method !== "agents.whyPeek") {
      const agent = method.slice("agents.".length);
      const sessionId = `s-${recorded.length}`;
      send(sock, { jsonrpc: "2.0", id: req.id, result: { sessionId } });
      const queued = queuedErrors.get(method);
      if (queued !== undefined) {
        queuedErrors.delete(method);
        send(sock, {
          jsonrpc: "2.0",
          method: `${agent}.briefError`,
          params: { sessionId, error: queued },
        });
        return;
      }
      send(sock, {
        jsonrpc: "2.0",
        method: `${agent}.briefReady`,
        params: { sessionId, brief: "fixture brief", findings: BRIEF_BY_AGENT[agent] ?? {} },
      });
      return;
    }

    send(sock, { jsonrpc: "2.0", id: req.id, result: CANNED[method] ?? {} });
  };

  return {
    socketPath,
    start: () =>
      new Promise((resolve, reject) => {
        // Unlink a leftover socket before listening. This is safe precisely
        // BECAUSE the path carries our PID: a live process cannot own a socket
        // named for this PID, so anything here is debris from a crashed run.
        // Without it, PID reuse on a long-lived machine surfaces as EADDRINUSE
        // — a failure with no relationship to the change under test.
        // Windows named pipes are kernel objects that vanish with the process,
        // so there is nothing to unlink there.
        if (process.platform !== "win32" && existsSync(socketPath)) {
          try {
            unlinkSync(socketPath);
          } catch {
            // Losing the race with another cleanup is fine; listen() will tell us.
          }
        }
        server = net.createServer((sock) => {
          sockets.add(sock);
          sock.on("close", () => sockets.delete(sock));
          let buf = "";
          sock.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) if (line.trim().length > 0) handle(sock, line);
          });
          // A client that drops mid-request must not take the server down.
          sock.on("error", () => sockets.delete(sock));
        });
        server.on("error", reject);
        server.listen(socketPath, () => resolve());
      }),

    stop: () =>
      new Promise((resolve) => {
        for (const sock of sockets) sock.destroy();
        sockets.clear();
        if (server === undefined) return resolve();
        server.close(() => resolve());
        server = undefined;
      }),

    requests: () => recorded,
    queueError: (method, detail) => queuedErrors.set(method, detail),
    reset: () => {
      recorded.length = 0;
      queuedErrors.clear();
    },
  };
}
