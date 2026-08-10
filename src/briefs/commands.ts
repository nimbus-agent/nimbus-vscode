import { type GatedBriefs, isEgressCancelled } from "../egress/gated-client.js";
import type { EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import type { MessageOptionsLike, TextEditorLike } from "../vscode-shim.js";
import { type BriefId, briefSpec } from "./catalog.js";
import { type EditorTarget, fileParams, toOneBased, toRelativeRef, whyParams } from "./params.js";
import { renderConflicts, renderGhost, renderHuddle, renderWhy } from "./render.js";

// What the manifest says about a brief's file. The extension sends a path; what
// the Gateway does after is the egress ledger's business, not a claim this
// surface is entitled to make. See the design doc's "Egress" section.
export const BRIEF_FILE_NOTE = "the extension sends this path, not the file's contents";

const RETRY = "Retry";

export interface BriefCommandDeps {
  /** undefined = disconnected. */
  briefs(): GatedBriefs | undefined;
  activeEditor(): TextEditorLike | undefined;
  /** Workspace folder paths, for relativising the editor's file name. */
  roots(): readonly string[];
  /** Injected so relative times in rendered briefs stay deterministic in tests. */
  now(): number;
  openReadonly(title: string, content: string): Promise<void>;
  window: {
    showErrorMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
    showInformationMessage(
      msg: string,
      opts?: MessageOptionsLike,
      ...items: string[]
    ): Thenable<string | undefined>;
  };
  log: Logger;
}

export interface BriefCommands {
  why(args?: EditorTarget): Promise<void>;
  ghost(args?: EditorTarget): Promise<void>;
  conflicts(args?: EditorTarget): Promise<void>;
  huddle(): Promise<void>;
}

function meta(id: BriefId, target: EditorTarget | undefined): EgressMeta {
  const spec = briefSpec(id);
  const action = `${spec.label} (agents.${id})`;
  if (target === undefined) return { action, files: [], omissions: [] };
  // Same conversion the RPC parameter gets. A modal that named a different line
  // from the one the brief answers about would be worse than no modal.
  const name =
    spec.context === "fileAndLine" ? `${target.ref}:${toOneBased(target.line)}` : target.ref;
  return { action, files: [{ name, note: BRIEF_FILE_NOTE }], omissions: [] };
}

export function createBriefCommands(deps: BriefCommandDeps): BriefCommands {
  // Resolve pre-supplied args first: that is what lets one command serve the
  // editor menu, the sidebar row, and (in PR 2) the hover's [Why?] link without
  // re-deriving a location the caller already knows.
  const target = (args?: EditorTarget): EditorTarget | undefined => {
    if (args !== undefined) return args;
    const editor = deps.activeEditor();
    if (editor === undefined) return undefined;
    return {
      ref: toRelativeRef(editor.document.fileName, deps.roots()),
      line: editor.selection.active.line,
    };
  };

  // One place for the whole failure story: cancelled is silent, everything else
  // shows the message verbatim with a Retry that re-runs the SAME resolved
  // args. Retry goes back through the gate — it is a new send and gets no
  // bypass for having been attempted once.
  const contain = async (id: BriefId, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
    } catch (e) {
      if (isEgressCancelled(e)) {
        deps.log.debug(`nimbus.brief.${id} cancelled at the pre-flight preview`);
        return;
      }
      deps.log.error(`nimbus.brief.${id} failed: ${errMsg(e)}`);
      const answer = await deps.window.showErrorMessage(
        `Nimbus ${briefSpec(id).label} failed: ${errMsg(e)}`,
        {},
        RETRY,
      );
      if (answer === RETRY) await contain(id, body);
    }
  };

  const connected = (): GatedBriefs | undefined => {
    const briefs = deps.briefs();
    if (briefs === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to the Gateway.");
    }
    return briefs;
  };

  const needTarget = (id: BriefId, args?: EditorTarget): EditorTarget | undefined => {
    const t = target(args);
    if (t === undefined) {
      void deps.window.showInformationMessage(
        `Nimbus: Open a file to run "${briefSpec(id).label}".`,
      );
    }
    return t;
  };

  const show = async (id: BriefId, content: string): Promise<void> => {
    await deps.openReadonly(`Nimbus — ${briefSpec(id).label}.md`, content);
  };

  return {
    why: (args) =>
      contain("why", async () => {
        const t = needTarget("why", args);
        if (t === undefined) return;
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.why(whyParams(t), meta("why", t), "Nimbus: asking why…");
        await show("why", renderWhy(brief));
      }),

    ghost: (args) =>
      contain("ghost", async () => {
        const t = needTarget("ghost", args);
        if (t === undefined) return;
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.ghost(
          fileParams(t),
          meta("ghost", t),
          "Nimbus: finding who knew this…",
        );
        await show("ghost", renderGhost(brief));
      }),

    conflicts: (args) =>
      contain("conflicts", async () => {
        const t = needTarget("conflicts", args);
        if (t === undefined) return;
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.conflicts(
          fileParams(t),
          meta("conflicts", t),
          "Nimbus: checking for collisions…",
        );
        await show("conflicts", renderConflicts(brief, deps.now()));
      }),

    huddle: () =>
      contain("huddle", async () => {
        const briefs = connected();
        if (briefs === undefined) return;
        const brief = await briefs.huddle(
          {},
          meta("huddle", undefined),
          "Nimbus: gathering the huddle…",
        );
        await show("huddle", renderHuddle(brief, deps.now()));
      }),
  };
}
