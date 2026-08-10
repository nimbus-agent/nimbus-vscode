import type { CatchupBrief, DoraMetricsResult, ExpertBrief, ImpactBrief } from "@nimbus-dev/client";
import { gapsFooter } from "../briefs/render.js";
import { errMsg } from "../logging.js";
import type {
  ChatResponseSink,
  ParticipantClientLike,
  ParticipantRequest,
} from "./participant-types.js";

// Stage 2b ops commands: structured brief/metric calls, not prompt rewrites.
// Contract: degrade honestly — an empty brief says so and surfaces the
// gateway's own gap notes; a thrown brief error renders its message.

const INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPERT_LIMIT = 5;
const SECTION_ITEM_LIMIT = 5;
const SINCE_RE = /^\d+[dh]$/;

function renderImpact(target: string, brief: ImpactBrief): string {
  if (brief.affected.length === 0) {
    return `No downstream dependents found for \`${target}\`.${gapsFooter(brief)}`;
  }
  const lines = brief.affected.map(
    (f) =>
      `- **${f.affectedTitle}** (${f.serviceId}, ${f.category}, ${f.hops} hop${f.hops === 1 ? "" : "s"}) — ${f.pathSummary}`,
  );
  return `Blast radius of \`${target}\`:\n${lines.join("\n")}${gapsFooter(brief)}`;
}

function renderExperts(topic: string, brief: ExpertBrief): string {
  if (brief.ranked.length === 0) {
    return `No expertise signals found for \`${topic}\` in the local index.${gapsFooter(brief)}`;
  }
  const lines = brief.ranked
    .slice(0, EXPERT_LIMIT)
    .map(
      (f) =>
        `- **${f.displayName}** — ${f.confidence} confidence, ${f.evidence.length} signal${f.evidence.length === 1 ? "" : "s"}`,
    );
  return `Who knows \`${topic}\`:\n${lines.join("\n")}${gapsFooter(brief)}`;
}

function renderCatchup(brief: CatchupBrief): string {
  if (brief.sections.length === 0) {
    return `Nothing notable changed in the last 24h.${gapsFooter(brief)}`;
  }
  const parts = brief.sections.map((s) => {
    const items = s.items
      .slice(0, SECTION_ITEM_LIMIT)
      .map((i) => `- ${i.title} — ${i.relevanceReasons.join(", ")}`);
    return `### ${s.serviceId} (${s.totalItemsInWindow} in window)\n${items.join("\n")}`;
  });
  return `${parts.join("\n\n")}${gapsFooter(brief)}`;
}

function renderDora(result: DoraMetricsResult): string {
  const rows: Array<[string, DoraMetricsResult["metrics"]["mttr"]]> = [
    ["Deployment frequency", result.metrics.deployment_frequency],
    ["Lead time for changes", result.metrics.lead_time_for_changes],
    ["Change failure rate", result.metrics.change_failure_rate],
    ["MTTR", result.metrics.mttr],
  ];
  const lines = rows.map(([label, m]) =>
    m.value === null
      ? `- ${label}: no data (${m.gap ?? "unqualified"})`
      : `- ${label}: ${m.value} ${m.unit} (n=${m.sample})`,
  );
  return `DORA metrics for \`${result.service}\`:\n${lines.join("\n")}`;
}

async function handleBlast(
  client: ParticipantClientLike,
  arg: string,
  req: ParticipantRequest,
  sink: ChatResponseSink,
): Promise<void> {
  const target = arg.length > 0 ? arg : req.selection?.path;
  if (target === undefined || target.length === 0) {
    sink.markdown(
      "Usage: `/blast <file-or-PR-url>` — or run it with a file open to analyze that file.",
    );
    return;
  }
  sink.markdown(renderImpact(target, await client.agentsImpact({ fileOrPrUrl: target })));
}

async function handleOwns(
  client: ParticipantClientLike,
  arg: string,
  req: ParticipantRequest,
  sink: ChatResponseSink,
): Promise<void> {
  const topic = arg.length > 0 ? arg : req.selection?.path;
  if (topic === undefined || topic.length === 0) {
    sink.markdown(
      "Usage: `/owns <topic, service, or file>` — or run it with a file open to ask about that file.",
    );
    return;
  }
  sink.markdown(
    renderExperts(topic, await client.agentsExpert({ topicOrFile: topic, limit: EXPERT_LIMIT })),
  );
}

async function handleIncident(
  client: ParticipantClientLike,
  arg: string,
  sink: ChatResponseSink,
): Promise<void> {
  const brief = await client.agentsCatchup({
    sinceMs: INCIDENT_WINDOW_MS,
    ...(arg.length > 0 ? { service: arg } : {}),
  });
  sink.markdown(renderCatchup(brief));
}

async function handleDeploys(
  client: ParticipantClientLike,
  arg: string,
  sink: ChatResponseSink,
): Promise<void> {
  const [service, since] = arg.split(/\s+/).filter((s) => s.length > 0);
  if (service === undefined) {
    sink.markdown(
      "Usage: `/deploys <service> [window]` — window is a duration like 7d or 24h (default 7d).",
    );
    return;
  }
  const window = since !== undefined && SINCE_RE.test(since) ? since : "7d";
  sink.markdown(renderDora(await client.metricsDora({ service, since: window })));
}

export async function runOpsCommand(
  client: ParticipantClientLike,
  req: ParticipantRequest,
  sink: ChatResponseSink,
  log: { warn(m: string): void },
): Promise<void> {
  const arg = req.prompt.trim();
  try {
    switch (req.command) {
      case "blast":
        return await handleBlast(client, arg, req, sink);
      case "owns":
        return await handleOwns(client, arg, req, sink);
      case "incident":
        return await handleIncident(client, arg, sink);
      case "deploys":
        return await handleDeploys(client, arg, sink);
      default:
        return;
    }
  } catch (e) {
    log.warn(`ops-command /${req.command} failed: ${errMsg(e)}`);
    sink.markdown(`Nimbus could not build that brief: ${errMsg(e)}`);
  }
}
