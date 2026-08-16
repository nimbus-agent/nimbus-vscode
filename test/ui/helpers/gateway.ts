import type { FakeGateway } from "../fake-gateway.js";

export function fake(): FakeGateway {
  const gw = (globalThis as { __nimbusFakeGateway?: FakeGateway }).__nimbusFakeGateway;
  if (gw === undefined) throw new Error("fake gateway not started by the runner");
  return gw;
}
