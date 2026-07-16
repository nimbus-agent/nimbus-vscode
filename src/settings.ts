import { clampSearchLimit } from "./search.js";
import type { WorkspaceApi } from "./vscode-shim.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Settings {
  socketPath(): string;
  autoStartGateway(): boolean;
  statusBarPollMs(): number;
  transcriptHistoryLimit(): number;
  searchLimit(): number;
  askAgent(): string;
  agents(): unknown;
  quickAskPresets(): unknown;
  hitlAlwaysModal(): boolean;
  logLevel(): LogLevel;
}

export function createSettings(workspace: WorkspaceApi): Settings {
  const cfg = (): { get<T>(k: string, d: T): T } => workspace.getConfiguration("nimbus");
  return {
    socketPath: () => cfg().get<string>("socketPath", ""),
    autoStartGateway: () => cfg().get<boolean>("autoStartGateway", false),
    statusBarPollMs: () => cfg().get<number>("statusBarPollMs", 30000),
    transcriptHistoryLimit: () => cfg().get<number>("transcriptHistoryLimit", 50),
    searchLimit: () => clampSearchLimit(cfg().get<number>("search.limit", 50)),
    askAgent: () => cfg().get<string>("askAgent", ""),
    agents: () => cfg().get<unknown>("agents", []),
    quickAskPresets: () => cfg().get<unknown>("quickAsk.presets", []),
    hitlAlwaysModal: () => cfg().get<boolean>("hitlAlwaysModal", false),
    logLevel: () => {
      const lvl = cfg().get<string>("logLevel", "info");
      if (lvl === "error" || lvl === "warn" || lvl === "info" || lvl === "debug") return lvl;
      return "info";
    },
  };
}
