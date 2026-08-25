import { isEgressCancelled } from "./egress/gated-client.js";
import { errMsg, type Logger } from "./logging.js";
import type { WindowApi } from "./vscode-shim.js";

/**
 * How a command handler reports a throw from its body.
 *
 * Two outcomes, and the split is the point: cancelling at the pre-flight preview
 * is a NORMAL outcome — the user said no, so stay silent, exactly as dismissing
 * a Quick Pick does — while anything else is both logged and surfaced, because a
 * command that quietly does nothing is indistinguishable from one still working.
 *
 * Shared by the SCM and diagnostics command families, which had a byte-identical
 * copy each. They wrap their handlers differently (one passes the code-action
 * argument through, the other takes none), but what a failure MEANS is the same
 * in both, and it should not be possible for one of them to start shouting about
 * a cancellation while the other stays quiet.
 */
export function reportCommandFailure(
  e: unknown,
  ctx: { internalName: string; humanName: string; window: WindowApi; log: Logger },
): void {
  if (isEgressCancelled(e)) {
    ctx.log.debug(`nimbus.${ctx.internalName} cancelled at the pre-flight preview`);
    return;
  }
  ctx.log.error(`nimbus.${ctx.internalName} failed: ${errMsg(e)}`);
  void ctx.window.showErrorMessage(`Nimbus ${ctx.humanName} failed: ${errMsg(e)}`);
}
