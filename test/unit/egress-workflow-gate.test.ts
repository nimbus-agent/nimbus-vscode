import { describe, expect, test } from "vitest";

import type { EgressGate, GateDecision } from "../../src/egress/gate.js";
import { SKIP_LABEL } from "../../src/egress/gate.js";
import { EgressCancelled, gateRawWorkflowRun } from "../../src/egress/gated-client.js";
import type { EgressMeta, EgressPayload } from "../../src/egress/preflight.js";

function fakeGate(decision: GateDecision): EgressGate & { recorded: EgressPayload[] } {
  const recorded: EgressPayload[] = [];
  const build = (kind: EgressPayload["kind"], prompt: string, meta: EgressMeta): EgressPayload => ({
    kind,
    prompt,
    roots: [],
    ...meta,
  });
  return {
    recorded,
    check: async (kind, prompt, meta) => {
      recorded.push(build(kind, prompt, meta));
      return decision;
    },
    record: (kind, prompt, meta) => {
      recorded.push(build(kind, prompt, meta));
    },
    lastPayload: () => recorded.at(-1),
  };
}

const META: EgressMeta = { action: "Run workflow nightly", files: [], omissions: [] };

type FakeHandle = { streamId: string };

function fakeClient(): {
  workflowRunStream: (p: { name: string }) => FakeHandle;
  calls: Array<{ name: string }>;
} {
  const calls: Array<{ name: string }> = [];
  return {
    calls,
    workflowRunStream: (p) => {
      calls.push(p);
      return { streamId: "sid" };
    },
  };
}

describe("gateRawWorkflowRun", () => {
  test("starts the run only after the gate says send", async () => {
    const client = fakeClient();
    const run = gateRawWorkflowRun(client, fakeGate("send"));
    const handle = await run({ name: "nightly" }, "manifest text", META);
    expect(handle.streamId).toBe("sid");
    expect(client.calls).toEqual([{ name: "nightly" }]);
  });

  test("never starts the run when the gate cancels", async () => {
    const client = fakeClient();
    const run = gateRawWorkflowRun(client, fakeGate("cancel"));
    await expect(run({ name: "nightly" }, "manifest", META)).rejects.toBeInstanceOf(
      EgressCancelled,
    );
    // The load-bearing assertion: a cancelled pre-flight must not have kicked
    // off a Gateway-side run that then needs cancelling.
    expect(client.calls).toEqual([]);
  });

  test("records under the workflow kind, with the manifest as the previewed text", async () => {
    const client = fakeClient();
    const gate = fakeGate("send");
    await gateRawWorkflowRun(client, gate)({ name: "nightly" }, "manifest text", META);
    expect(gate.recorded[0]?.kind).toBe("workflow");
    expect(gate.recorded[0]?.prompt).toBe("manifest text");
    expect(gate.recorded[0]?.action).toBe("Run workflow nightly");
  });

  test("a workflow run is a prompting surface, not a silent one", () => {
    // The extension picks what runs, so it must ask — same rule as the briefs.
    // If this label is missing the kind is not skippable, which means the gate
    // treats it as pass-through and never shows a modal.
    expect(SKIP_LABEL.workflow).toBeDefined();
  });
});
