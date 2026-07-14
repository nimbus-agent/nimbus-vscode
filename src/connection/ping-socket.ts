import { connect as netConnect } from "node:net";

// Best-effort liveness probe for a Gateway IPC socket: resolves true if a
// connection opens within 500ms, false on error/timeout. This is node:net glue
// wired into the default AutoStarter (tests inject a fake AutoStarter), so it is
// excluded from coverage alongside vscode-shim.ts.
export async function pingSocket(socketPath: string): Promise<boolean> {
  if (socketPath.length === 0) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const sock = netConnect(socketPath);
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
    setTimeout(() => settle(false), 500);
  });
}
