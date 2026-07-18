type Thenable<T> = PromiseLike<T>;

export interface ReadyBuffer {
  /** Post a message to the webview, or queue it if the webview isn't ready. */
  post(msg: unknown): Thenable<boolean>;
  /** Feed every incoming webview->extension message so readiness can be detected. */
  observe(incoming: unknown): void;
}

function isReadyMessage(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "ready";
}

/**
 * Guards extension->webview posts against the first-message loss race.
 *
 * VS Code drops messages posted to a webview before its script has loaded and
 * registered a `message` listener; the webview announces readiness by posting
 * `{ type: "ready" }`. Until that arrives, posts are queued here and then
 * flushed in FIFO order — so the user's first Ask (which posts `userMessage`
 * the instant the panel is created) is never lost.
 */
export function createReadyBuffer(send: (msg: unknown) => Thenable<boolean>): ReadyBuffer {
  let ready = false;
  const queue: unknown[] = [];
  return {
    post(msg: unknown): Thenable<boolean> {
      if (ready) return send(msg);
      queue.push(msg);
      return Promise.resolve(true);
    },
    observe(incoming: unknown): void {
      if (ready || !isReadyMessage(incoming)) return;
      ready = true;
      const pending = queue.splice(0);
      for (const m of pending) void send(m);
    },
  };
}
