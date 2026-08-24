import { reportCommandFailure } from "../command-failure.js";
import type { EgressFile, EgressMeta } from "../egress/preflight.js";
import { errMsg, type Logger } from "../logging.js";
import {
  clampContext,
  extractReply,
  QUICK_ASK_MAX_CONTEXT_CHARS,
  redactPath,
} from "../quick-ask.js";
import type { WindowApi } from "../vscode-shim.js";
import {
  buildCommitPrompt,
  buildEgressTrailer,
  COMMIT_LOG_FETCH,
  COMMIT_STYLE_EXAMPLES,
  composeInputBoxValue,
  filterStyleExamples,
  sanitizeCommitMessage,
} from "./commit-message.js";
import {
  type OmittedFile,
  orderFiles,
  renderDiffBlock,
  SCM_MAX_DIFF_CHARS,
  selectWithinBudget,
} from "./diff.js";
import {
  buildDocstringsPrompt,
  buildTestsPrompt,
  deriveTestFileName,
  extractCode,
  isWholeFileRewrite,
  spliceSelection,
} from "./generate.js";
import type { DiffScope, GitRepositoryLike } from "./git-types.js";
import { classifyRepositories, findRepoByRoot, repoLabel } from "./repo-select.js";
import { buildReviewDocument, buildReviewPrompt, type ReviewCoverage } from "./review.js";

export interface ScmClientLike {
  // The third argument is the guardrail: the raw NimbusClient does not satisfy
  // this shape, so only a wrapper from src/egress/gated-client.ts fits here.
  agentInvoke(
    input: string,
    opts: { stream: boolean; agent?: string },
    meta: EgressMeta,
    /** Shown once the gate clears — never over the preview. See gated-client.ts. */
    progressTitle?: string,
  ): Promise<unknown>;
  /** Optional: present when the connected client can prove an egress window. */
  egressProveWindow?(params: {
    since?: number;
    sign?: boolean;
  }): Promise<{ receipt?: { digest: string; sigB64: string; pubkeyB64: string } }>;
}

export interface ScmCommandDeps {
  git(): Promise<import("./git-types.js").GitApiLike | undefined>;
  client(): ScmClientLike | undefined; // undefined = disconnected
  window: WindowApi;
  agent(): string; // askAgent() setting; "" = omit
  skipSecretFiles(): boolean;
  /** nimbus.scm.egressProofTrailer setting; default false. */
  egressProofTrailer(): boolean;
  // Character offsets of the active selection, or undefined when there is no
  // editor or the selection is empty. Supplied by extension.ts glue.
  selectionOffsets(): { start: number; end: number } | undefined;
  openReadonly(title: string, content: string): Promise<void>;
  openUntitled(opts: { fileName: string; content: string }): Promise<void>;
  // fileName is the redacted basename (e.g. "a.ts"); the opener puts it in both
  // virtual URIs so VS Code infers the language from the extension natively.
  openDiff(opts: { title: string; left: string; right: string; fileName: string }): Promise<void>;
  log: Logger;
}

const EGRESS_TRAILER_WINDOW_MS = 24 * 60 * 60 * 1000;

// Opt-in (nimbus.scm.egressProofTrailer): append a signed proof-of-egress
// trailer covering the last 24h. Best-effort by contract — a missing signing
// key, an older client, or a prove failure must never block the message.
async function withEgressTrailer(
  message: string,
  client: ScmClientLike,
  deps: ScmCommandDeps,
): Promise<string> {
  if (!deps.egressProofTrailer() || client.egressProveWindow === undefined) return message;
  try {
    const proof = await client.egressProveWindow({
      since: Date.now() - EGRESS_TRAILER_WINDOW_MS,
      sign: true,
    });
    if (proof.receipt === undefined) {
      deps.log.warn("scm: egress trailer skipped — no signed receipt (signing key missing?)");
      return message;
    }
    return `${message}\n\n${buildEgressTrailer(proof.receipt)}`;
  } catch (e) {
    deps.log.warn(`scm: egress trailer skipped: ${errMsg(e)}`);
    return message;
  }
}

export interface CollectedDiff {
  block: string;
  reviewed: string[];
  omittedTooLarge: string[];
  skippedSecret: string[];
  nonTextual: string[];
  /** True when git reported no changed files at all for this scope. */
  empty: boolean;
}

// A CollectedDiff, projected onto the pre-flight manifest. Paths here are
// already redacted — collectDiff produces them through relativeOrBasename.
export function collectedToFiles(collected: CollectedDiff, note: string): readonly EgressFile[] {
  return collected.reviewed.map((name) => ({ name, note }));
}

// The manifest for the two editor-context commands (Generate Tests/Docstrings),
// which send one file rather than a diff. Mirrors Quick Ask's rule: selection
// when there is one, whole file otherwise.
export function editorContextMeta(
  input: { fileName: string; hasSelection: boolean; truncated: boolean },
  action: string,
): EgressMeta {
  return {
    action,
    files: [
      {
        name: redactPath(input.fileName),
        note: input.hasSelection ? "selected code" : "whole file",
      },
    ],
    omissions: input.truncated
      ? [`Context truncated at ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`]
      : [],
  };
}

// "What leaves" is incomplete without "and what didn't". These mirror the
// toasts warnOmissions already raises, phrased for a manifest rather than a
// notification.
export function collectedToOmissions(collected: CollectedDiff): readonly string[] {
  const plural = (n: number): string => (n === 1 ? "" : "s");
  const out: string[] = [];
  const { omittedTooLarge, skippedSecret, nonTextual } = collected;
  if (omittedTooLarge.length > 0) {
    out.push(
      `${omittedTooLarge.length} file${plural(omittedTooLarge.length)} omitted (diff too large).`,
    );
  }
  if (skippedSecret.length > 0) {
    out.push(
      `${skippedSecret.length} possible secret file${plural(skippedSecret.length)} skipped.`,
    );
  }
  if (nonTextual.length > 0) {
    out.push(
      `${nonTextual.length} binary or non-textual file${plural(nonTextual.length)} not sent.`,
    );
  }
  return out;
}

// List → classify/order → fetch each file's diff → budget-select → render.
// Nothing here parses a unified diff: paths come from git, not from headers.
export async function collectDiff(
  repo: GitRepositoryLike,
  scope: DiffScope,
  skipSecrets: boolean,
): Promise<CollectedDiff> {
  const changed = await repo.changedFiles(scope);
  if (changed.length === 0) {
    return {
      block: "",
      reviewed: [],
      omittedTooLarge: [],
      skippedSecret: [],
      nonTextual: [],
      empty: true,
    };
  }
  const { ordered, omitted } = orderFiles(changed, { skipSecrets });
  const entries: Array<{ path: string; diff: string }> = [];
  for (const file of ordered) {
    entries.push({ path: file.path, diff: await repo.fileDiff(scope, file.path) });
  }
  const selection = selectWithinBudget(entries, SCM_MAX_DIFF_CHARS);
  const all: OmittedFile[] = [...omitted, ...selection.omitted];
  const withReason = (...reasons: OmittedFile["reason"][]): string[] =>
    all.filter((o) => reasons.includes(o.reason)).map((o) => o.path);
  return {
    block: renderDiffBlock(selection.files),
    reviewed: selection.files.map((f) => f.path),
    // The file cap is a size-driven omission too, so it shares the bucket.
    omittedTooLarge: withReason("too-large", "file-cap"),
    skippedSecret: withReason("secret"),
    nonTextual: withReason("non-textual"),
    empty: false,
  };
}

// Same shaped cascade needed by generateCommitMessage and reviewChanges when
// every changed file was excluded from the diff: secret trumps non-textual (an
// all-secret .env dump is not "binary"), and non-textual only wins over
// too-large when nothing was *also* dropped for size — a diff that is both
// huge and contains a binary file is more actionably reported as "too large".
type NothingReviewableReason = "secret" | "non-textual" | "too-large";

function selectNothingReviewableReason(collected: CollectedDiff): NothingReviewableReason {
  if (collected.skippedSecret.length > 0) return "secret";
  if (collected.nonTextual.length > 0 && collected.omittedTooLarge.length === 0) {
    return "non-textual";
  }
  return "too-large";
}

// Phrased per command — the cascade is shared, the wording is not. Records
// rather than ternaries so a new NothingReviewableReason fails the typecheck
// here instead of silently falling into the "too large" branch.
//
// "secret" deliberately says "one or more" rather than "every": it wins whenever
// skippedSecret is non-empty, even when nonTextual or omittedTooLarge also hold
// files, so an "every file" claim would be false in the mixed case. The other
// two are exact — "non-textual" is only reached with the other buckets empty,
// and the "too-large" wording describes the diff rather than every file.
const COMMIT_NOTHING_REVIEWABLE_DETAIL: Record<NothingReviewableReason, string> = {
  secret: "one or more staged files were skipped as possibly secret-bearing",
  "non-textual": "the staged changes are binary or non-textual",
  "too-large": "the staged diff is too large to summarise",
};

const REVIEW_NOTHING_REVIEWABLE_DETAIL: Record<NothingReviewableReason, string> = {
  secret: "one or more changed files were skipped as possibly secret-bearing",
  "non-textual": "every changed file is binary or non-textual",
  "too-large": "the changed diff is too large to review",
};

export function createScmCommands(deps: ScmCommandDeps): {
  generateCommitMessage(): Promise<void>;
  reviewChanges(): Promise<void>;
  generateTests(): Promise<void>;
  generateDocstrings(): Promise<void>;
} {
  // Resolve the git API and pick a repository, reporting each failure mode.
  // Returns undefined when the caller should stop.
  const resolveRepo = async (): Promise<GitRepositoryLike | undefined> => {
    const api = await deps.git();
    if (api === undefined) {
      void deps.window.showErrorMessage(
        "Nimbus: the built-in Git extension is disabled — enable it to use this command.",
      );
      return undefined;
    }
    const choice = classifyRepositories(api.repositories());
    if (choice.kind === "none") {
      void deps.window.showErrorMessage("Nimbus: no Git repository in this workspace.");
      return undefined;
    }
    if (choice.kind === "one") return choice.repo;
    const picked = await deps.window.showQuickPick(
      choice.repos.map((repo) => ({ label: repoLabel(repo), repo })),
      { placeHolder: "Pick a repository" },
    );
    return picked?.repo;
  };

  // Connection is checked before any diff is read, so a disconnected Gateway
  // costs nothing and reports the real problem.
  const requireClient = (): ScmClientLike | undefined => {
    const client = deps.client();
    if (client === undefined) {
      void deps.window.showErrorMessage("Nimbus: not connected to Gateway.");
    }
    return client;
  };

  const warnOmissions = (collected: CollectedDiff): void => {
    if (collected.omittedTooLarge.length > 0) {
      // Every changed file this command considered — not just reviewed +
      // too-large — so the count is not an understatement of what was left
      // out (a secret-skipped or non-textual file is still an omission).
      const total =
        collected.reviewed.length +
        collected.omittedTooLarge.length +
        collected.skippedSecret.length +
        collected.nonTextual.length;
      void deps.window.showWarningMessage(
        `Nimbus: ${collected.omittedTooLarge.length} of ${total} files omitted — diff too large.`,
      );
    }
    if (collected.skippedSecret.length > 0) {
      void deps.window.showWarningMessage(
        `Nimbus: skipped ${collected.skippedSecret.length} possible secret file(s): ${collected.skippedSecret.join(", ")}.`,
      );
    }
  };

  // Runs a handler body under one shared try/catch so a throw anywhere inside
  // it — including repo/client resolution, which call injected deps whose
  // types don't forbid throwing — is reported the same way collectDiff and
  // agentInvoke failures already are, instead of escaping as an unhandled
  // rejection.
  const contain =
    (internalName: string, humanName: string, body: () => Promise<void>) =>
    async (): Promise<void> => {
      try {
        await body();
      } catch (e) {
        reportCommandFailure(e, {
          internalName,
          humanName,
          window: deps.window,
          log: deps.log,
        });
      }
    };

  const invoke = async (
    client: ScmClientLike,
    prompt: string,
    title: string,
    meta: EgressMeta,
  ): Promise<string | undefined> => {
    const agent = deps.agent();
    const options: { stream: boolean; agent?: string } = { stream: false };
    if (agent.length > 0) options.agent = agent;
    deps.log.debug(`scm: sending ${prompt.length} chars to agentInvoke`);
    // The seam owns the progress indicator so it can hold it back until the
    // pre-flight gate has cleared the send.
    const result = await client.agentInvoke(prompt, options, meta, title);
    const reply = extractReply(result);
    if (reply === undefined) {
      void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
    }
    return reply;
  };

  // Selection when there is one, whole file otherwise — the same rule Quick Ask
  // uses. Paths we add are always redacted to a basename.
  const readEditorContext = ():
    | {
        code: string;
        truncated: boolean;
        fullText: string;
        fileName: string;
        languageId: string;
        hasSelection: boolean;
        // Captured here (t0), not by the caller after the agent call (t1):
        // agentInvoke is uncancellable and can run for seconds, during which
        // the user can move the cursor, change the selection, or switch
        // files. Reading offsets afterwards would risk splicing a stale (or
        // altogether different-document) range into this fullText.
        selectionOffsets: { start: number; end: number } | undefined;
      }
    | undefined => {
    const editor = deps.window.activeTextEditor;
    if (editor === undefined) {
      void deps.window.showErrorMessage("Nimbus: open a file first.");
      return undefined;
    }
    const selectionText = editor.selection.isEmpty ? "" : editor.document.getText(editor.selection);
    const hasSelection = selectionText.trim().length > 0;
    const fullText = editor.document.getText();
    const { code, truncated } = clampContext(
      hasSelection ? selectionText : fullText,
      QUICK_ASK_MAX_CONTEXT_CHARS,
    );
    if (truncated) {
      void deps.window.showWarningMessage(
        `Nimbus: context truncated to ${QUICK_ASK_MAX_CONTEXT_CHARS} characters.`,
      );
    }
    return {
      code,
      truncated,
      fullText,
      fileName: editor.document.fileName,
      languageId: editor.document.languageId,
      hasSelection,
      selectionOffsets: hasSelection ? deps.selectionOffsets() : undefined,
    };
  };

  return {
    generateCommitMessage: contain("generateCommitMessage", "commit message", async () => {
      const repo = await resolveRepo();
      if (repo === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      const collected = await collectDiff(repo, "staged", deps.skipSecretFiles());
      if (collected.empty) {
        void deps.window.showErrorMessage("Nimbus: nothing staged to describe.");
        return;
      }
      if (collected.reviewed.length === 0) {
        // Say which reason actually applied — "too large" for a staged PNG
        // would be a lie the user cannot act on.
        const detail = COMMIT_NOTHING_REVIEWABLE_DETAIL[selectNothingReviewableReason(collected)];
        void deps.window.showErrorMessage(`Nimbus: ${detail}.`);
        return;
      }
      warnOmissions(collected);
      // A repo with no commits yet rejects `git log` (VS Code's git extension
      // throws through it) rather than resolving []. That must still reach
      // buildCommitPrompt's deliberate "no examples → Conventional Commits"
      // fallback instead of dying here with a raw git error after the diff
      // work above is already done.
      let history: readonly string[];
      try {
        history = await repo.log(COMMIT_LOG_FETCH);
      } catch (e) {
        deps.log.debug(`scm: repo.log failed, falling back to no style examples: ${errMsg(e)}`);
        history = [];
      }
      const examples = filterStyleExamples(history, COMMIT_STYLE_EXAMPLES);
      const prompt = buildCommitPrompt({ diffBlock: collected.block, examples });
      const reply = await invoke(client, prompt, "Nimbus: drafting commit message…", {
        action: "Generate Commit Message",
        files: collectedToFiles(collected, "staged"),
        omissions: collectedToOmissions(collected),
      });
      if (reply === undefined) return;
      let message = sanitizeCommitMessage(reply);
      if (message.length === 0) {
        void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
        return;
      }
      message = await withEgressTrailer(message, client, deps);
      // agentInvoke is uncancellable and can run a while; the folder may have
      // closed meanwhile. Re-find the repo before writing, and never drop the
      // draft on the floor if it is gone.
      const api = await deps.git();
      const live =
        api === undefined ? undefined : findRepoByRoot(api.repositories(), repo.rootPath);
      if (live === undefined) {
        void deps.window.showWarningMessage(
          "Nimbus: that repository closed while the message was being drafted — showing the draft instead.",
        );
        await deps.openReadonly("Nimbus commit message.md", message);
        return;
      }
      if (live.inputBox.value.trim().length === 0) {
        live.inputBox.value = message;
        return;
      }
      const answer = await deps.window.showWarningMessage(
        "The Source Control message box already has text.",
        { modal: true },
        "Replace",
        "Append",
      );
      if (answer !== "Replace" && answer !== "Append") return;
      live.inputBox.value = composeInputBoxValue(
        live.inputBox.value,
        message,
        answer === "Replace" ? "replace" : "append",
      );
    }),

    reviewChanges: contain("reviewChanges", "review", async () => {
      const repo = await resolveRepo();
      if (repo === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      // Scope "all": staged and unstaged together. "Review my changes"
      // returning nothing because the user staged their work first would be a
      // bad first experience.
      const collected = await collectDiff(repo, "all", deps.skipSecretFiles());
      if (collected.empty) {
        void deps.window.showInformationMessage("Nimbus: no local changes to review.", {});
        return;
      }
      if (collected.reviewed.length === 0) {
        // Say which reason actually applied — mirrors generateCommitMessage's
        // cascade, phrased for review rather than for committing. This branch
        // never renders the coverage header, so the reason is all the user sees.
        const detail = REVIEW_NOTHING_REVIEWABLE_DETAIL[selectNothingReviewableReason(collected)];
        void deps.window.showErrorMessage(`Nimbus: nothing reviewable — ${detail}.`);
        return;
      }
      warnOmissions(collected);
      const reply = await invoke(
        client,
        buildReviewPrompt(collected.block),
        "Nimbus: reviewing changes…",
        {
          action: "Review Changes",
          files: collectedToFiles(collected, "staged + unstaged"),
          omissions: collectedToOmissions(collected),
        },
      );
      if (reply === undefined) return;
      // Untracked content is never sent — only counted and named here, so the
      // reader cannot mistake a brand-new file for a reviewed one.
      const coverage: ReviewCoverage = {
        repoLabel: repoLabel(repo),
        reviewed: collected.reviewed,
        omittedTooLarge: collected.omittedTooLarge,
        skippedSecret: collected.skippedSecret,
        nonTextual: collected.nonTextual,
        untracked: await repo.untrackedPaths(),
      };
      await deps.openReadonly("Nimbus review.md", buildReviewDocument(coverage, reply));
    }),

    generateTests: contain("generateTests", "generate tests", async () => {
      const ctx = readEditorContext();
      if (ctx === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      const prompt = buildTestsPrompt({
        code: ctx.code,
        filePath: redactPath(ctx.fileName),
        languageId: ctx.languageId,
        ...(ctx.truncated ? { truncated: true } : {}),
      });
      const reply = await invoke(
        client,
        prompt,
        "Nimbus: generating tests…",
        editorContextMeta(ctx, "Generate Tests"),
      );
      if (reply === undefined) return;
      // Untitled: nothing touches disk, and Save presents a location picker.
      await deps.openUntitled({
        fileName: deriveTestFileName(ctx.fileName),
        content: extractCode(reply),
      });
    }),

    generateDocstrings: contain("generateDocstrings", "generate docstrings", async () => {
      const ctx = readEditorContext();
      if (ctx === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      const prompt = buildDocstringsPrompt({
        code: ctx.code,
        filePath: redactPath(ctx.fileName),
        languageId: ctx.languageId,
        ...(ctx.truncated ? { truncated: true } : {}),
      });
      const reply = await invoke(
        client,
        prompt,
        "Nimbus: generating docstrings…",
        editorContextMeta(ctx, "Generate Docstrings"),
      );
      if (reply === undefined) return;
      const rewritten = extractCode(reply);
      const offsets = ctx.selectionOffsets;
      // A selection rewrite is spliced back into the full document, so the
      // diff shows only the annotated region rather than a whole-file
      // mismatch. Without offsets we cannot splice honestly, so fall back to
      // a read-only tab rather than showing a misleading diff.
      if (ctx.hasSelection && offsets === undefined) {
        await deps.openReadonly("Nimbus docstrings.md", rewritten);
        return;
      }
      // A whole-file reply to a selection prompt must not be spliced — that
      // would duplicate everything around the selection. Diff whole-file
      // instead, which is what the reply actually is.
      const spliceable =
        offsets !== undefined &&
        !isWholeFileRewrite(rewritten, ctx.fullText, offsets.start, offsets.end);
      if (offsets !== undefined && !spliceable) {
        deps.log.debug("scm: docstrings reply looks whole-file; diffing without splicing");
      }
      const right =
        offsets !== undefined && spliceable
          ? spliceSelection(ctx.fullText, offsets.start, offsets.end, rewritten)
          : rewritten;
      await deps.openDiff({
        title: `${redactPath(ctx.fileName)} ↔ Nimbus docstrings`,
        left: ctx.fullText,
        right,
        fileName: redactPath(ctx.fileName),
      });
    }),
  };
}
