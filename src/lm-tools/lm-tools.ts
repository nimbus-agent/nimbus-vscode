import { confirmationMessage, type EgressMeta } from "../egress/preflight.js";
import { errMsg } from "../logging.js";
import { normalizeInline, parseRankedItem } from "../search.js";

// The client slice the LM tools need. The `meta` argument is the guardrail: the
// raw NimbusClient no longer satisfies this shape, so only a wrapper from
// src/egress/gated-client.ts fits. Kept minimal so the pure handlers stay
// trivially fakeable.
export interface LmToolsClientLike {
  searchRanked(params: { name: string; limit?: number }): Promise<unknown[]>;
  agentInvoke(
    input: string,
    options: { stream?: boolean; agent?: string },
    meta: EgressMeta,
  ): Promise<{ reply?: string } & Record<string, unknown>>;
}

export interface LmToolsDeps {
  client: () => LmToolsClientLike | undefined;
  /** settings.askAgent(); blank = gateway default agent. */
  askAgent: () => string;
  /** Leak-check needles. Held locally, never sent. */
  roots: () => readonly string[];
  log: { warn(msg: string): void };
}

const ASK_ACTION = "Ask Nimbus";

const NOT_CONNECTED =
  'The Nimbus Gateway is not connected on this machine, so the private local index is unavailable. The user can run "Nimbus: Start Gateway".';

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 20;
const SNIPPET_MAX = 200;

function stringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const v = (input as Record<string, unknown>)[field];
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  return v.trim();
}

// LM tools answer in text, never throw: a thrown error surfaces to the model
// as a tool failure, while a text explanation lets it recover or tell the user.
export async function runNimbusSearchTool(deps: LmToolsDeps, input: unknown): Promise<string> {
  const query = stringField(input, "query");
  if (query === undefined) return 'Invalid input: "query" (a non-empty string) is required.';
  const client = deps.client();
  if (client === undefined) return NOT_CONNECTED;
  const rawLimit = (input as Record<string, unknown>)["limit"];
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.min(SEARCH_LIMIT_MAX, Math.max(SEARCH_LIMIT_MIN, Math.round(rawLimit)))
      : SEARCH_LIMIT_DEFAULT;
  try {
    const rows = await client.searchRanked({ name: query, limit });
    const results = rows
      .map(parseRankedItem)
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    if (results.length === 0) return `No matches in the local index for "${query}".`;
    const lines = results.map((r) => {
      const snippet = r.snippet !== undefined ? `: ${normalizeInline(r.snippet, SNIPPET_MAX)}` : "";
      return `- ${r.name} (${r.service})${snippet}`;
    });
    return `Local index matches for "${query}":\n${lines.join("\n")}`;
  } catch (e) {
    deps.log.warn(`lm-tools: searchRanked failed: ${errMsg(e)}`);
    return `Nimbus lookup failed: ${errMsg(e)}`;
  }
}

// Built for prepareInvocation, so the leak check runs BEFORE the calling chat
// asks the user. The question text on this path is written by another model,
// which may well quote an absolute path it read from disk — the one outbound
// path where nobody on this machine chose the words.
//
// Returns undefined for invalid input, leaving runNimbusAskTool to explain the
// problem in text (an LM tool that throws reads to the caller as a failure).
export function buildAskConfirmation(
  deps: { roots(): readonly string[] },
  input: unknown,
): { title: string; message: string } | undefined {
  const question = stringField(input, "question");
  if (question === undefined) return undefined;
  return confirmationMessage({
    kind: "lmTool",
    action: ASK_ACTION,
    prompt: question,
    files: [],
    omissions: [],
    roots: deps.roots(),
  });
}

export async function runNimbusAskTool(deps: LmToolsDeps, input: unknown): Promise<string> {
  const question = stringField(input, "question");
  if (question === undefined) return 'Invalid input: "question" (a non-empty string) is required.';
  const client = deps.client();
  if (client === undefined) return NOT_CONNECTED;
  const agent = deps.askAgent();
  try {
    const result = await client.agentInvoke(
      question,
      {
        stream: false,
        ...(agent.length > 0 ? { agent } : {}),
      },
      { action: ASK_ACTION, files: [], omissions: [] },
    );
    return result.reply ?? "(the agent returned no reply)";
  } catch (e) {
    deps.log.warn(`lm-tools: agentInvoke failed: ${errMsg(e)}`);
    return `Nimbus lookup failed: ${errMsg(e)}`;
  }
}
