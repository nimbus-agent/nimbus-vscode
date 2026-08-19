export type ExtensionToWebview =
  | { type: "reset" }
  | {
      type: "hydrate";
      turns: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
    }
  | { type: "userMessage"; text: string }
  | { type: "token"; text: string }
  | { type: "subTask"; subTaskId: string; status: string; progress?: number }
  | {
      type: "hitlInline";
      requestId: string;
      prompt: string;
      details?: unknown;
    }
  | { type: "done"; reply: string; sessionId: string }
  | { type: "cancelled" }
  | { type: "error"; message: string }
  | {
      type: "emptyState";
      sub: "no-transcript" | "disconnected" | "permission-denied";
      socketPath?: string;
    }
  | { type: "themeChange" }
  | {
      type: "attachments";
      chips: ReadonlyArray<{
        id: string;
        label: string;
        detail: string;
        state: "sent" | "clamped" | "refused";
        chars: number;
      }>;
      totalChars: number;
      provisional: boolean;
    }
  | {
      type: "turnAttachments";
      chips: ReadonlyArray<{
        label: string;
        detail: string;
        state: "sent" | "clamped" | "refused";
        chars: number;
      }>;
    };

export type WebviewToExtension =
  | { type: "submitAsk"; text: string }
  | { type: "stopStream" }
  | { type: "hitlResponse"; requestId: string; decision: "approve" | "reject" }
  | { type: "requestRehydrate"; sessionId: string }
  | { type: "ready" }
  | { type: "openLogs" }
  | { type: "startGateway" }
  | { type: "openExternal"; url: string }
  | { type: "detachContext"; id: string }
  | { type: "openAttachPicker" };
