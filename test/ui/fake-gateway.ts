import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIEF_BY_AGENT, WHY_PEEK } from "./fixtures/briefs.js";
import {
  CANCELLED_RUN_RESULT,
  NIGHTLY_STEP_LABELS,
  previewRunResult,
  RUNS_BY_WORKFLOW,
  WORKFLOWS,
} from "./fixtures/workflows.js";

// A test-only Gateway. It speaks the real wire protocol and returns fixed
// shapes; it does not index, rank or reason. See the design doc for why a fake
// rather than a real Gateway, and for the limits of that choice.
//
// Protocol (verified against @nimbus-dev/client 0.15.1):
//   - NDJSON: one JSON-RPC 2.0 object per line.
//   - agents.<agent>  -> { sessionId }, then a <agent>.briefReady notification.
//   - agents.whyPeek  -> a direct result; it is NOT a brief and has no notification.
//   - workflow.run    -> a REAL run holds its response open and streams
//                        `agent.chunk` notifications tagged with the client-
//                        minted `streamId`; it settles only when
//                        `workflow.cancel` arrives (or a watchdog fires). A DRY
//                        run answers immediately — it executes nothing.

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
  "workflow.list": { workflows: WORKFLOWS },
};

/**
 * How long a real run waits for a `workflow.cancel` before settling itself.
 *
 * A run the spec never cancels must not hang: the client's own per-request
 * timeout is 30s, and mocha's is 120s, so a run that outlived both would fail
 * as an opaque timeout rather than as the assertion that actually went wrong.
 * Well under both, so an uncancelled run settles as a plain completion and the
 * spec's own expectation is what reports the failure.
 */
const RUN_WATCHDOG_MS = 15_000;

/** The delay between a cancel being accepted and the run settling. */
const STEP_FINISH_MS = 150;

interface PendingRun {
  readonly sock: net.Socket;
  readonly id: number | string | null;
  readonly streamId: string;
  timer: ReturnType<typeof setTimeout>;
}

function str(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export function createFakeGateway(): FakeGateway {
  const socketPath = newSocketPath();
  const recorded: RecordedRequest[] = [];
  const queuedErrors = new Map<string, string>();
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;

  const pendingRuns = new Map<string, PendingRun>();

  const send = (sock: net.Socket, msg: unknown): void => {
    sock.write(`${JSON.stringify(msg)}\n`);
  };

  // A run's per-step output. Tagged with the client-minted streamId, which is
  // what the client filters on — an untagged chunk would still be accepted (it
  // reads as an older Gateway), so tagging is what makes this a faithful test
  // of the current protocol rather than of its compatibility path.
  const chunk = (run: PendingRun, text: string): void => {
    send(run.sock, {
      jsonrpc: "2.0",
      method: "agent.chunk",
      params: { streamId: run.streamId, text },
    });
  };

  const settleRun = (run: PendingRun, result: unknown): void => {
    if (!pendingRuns.has(run.streamId)) return;
    pendingRuns.delete(run.streamId);
    clearTimeout(run.timer);
    send(run.sock, { jsonrpc: "2.0", id: run.id, result });
  };

  // Answering every held run is what keeps a failing case from cascading: a run
  // left unanswered would sit until the client's own 30s timeout, and its error
  // notification would surface inside whichever case happened to be running by
  // then.
  const settleAllRuns = (): void => {
    for (const run of [...pendingRuns.values()]) settleRun(run, CANCELLED_RUN_RESULT);
  };

  const startRun = (sock: net.Socket, id: number | string | null, params: unknown): void => {
    const streamId = str(params, "streamId");
    const dryRun = (params as { dryRun?: unknown } | null)?.dryRun === true;
    const name = str(params, "name") ?? "";
    // A dry run executes nothing, so it answers in one round trip.
    if (dryRun || streamId === undefined) {
      send(sock, { jsonrpc: "2.0", id, result: previewRunResult(name) });
      return;
    }
    const run: PendingRun = {
      sock,
      id,
      streamId,
      timer: setTimeout(() => {
        settleRun(run, { runId: "run-watchdog", dryRun: false, status: "done", stepResults: [] });
      }, RUN_WATCHDOG_MS),
    };
    pendingRuns.set(streamId, run);
    chunk(run, `step 1/${NIGHTLY_STEP_LABELS.length}: ${NIGHTLY_STEP_LABELS[0]} — running`);
  };

  // Cancellation lands at the NEXT step boundary: the fake accepts the cancel
  // at once, lets the in-flight step emit its finishing chunk, and only then
  // settles the run as "cancelled". A fake that settled instantly would let a
  // surface claiming an instant stop pass.
  const cancelRun = (sock: net.Socket, id: number | string | null, params: unknown): void => {
    const streamId = str(params, "streamId");
    const run = streamId === undefined ? undefined : pendingRuns.get(streamId);
    if (run === undefined) {
      send(sock, { jsonrpc: "2.0", id, result: { cancelled: false } });
      return;
    }
    send(sock, { jsonrpc: "2.0", id, result: { cancelled: true } });
    setTimeout(() => {
      chunk(run, `step 1/${NIGHTLY_STEP_LABELS.length}: ${NIGHTLY_STEP_LABELS[0]} — finished`);
      settleRun(run, CANCELLED_RUN_RESULT);
    }, STEP_FINISH_MS);
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

    const id = req.id ?? null;

    // Keyed by the requested workflow, not by method: a workflow with no
    // history must render "Never run" rather than inherit another one's runs.
    if (method === "workflow.listRuns") {
      const name = str(req.params, "workflowName") ?? "";
      send(sock, { jsonrpc: "2.0", id, result: { runs: RUNS_BY_WORKFLOW[name] ?? [] } });
      return;
    }
    if (method === "workflow.run") {
      startRun(sock, id, req.params);
      return;
    }
    if (method === "workflow.cancel") {
      cancelRun(sock, id, req.params);
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
        // Before the sockets go: an outstanding run's watchdog timer would
        // otherwise hold the runner's event loop open past process exit.
        settleAllRuns();
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
      // A case that failed mid-run leaves a held request behind; answering it
      // here keeps its error out of the NEXT case.
      settleAllRuns();
    },
  };
}
