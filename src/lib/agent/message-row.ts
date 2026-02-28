export type MessageStatus = {
  phase: string;
  events: { label: string; detail?: string; at: string }[];
};

export type TraceSegment = {
  id: string;
  text: string;
  status?: string;
  isOpen?: boolean;
};

export type ReasoningSegment = {
  id: string;
  text: string;
  status?: string;
  isOpen?: boolean;
};

export type RenderBlock =
  | { kind: "reasoning"; id: string }
  | { kind: "trace"; id: string }
  | { kind: "status" }
  | { kind: "content" }
  | { kind: "files" };

export type BuildMessageInput = {
  id?: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  files?: unknown;
  status?: MessageStatus;
  reasoningSummary?: string;
  reasoningSegments?: ReasoningSegment[];
  traceSegments?: TraceSegment[];
  renderOrder?: RenderBlock[];
  createdAt?: string;
};

export type MissingMessageColumnFlags = {
  missingStatusColumn?: boolean;
  missingReasoningColumn?: boolean;
  missingReasoningSegmentsColumn?: boolean;
  missingTraceColumn?: boolean;
  missingRenderOrderColumn?: boolean;
};

export function buildMessageRow(input: BuildMessageInput): Record<string, unknown> {
  const row: Record<string, unknown> = {
    chat_id: input.chatId,
    role: input.role,
    content: input.content,
    files: input.files,
  };

  if (typeof input.id === "string" && input.id.trim()) {
    row.id = input.id.trim();
  }
  if (typeof input.createdAt === "string" && input.createdAt.trim()) {
    row.created_at = input.createdAt;
  }
  if (input.status) {
    row.status = input.status;
  }
  if (typeof input.reasoningSummary === "string" && input.reasoningSummary.trim()) {
    row.reasoning_summary = input.reasoningSummary;
  }

  if (Array.isArray(input.reasoningSegments) && input.reasoningSegments.length > 0) {
    const trimmedSegments = input.reasoningSegments
      .map((segment) => ({
        id: segment.id,
        text: typeof segment.text === "string" ? segment.text.trim() : "",
      }))
      .filter((segment) => segment.text);
    if (trimmedSegments.length > 0) {
      row.reasoning_segments = trimmedSegments;
    }
  }

  if (Array.isArray(input.traceSegments) && input.traceSegments.length > 0) {
    const trimmedSegments = input.traceSegments
      .map((segment) => ({
        id: segment.id,
        text: typeof segment.text === "string" ? segment.text.trim() : "",
      }))
      .filter((segment) => segment.text);
    if (trimmedSegments.length > 0) {
      row.trace_segments = trimmedSegments;
    }
  }

  if (Array.isArray(input.renderOrder) && input.renderOrder.length > 0) {
    const trimmedOrder = input.renderOrder
      .map((block) => {
        if (!block || typeof block !== "object") return null;
        if (block.kind === "reasoning" || block.kind === "trace") {
          return block.id ? { kind: block.kind, id: block.id } : null;
        }
        if (block.kind === "status" || block.kind === "content" || block.kind === "files") {
          return { kind: block.kind };
        }
        return null;
      })
      .filter(Boolean);
    if (trimmedOrder.length > 0) {
      row.render_order = trimmedOrder;
    }
  }

  return row;
}

export function buildFallbackMessageRow(
  row: Record<string, unknown>,
  missing: MissingMessageColumnFlags
): Record<string, unknown> {
  const fallbackRow: Record<string, unknown> = { ...row };
  if (missing.missingStatusColumn) delete fallbackRow.status;
  if (missing.missingReasoningColumn) delete fallbackRow.reasoning_summary;
  if (missing.missingReasoningSegmentsColumn) delete fallbackRow.reasoning_segments;
  if (missing.missingTraceColumn) delete fallbackRow.trace_segments;
  if (missing.missingRenderOrderColumn) delete fallbackRow.render_order;
  return fallbackRow;
}
