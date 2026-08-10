import type { Logger } from "../logging.js";
import type { MessageOptionsLike } from "../vscode-shim.js";
import {
  type EgressKind,
  type EgressMeta,
  type EgressPayload,
  egressTitle,
  renderFullEgress,
  summarizeEgress,
} from "./preflight.js";
import type { PreflightSkipStore, SkippableKind } from "./skip-store.js";

export type GateDecision = "send" | "cancel";

export const SKIP_LABEL: Record<SkippableKind, string> = {
  quickAsk: "Quick Ask",
  scm: "Source Control",
  brief: "Agent Briefs",
};

const SEND = "Send";
const SHOW_FULL = "Show full text";
const CANCEL = "Cancel";

// Only the surfaces where the EXTENSION decides what is sent prompt. Ask and
// the participant are text the user just typed; the LM tool is confirmed
// upstream by its own inline card. Briefs prompt because the extension derives
// their parameters from the editor, not from a user keystroke.
function skippableKind(kind: EgressKind): SkippableKind | undefined {
  if (kind === "quickAsk" || kind === "scm" || kind === "brief") return kind;
  return undefined;
}

export interface EgressGateDeps {
  window: {
    showWarningMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
  };
  openReadonly(title: string, content: string): Promise<void>;
  skips: PreflightSkipStore;
  /** False in Restricted Mode, where no skip is honoured. */
  isTrusted(): boolean;
  /** Leak-check needles: workspace folders, the home directory, the temp dir. */
  roots(): readonly string[];
  log: Logger;
}

export interface EgressGate {
  /** Prompting kinds. Awaited before anything is sent. */
  check(kind: EgressKind, prompt: string, meta: EgressMeta): Promise<GateDecision>;
  /** Pass-through kinds. Synchronous, because askStream returns its handle synchronously. */
  record(kind: EgressKind, prompt: string, meta: EgressMeta): void;
  lastPayload(): EgressPayload | undefined;
}

export function createEgressGate(deps: EgressGateDeps): EgressGate {
  // A single slot, replaced on every send — never a list. Bounded upstream by
  // the Quick Ask clamp and collectDiff's budget.
  let last: EgressPayload | undefined;

  const build = (kind: EgressKind, prompt: string, meta: EgressMeta): EgressPayload => ({
    kind,
    prompt,
    roots: deps.roots(),
    ...meta,
  });

  const remember = (payload: EgressPayload): EgressPayload => {
    last = payload;
    deps.log.debug(
      `egress: ${payload.kind} ${payload.prompt.length} chars, ${payload.files.length} file(s)`,
    );
    return payload;
  };

  // The second ask, after the full text has been opened. Deliberately NOT
  // modal: a VS Code modal blocks the whole workbench, so re-showing one over
  // the freshly opened tab would leave the user unable to scroll, search or
  // copy the very text they asked to see. The gate is the await, not the
  // dialog — nothing is sent until this resolves.
  const askAfterFullText = async (payload: EgressPayload): Promise<GateDecision> => {
    await deps.openReadonly(`Nimbus outbound — ${payload.action}.md`, renderFullEgress(payload));
    const answer = await deps.window.showWarningMessage(
      `Send ${payload.action} to the Nimbus agent? (${payload.prompt.length} characters)`,
      {},
      SEND,
      CANCEL,
    );
    return answer === SEND ? "send" : "cancel";
  };

  return {
    lastPayload: () => last,

    record: (kind, prompt, meta) => {
      remember(build(kind, prompt, meta));
    },

    check: async (kind, prompt, meta) => {
      const payload = remember(build(kind, prompt, meta));
      const skippable = skippableKind(kind);
      if (skippable === undefined) return "send";

      // Restricted Mode is exactly when the gate is wanted, so a stored skip is
      // ignored there — and the button that would set one is not offered.
      const trusted = deps.isTrusted();
      if (trusted && deps.skips.isSkipped(skippable)) return "send";

      const always = `Always send ${SKIP_LABEL[skippable]} here`;
      const items = trusted ? [SEND, SHOW_FULL, always] : [SEND, SHOW_FULL];
      // VS Code adds Cancel to a modal automatically, so it is not an item.
      const answer = await deps.window.showWarningMessage(
        egressTitle(payload),
        { modal: true, detail: summarizeEgress(payload) },
        ...items,
      );

      if (answer === SEND) return "send";
      if (answer === always) {
        await deps.skips.setSkipped(skippable);
        return "send";
      }
      if (answer === SHOW_FULL) return askAfterFullText(payload);
      // Cancel, Esc, or dismissed. The gate fails closed on every ambiguous
      // outcome.
      return "cancel";
    },
  };
}
