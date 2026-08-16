import { errMsg, type Logger } from "../logging.js";

export type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting"; socketPath: string }
  | { kind: "connected"; socketPath: string }
  | { kind: "disconnected"; socketPath: string; reason: string }
  | { kind: "permission-denied"; socketPath: string }
  | { kind: "starting-gateway"; socketPath: string };

export interface NimbusClientLike {
  close(): Promise<void>;
}

export interface ConnectionDeps {
  open(socketPath: string): Promise<NimbusClientLike>;
  discoverSocket(override?: string): Promise<{ socketPath: string; source: string }>;
  log: Logger;
  reconnectDelayMs?: number;
  socketPathOverride?: string;
}

export interface ConnectionManager {
  start(): Promise<void>;
  dispose(): Promise<void>;
  reconnectNow(): Promise<void>;
  /**
   * Report a failed RPC so a dead transport can be noticed. Only errors that
   * mean "the pipe is gone" tear the connection down; everything else is left
   * alone. Call it from any RPC catch block — it is cheap and idempotent.
   */
  noteTransportFailure(e: unknown): void;
  onState(listener: (s: ConnectionState) => void): { dispose(): void };
  current(): ConnectionState;
  client(): NimbusClientLike | undefined;
}

const DEFAULT_RECONNECT_MS = 3000;

// Transport-level failures: the socket is gone, so every subsequent call on
// this client fails no matter what it asks for.
//
// Deliberately a message test rather than a type test. An error that came back
// as JSON-RPC means the GATEWAY answered — the transport is fine and the call
// itself failed — and none of those messages look like these. Matching on type
// would mean importing the client's error classes into this module for no extra
// precision.
//
// Kept narrow on purpose: a false positive here tears down a healthy connection
// and reconnect-loops on every bad request, which is worse than the bug being
// fixed. See issue #82.
const TRANSPORT_DEAD = /\bnot connected\b|\bECONNRESET\b|\bEPIPE\b|socket (?:closed|hang ?up)/i;

export function isTransportDead(e: unknown): boolean {
  return TRANSPORT_DEAD.test(errMsg(e));
}

export function createConnectionManager(deps: ConnectionDeps): ConnectionManager {
  const listeners: Array<(s: ConnectionState) => void> = [];
  let state: ConnectionState = { kind: "idle" };
  let client: NimbusClientLike | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const setState = (s: ConnectionState): void => {
    state = s;
    for (const l of listeners) l(s);
  };

  // Drop the current client, best-effort. Closing a client whose socket is
  // already gone throws, and that must not stop the reconnect — so the failure
  // is swallowed rather than surfaced. Without this a reconnect would leak the
  // superseded client for the life of the window.
  const closeClient = async (): Promise<void> => {
    const stale = client;
    client = undefined;
    if (stale !== undefined) await stale.close().catch(() => undefined);
  };

  const tryConnect = async (): Promise<void> => {
    if (stopped) return;
    const disc = await deps.discoverSocket(deps.socketPathOverride);
    setState({ kind: "connecting", socketPath: disc.socketPath });
    try {
      const c = await deps.open(disc.socketPath);
      client = c;
      setState({ kind: "connected", socketPath: disc.socketPath });
      deps.log.info(`Connected to Gateway at ${disc.socketPath} (source=${disc.source})`);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "EACCES") {
        deps.log.error(`Permission denied accessing socket: ${disc.socketPath}`);
        setState({ kind: "permission-denied", socketPath: disc.socketPath });
        scheduleReconnect();
        return;
      }
      const msg = errMsg(e);
      deps.log.warn(`Connect failed (${errno ?? "unknown"}): ${msg}`);
      setState({ kind: "disconnected", socketPath: disc.socketPath, reason: msg });
      scheduleReconnect();
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void tryConnect();
    }, deps.reconnectDelayMs ?? DEFAULT_RECONNECT_MS);
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      await tryConnect();
    },
    async dispose(): Promise<void> {
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      await closeClient();
      listeners.length = 0;
    },
    // Unconditional. It used to early-return while `state.kind === "connected"`,
    // which made it a no-op in the one situation it exists for: a live client
    // whose pipe died still reports "connected", so the user's explicit
    // "Reconnect to Gateway" did nothing and only a window reload recovered.
    // An explicit request to reconnect is always honoured.
    async reconnectNow(): Promise<void> {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      await closeClient();
      await tryConnect();
    },

    noteTransportFailure(e: unknown): void {
      if (!isTransportDead(e)) return;
      // Only from a state that believes it is live: while disconnected a
      // reconnect is already scheduled, and re-entering would reset the backoff
      // on every failing poll.
      if (state.kind !== "connected") return;
      const msg = errMsg(e);
      deps.log.warn(`Gateway transport is gone (${msg}); reconnecting`);
      void closeClient();
      setState({ kind: "disconnected", socketPath: state.socketPath, reason: msg });
      scheduleReconnect();
    },
    onState(listener): { dispose(): void } {
      listeners.push(listener);
      listener(state);
      return {
        dispose: () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    },
    current: () => state,
    client: () => client,
  };
}
