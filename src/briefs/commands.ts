import { type GatedBriefs, isEgressCancelled } from "../egress/gated-client.js";
import type { EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import type { MessageOptionsLike, TextEditorLike } from "../vscode-shim.js";
import { type BriefId, briefSpec } from "./catalog.js";
import { memoryFolder, type NamespaceStore } from "./namespace-store.js";
import {
  type EditorTarget,
  fileParams,
  type JanitorTarget,
  janitorParams,
  preflightParams,
  toOneBased,
  toRelativeRef,
  whyParams,
} from "./params.js";
import {
  renderConflicts,
  renderGhost,
  renderHuddle,
  renderJanitor,
  renderPreflight,
  renderWhy,
} from "./render.js";

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
  /** Last namespace typed and confirmed, keyed per workspace folder. */
  namespaces: NamespaceStore;
  /** The nimbus.briefs.defaultNamespace setting; "" when unset. */
  defaultNamespace(): string;
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
    showInputBox(opts?: {
      prompt?: string;
      value?: string;
      placeHolder?: string;
      validateInput?: (value: string) => string | undefined;
    }): Thenable<string | undefined>;
  };
  log: Logger;
}

export interface BriefCommands {
  why(args?: EditorTarget): Promise<void>;
  ghost(args?: EditorTarget): Promise<void>;
  conflicts(args?: EditorTarget): Promise<void>;
  huddle(): Promise<void>;
  janitor(): Promise<void>;
  preflight(): Promise<void>;
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

// `prompted` briefs carry a ref the user typed rather than an editor path, so
// the manifest names that ref. BRIEF_FILE_NOTE still applies: the extension
// sends a path, and what the Gateway does after is the ledger's business.
function promptedMeta(id: BriefId, ref: string): EgressMeta {
  return {
    action: `${briefSpec(id).label} (agents.${id})`,
    files: [{ name: ref, note: BRIEF_FILE_NOTE }],
    omissions: [],
  };
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

  // One place for the whole SEND failure story: cancelled is silent,
  // everything else shows the message verbatim with a Retry that re-runs the
  // SAME resolved args. Retry goes back through the gate — it is a new send
  // and gets no bypass for having been attempted once. Wraps only the send —
  // callers do whatever comes after (rendering, remembering a namespace)
  // outside this, via `afterSend`, so a post-send failure can never be
  // mistaken for a send failure or trigger a re-send.
  const contain = async <T>(id: BriefId, body: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await body();
    } catch (e) {
      if (isEgressCancelled(e)) {
        deps.log.debug(`nimbus.brief.${id} cancelled at the pre-flight preview`);
        return undefined;
      }
      deps.log.error(`nimbus.brief.${id} failed: ${errMsg(e)}`);
      const answer = await deps.window.showErrorMessage(
        `Nimbus ${briefSpec(id).label} failed: ${errMsg(e)}`,
        {},
        RETRY,
      );
      return answer === RETRY ? contain(id, body) : undefined;
    }
  };

  // Runs after a successful send. The brief already reached the Gateway, so a
  // failure here — opening the read-only tab, a render throw, a workspaceState
  // write — is not a send failure: it must not produce the "failed" message
  // (the user would retry a brief that already succeeded, causing a needless
  // second send) and it is not a success worth announcing either. Logged only.
  const afterSend = async (id: BriefId, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      deps.log.error(`nimbus.brief.${id} succeeded but the follow-up failed: ${errMsg(e)}`);
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

  const POSITIVE_INT = /^[1-9]\d*$/;
  const IDLE_DAYS_ERROR =
    "Enter a whole number of days greater than zero, or leave blank for the Gateway default.";

  // showInputBox has THREE outcomes, not two, and collapsing them sends
  // something the user tried to cancel. Escape returns undefined; Enter on a
  // blank box returns "". Those mean opposite things on the idleDays prompt —
  // abort the command, versus accept the Gateway's default — so the type keeps
  // them apart rather than the call sites guessing.
  type Answer = { kind: "dismissed" } | { kind: "value"; value: string };

  const ask = async (
    prompt: string,
    opts: { value?: string; validate?: (v: string) => string | undefined } = {},
  ): Promise<Answer> => {
    const answer = await deps.window.showInputBox({
      prompt,
      ...(opts.value !== undefined && opts.value.length > 0 ? { value: opts.value } : {}),
      ...(opts.validate !== undefined ? { validateInput: opts.validate } : {}),
    });
    if (answer === undefined) return { kind: "dismissed" };
    return { kind: "value", value: answer.trim() };
  };

  /** A required answer: dismissed or blank both cancel, and both do so silently. */
  const askRequired = async (
    prompt: string,
    opts: { value?: string } = {},
  ): Promise<string | undefined> => {
    const answer = await ask(prompt, opts);
    if (answer.kind === "dismissed" || answer.value.length === 0) return undefined;
    return answer.value;
  };

  const askJanitor = async (): Promise<JanitorTarget | undefined> => {
    const editor = deps.activeEditor();
    const prefill =
      editor === undefined ? undefined : toRelativeRef(editor.document.fileName, deps.roots());
    const resourceRef = await askRequired("Resource to check for idleness", {
      ...(prefill !== undefined ? { value: prefill } : {}),
    });
    if (resourceRef === undefined) return undefined;

    const days = await ask("Idle for how many days? (blank = Gateway default)", {
      validate: (v) =>
        v.trim().length === 0 || POSITIVE_INT.test(v.trim()) ? undefined : IDLE_DAYS_ERROR,
    });
    // Escape aborts the whole command. Blank means "use the Gateway default",
    // which is a decision, not an abort. Treating Escape as blank would send a
    // brief the user was trying to cancel — and a user who ticked "Always send
    // Agent Briefs here" gets no modal to catch it.
    if (days.kind === "dismissed") return undefined;
    return days.value.length === 0
      ? { resourceRef }
      : { resourceRef, idleDays: Number(days.value) };
  };

  const askPreflight = async (): Promise<
    { ref: string; namespace: string; folder: string | undefined } | undefined
  > => {
    const ref = await askRequired("Ref to pre-flight (branch, tag or commit)");
    if (ref === undefined) return undefined;
    const editor = deps.activeEditor();
    const folder = memoryFolder(editor?.document.fileName, deps.roots());
    // Remembered first, then the setting. Never derived: a wrong namespace does
    // not error, it answers confidently about the wrong thing.
    const prefill = deps.namespaces.recall(folder) ?? deps.defaultNamespace();
    // Required, so an empty answer cancels rather than sending a guess — the
    // same outcome as Escape, which is why this one uses askRequired.
    const namespace = await askRequired("Namespace to pre-flight against", { value: prefill });
    if (namespace === undefined) return undefined;
    return { ref, namespace, folder };
  };

  return {
    why: async (args) => {
      const t = needTarget("why", args);
      if (t === undefined) return;
      const brief = await contain("why", async () =>
        connected()?.why(whyParams(t), meta("why", t), "Nimbus: asking why…"),
      );
      if (brief === undefined) return;
      await afterSend("why", () => show("why", renderWhy(brief)));
    },

    ghost: async (args) => {
      const t = needTarget("ghost", args);
      if (t === undefined) return;
      const brief = await contain("ghost", async () =>
        connected()?.ghost(fileParams(t), meta("ghost", t), "Nimbus: finding who knew this…"),
      );
      if (brief === undefined) return;
      await afterSend("ghost", () => show("ghost", renderGhost(brief)));
    },

    conflicts: async (args) => {
      const t = needTarget("conflicts", args);
      if (t === undefined) return;
      const brief = await contain("conflicts", async () =>
        connected()?.conflicts(
          fileParams(t),
          meta("conflicts", t),
          "Nimbus: checking for collisions…",
        ),
      );
      if (brief === undefined) return;
      await afterSend("conflicts", () => show("conflicts", renderConflicts(brief, deps.now())));
    },

    huddle: async () => {
      const brief = await contain("huddle", async () =>
        connected()?.huddle({}, meta("huddle", undefined), "Nimbus: gathering the huddle…"),
      );
      if (brief === undefined) return;
      await afterSend("huddle", () => show("huddle", renderHuddle(brief, deps.now())));
    },

    janitor: async () => {
      const target = await askJanitor();
      if (target === undefined) return;
      const brief = await contain("janitor", async () =>
        connected()?.janitor(
          janitorParams(target),
          promptedMeta("janitor", target.resourceRef),
          "Nimbus: checking whether this is idle…",
        ),
      );
      if (brief === undefined) return;
      await afterSend("janitor", () => show("janitor", renderJanitor(brief)));
    },

    preflight: async () => {
      const answers = await askPreflight();
      if (answers === undefined) return;
      const brief = await contain("preflight", async () =>
        connected()?.preflight(
          preflightParams(answers),
          promptedMeta("preflight", answers.ref),
          "Nimbus: pre-flighting…",
        ),
      );
      if (brief === undefined) return;
      await afterSend("preflight", async () => {
        // Only after a successful send: a namespace that never reached the
        // Gateway is not a value worth prefilling next time.
        await deps.namespaces.remember(answers.folder, answers.namespace);
        await show("preflight", renderPreflight(brief));
      });
    },
  };
}
