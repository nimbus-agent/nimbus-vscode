import { errMsg, type Logger } from "../logging.js";
import { extractReply } from "../quick-ask.js";
import { PROGRESS_LOCATION_NOTIFICATION, type WindowApi } from "../vscode-shim.js";
import {
  buildCommitPrompt,
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
import type { DiffScope, GitRepositoryLike } from "./git-types.js";
import { classifyRepositories, findRepoByRoot, repoLabel } from "./repo-select.js";

export interface ScmClientLike {
  agentInvoke(input: string, opts: { stream: boolean; agent?: string }): Promise<unknown>;
}

export interface ScmCommandDeps {
  git(): Promise<import("./git-types.js").GitApiLike | undefined>;
  client(): ScmClientLike | undefined; // undefined = disconnected
  window: WindowApi;
  agent(): string; // askAgent() setting; "" = omit
  skipSecretFiles(): boolean;
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

export interface CollectedDiff {
  block: string;
  reviewed: string[];
  omittedTooLarge: string[];
  skippedSecret: string[];
  nonTextual: string[];
  /** True when git reported no changed files at all for this scope. */
  empty: boolean;
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

  const warnOmissions = (collected: CollectedDiff, total: number): void => {
    if (collected.omittedTooLarge.length > 0) {
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

  const invoke = async (
    client: ScmClientLike,
    prompt: string,
    title: string,
  ): Promise<string | undefined> => {
    const agent = deps.agent();
    const options: { stream: boolean; agent?: string } = { stream: false };
    if (agent.length > 0) options.agent = agent;
    deps.log.debug(`scm: sending ${prompt.length} chars to agentInvoke`);
    const result = await deps.window.withProgress(
      { location: PROGRESS_LOCATION_NOTIFICATION, title },
      () => client.agentInvoke(prompt, options),
    );
    const reply = extractReply(result);
    if (reply === undefined) {
      void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
    }
    return reply;
  };

  return {
    async generateCommitMessage(): Promise<void> {
      const repo = await resolveRepo();
      if (repo === undefined) return;
      const client = requireClient();
      if (client === undefined) return;
      try {
        const collected = await collectDiff(repo, "staged", deps.skipSecretFiles());
        if (collected.empty) {
          void deps.window.showErrorMessage("Nimbus: nothing staged to describe.");
          return;
        }
        if (collected.reviewed.length === 0) {
          // Say which reason actually applied — "too large" for a staged PNG
          // would be a lie the user cannot act on.
          const reason =
            collected.skippedSecret.length > 0
              ? "every staged file was skipped as possibly secret-bearing"
              : collected.nonTextual.length > 0 && collected.omittedTooLarge.length === 0
                ? "the staged changes are binary or non-textual"
                : "the staged diff is too large to summarise";
          void deps.window.showErrorMessage(`Nimbus: ${reason}.`);
          return;
        }
        warnOmissions(collected, collected.reviewed.length + collected.omittedTooLarge.length);
        const examples = filterStyleExamples(
          await repo.log(COMMIT_LOG_FETCH),
          COMMIT_STYLE_EXAMPLES,
        );
        const prompt = buildCommitPrompt({ diffBlock: collected.block, examples });
        const reply = await invoke(client, prompt, "Nimbus: drafting commit message…");
        if (reply === undefined) return;
        const message = sanitizeCommitMessage(reply);
        if (message.length === 0) {
          void deps.window.showInformationMessage("Nimbus: the agent returned no reply.", {});
          return;
        }
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
      } catch (e) {
        deps.log.error(`nimbus.generateCommitMessage failed: ${errMsg(e)}`);
        void deps.window.showErrorMessage(`Nimbus commit message failed: ${errMsg(e)}`);
      }
    },

    async reviewChanges(): Promise<void> {
      return undefined; // Task 7
    },

    async generateTests(): Promise<void> {
      return undefined; // Task 8
    },

    async generateDocstrings(): Promise<void> {
      return undefined; // Task 8
    },
  };
}
