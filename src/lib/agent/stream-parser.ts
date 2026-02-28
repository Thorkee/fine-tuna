import type {
  MessageStatus,
  ReasoningSegment,
  RenderBlock,
  TraceSegment,
} from "@/lib/agent/message-row";

export type StreamStatusEvent = { label: string; detail?: string; at: string };

export type StreamMessageLike = {
  content: string;
  status?: MessageStatus;
  reasoningSummary?: string;
  reasoningSummaryStatus?: "loading" | "done" | "error";
  reasoningSummaryError?: string;
  reasoningSegments?: ReasoningSegment[];
  traceSegments?: TraceSegment[];
  renderOrder?: RenderBlock[];
};

export type UpdateMessage<T extends StreamMessageLike> = (updater: (m: T) => T) => void;

type StreamMode = "trace" | "answer";

const DEFAULT_TRACE_BOUNDARY_LABELS = ["reading", "executing", "web_search"];
const DEFAULT_TRACE_MARKERS = ["TRACE:"];
const DEFAULT_ANSWER_MARKERS = ["FINAL:", "ANSWER:"];

const CANONICAL_RENDER_ORDER: Array<RenderBlock["kind"]> = [
  "reasoning",
  "status",
  "trace",
  "content",
  "files",
];

function canonicalizeRenderOrder(order: RenderBlock[]): RenderBlock[] {
  if (order.length <= 1) return order;
  const buckets = new Map<RenderBlock["kind"], RenderBlock[]>();
  for (const kind of CANONICAL_RENDER_ORDER) {
    buckets.set(kind, []);
  }
  for (const block of order) {
    const bucket = buckets.get(block.kind);
    if (bucket) bucket.push(block);
  }
  return CANONICAL_RENDER_ORDER.flatMap((kind) => buckets.get(kind) ?? []);
}

function appendRenderBlock(order: RenderBlock[], block: RenderBlock): RenderBlock[] {
  const exists = order.some((entry) => {
    if (entry.kind !== block.kind) return false;
    if (entry.kind === "reasoning" || entry.kind === "trace") {
      return "id" in entry && "id" in block && entry.id === block.id;
    }
    return true;
  });
  if (exists) return order;
  return canonicalizeRenderOrder([...order, block]);
}

function collapseTraceSegments(segments: TraceSegment[]) {
  return segments.map((segment) => ({
    ...segment,
    status: segment.status === "streaming" ? "closed" : segment.status,
    isOpen: false,
  }));
}

function collapseReasoningSegments(segments: ReasoningSegment[]) {
  return segments.map((segment) => ({
    ...segment,
    status: segment.status === "streaming" ? "closed" : segment.status,
    isOpen: false,
  }));
}

function defaultCreateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `stream-${Math.random().toString(36).slice(2, 10)}`;
}

export function createStreamParser<T extends StreamMessageLike>(opts: {
  updateAssistant: UpdateMessage<T>;
  updateReasoningOwner?: UpdateMessage<T>;
  createId?: () => string;
  traceBoundaryLabels?: string[];
  traceMarkers?: string[];
  answerMarkers?: string[];
  onAssistantOutput?: () => void;
}) {
  const updateAssistant = opts.updateAssistant;
  const updateReasoningOwner = opts.updateReasoningOwner ?? opts.updateAssistant;
  const createId = opts.createId ?? defaultCreateId;
  const traceBoundaryLabels = new Set(
    (opts.traceBoundaryLabels ?? DEFAULT_TRACE_BOUNDARY_LABELS).map((label) => label.toLowerCase())
  );
  const traceMarkers = (opts.traceMarkers ?? DEFAULT_TRACE_MARKERS).map((m) => m.toUpperCase());
  const answerMarkers = (opts.answerMarkers ?? DEFAULT_ANSWER_MARKERS).map((m) => m.toUpperCase());
  const streamMarkers = [...traceMarkers, ...answerMarkers];

  let activeTraceSegmentId: string | null = null;
  let activeTraceText = "";
  let activeReasoningSegmentId: string | null = null;
  let activeReasoningText = "";
  let answerContent = "";
  let streamMode: StreamMode = "answer";
  let streamLineBuffer = "";
  let hadAssistantOutput = false;

  const markAssistantOutput = () => {
    if (hadAssistantOutput) return;
    hadAssistantOutput = true;
    opts.onAssistantOutput?.();
  };

  const startTraceSegment = () => {
    const id = createId();
    activeTraceSegmentId = id;
    activeTraceText = "";
    updateAssistant((m) => {
      const existing = Array.isArray(m.traceSegments) ? m.traceSegments : [];
      const closed = collapseTraceSegments(existing);
      const next: TraceSegment = { id, text: "", status: "streaming", isOpen: true };
      const order = Array.isArray(m.renderOrder) ? m.renderOrder : [];
      const nextOrder = appendRenderBlock(order, { kind: "trace", id });
      return { ...m, renderOrder: nextOrder, traceSegments: [...closed, next] };
    });
    return id;
  };

  const closeActiveReasoningSegment = () => {
    const segmentId = activeReasoningSegmentId;
    if (!segmentId) return;
    activeReasoningSegmentId = null;
    activeReasoningText = "";
    updateReasoningOwner((m) => {
      const segments = Array.isArray(m.reasoningSegments) ? [...m.reasoningSegments] : [];
      const idx = segments.findIndex((s) => s.id === segmentId);
      if (idx === -1) return m;
      const target = segments[idx];
      const text = target.text.trim();
      if (!text) {
        segments.splice(idx, 1);
      } else {
        segments[idx] = { ...target, text, status: "closed", isOpen: false };
      }
      const collapsed = collapseReasoningSegments(segments);
      return collapsed.length > 0
        ? { ...m, reasoningSegments: collapsed }
        : { ...m, reasoningSegments: undefined };
    });
  };

  const closeActiveTraceSegment = () => {
    const segmentId = activeTraceSegmentId;
    if (!segmentId) return;
    activeTraceSegmentId = null;
    activeTraceText = "";
    updateAssistant((m) => {
      const segments = Array.isArray(m.traceSegments) ? [...m.traceSegments] : [];
      const idx = segments.findIndex((s) => s.id === segmentId);
      if (idx === -1) return m;
      const target = segments[idx];
      const text = target.text.trim();
      if (!text) {
        segments.splice(idx, 1);
      } else {
        segments[idx] = { ...target, text, status: "closed", isOpen: false };
      }
      const collapsed = collapseTraceSegments(segments);
      return collapsed.length > 0 ? { ...m, traceSegments: collapsed } : { ...m, traceSegments: undefined };
    });
  };

  const appendTraceSegmentDelta = (delta: string) => {
    if (!delta) return;
    closeActiveReasoningSegment();
    if (!activeTraceSegmentId) {
      startTraceSegment();
    }
    const segmentId = activeTraceSegmentId;
    if (!segmentId) return;
    activeTraceText += delta;
    if (!hadAssistantOutput && activeTraceText.trim()) {
      markAssistantOutput();
    }
    const nextText = activeTraceText;
    updateAssistant((m) => {
      const segments = Array.isArray(m.traceSegments) ? [...m.traceSegments] : [];
      const idx = segments.findIndex((s) => s.id === segmentId);
      if (idx === -1) {
        const closed = collapseTraceSegments(segments);
        return {
          ...m,
          traceSegments: [
            ...closed,
            { id: segmentId, text: nextText, status: "streaming", isOpen: true },
          ],
        };
      }
      segments[idx] = {
        ...segments[idx],
        text: nextText,
        status: "streaming",
        isOpen: true,
      };
      return { ...m, traceSegments: segments };
    });
  };

  const appendAnswerDelta = (delta: string) => {
    if (!delta) return;
    closeActiveReasoningSegment();
    answerContent += delta;
    updateAssistant((m) => {
      const order = Array.isArray(m.renderOrder) ? m.renderOrder : [];
      const nextOrder = appendRenderBlock(order, { kind: "content" });
      return { ...m, renderOrder: nextOrder, content: answerContent };
    });
    if (!hadAssistantOutput && answerContent.trim()) {
      markAssistantOutput();
    }
  };

  const startReasoningSegment = () => {
    const id = createId();
    activeReasoningSegmentId = id;
    activeReasoningText = "";
    updateReasoningOwner((m) => {
      const existing = Array.isArray(m.reasoningSegments) ? m.reasoningSegments : [];
      const closed = collapseReasoningSegments(existing);
      const next: ReasoningSegment = { id, text: "", status: "streaming", isOpen: true };
      const order = Array.isArray(m.renderOrder) ? m.renderOrder : [];
      const nextOrder = appendRenderBlock(order, { kind: "reasoning", id });
      return { ...m, renderOrder: nextOrder, reasoningSegments: [...closed, next] };
    });
    return id;
  };

  const appendReasoningSegmentDelta = (delta: string) => {
    if (!delta) return;
    if (!activeReasoningSegmentId) {
      startReasoningSegment();
    }
    const segmentId = activeReasoningSegmentId;
    if (!segmentId) return;
    activeReasoningText += delta;
    const nextText = activeReasoningText;
    updateReasoningOwner((m) => {
      const segments = Array.isArray(m.reasoningSegments) ? [...m.reasoningSegments] : [];
      const idx = segments.findIndex((s) => s.id === segmentId);
      if (idx === -1) {
        const closed = collapseReasoningSegments(segments);
        return {
          ...m,
          reasoningSummary: `${m.reasoningSummary ?? ""}${delta}`,
          reasoningSummaryStatus: "loading",
          reasoningSummaryError: undefined,
          reasoningSegments: [
            ...closed,
            { id: segmentId, text: nextText, status: "streaming", isOpen: true },
          ],
        };
      }
      segments[idx] = {
        ...segments[idx],
        text: nextText,
        status: "streaming",
        isOpen: true,
      };
      return {
        ...m,
        reasoningSummary: `${m.reasoningSummary ?? ""}${delta}`,
        reasoningSummaryStatus: "loading",
        reasoningSummaryError: undefined,
        reasoningSegments: segments,
      };
    });
  };

  const setStreamMode = (mode: StreamMode) => {
    if (streamMode === mode) return;
    streamMode = mode;
    if (mode === "answer") {
      closeActiveTraceSegment();
    }
  };

  const findLeadingMarker = (value: string) => {
    const trimmed = value.trimStart();
    const upper = trimmed.toUpperCase();
    for (const marker of streamMarkers) {
      if (upper.startsWith(marker)) {
        return { marker, trimmed };
      }
    }
    return null;
  };

  const isPotentialMarkerPrefix = (value: string) => {
    const trimmedUpper = value.trimStart().toUpperCase();
    if (!trimmedUpper) return false;
    return streamMarkers.some(
      (marker) => marker.startsWith(trimmedUpper) && trimmedUpper.length < marker.length
    );
  };

  const handleStreamLine = (line: string) => {
    const marker = findLeadingMarker(line);
    if (marker) {
      if (answerMarkers.includes(marker.marker)) {
        setStreamMode("answer");
      } else if (traceMarkers.includes(marker.marker)) {
        setStreamMode("trace");
      }
      const remainder = marker.trimmed.slice(marker.marker.length).replace(/^ /, "");
      if (remainder) {
        const withNewline = line.endsWith("\n") ? `${remainder}\n` : remainder;
        if (streamMode === "answer") {
          appendAnswerDelta(withNewline);
        } else {
          appendTraceSegmentDelta(withNewline);
        }
      }
      return;
    }
    if (streamMode === "answer") {
      appendAnswerDelta(line);
    } else {
      appendTraceSegmentDelta(line);
    }
  };

  const appendStreamContentDelta = (delta: string) => {
    if (!delta) return;
    streamLineBuffer += delta;
    const lines = streamLineBuffer.split("\n");
    streamLineBuffer = lines.pop() || "";
    lines.forEach((line: string) => handleStreamLine(`${line}\n`));

    const marker = findLeadingMarker(streamLineBuffer);
    if (marker && marker.trimmed.length >= marker.marker.length) {
      handleStreamLine(streamLineBuffer);
      streamLineBuffer = "";
      return;
    }

    if (!isPotentialMarkerPrefix(streamLineBuffer) && streamLineBuffer) {
      const remainder = streamLineBuffer;
      streamLineBuffer = "";
      handleStreamLine(remainder);
    }
  };

  const flushStreamBuffer = () => {
    if (!streamLineBuffer) return;
    handleStreamLine(streamLineBuffer);
    streamLineBuffer = "";
  };

  const appendStatusEvent = (event: StreamStatusEvent) => {
    updateAssistant((m) => {
      const existing = m.status ?? { phase: "", events: [] };
      const order = Array.isArray(m.renderOrder) ? m.renderOrder : [];
      const nextOrder = appendRenderBlock(order, { kind: "status" });
      return {
        ...m,
        renderOrder: nextOrder,
        status: {
          phase: existing.phase || event.label,
          events: [...existing.events, event],
        },
      };
    });
    if (traceBoundaryLabels.has(event.label.toLowerCase())) {
      closeActiveTraceSegment();
      closeActiveReasoningSegment();
    }
  };

  const appendReasoningSummaryDelta = (delta: string) => {
    appendReasoningSegmentDelta(delta);
  };

  const promoteFinalTraceSegment = (opts?: { promote?: boolean }) => {
    updateAssistant((m) => {
      const segments = Array.isArray(m.traceSegments) ? [...m.traceSegments] : [];
      if (segments.length === 0) return m;
      const closed: TraceSegment[] = segments
        .map((segment): TraceSegment => ({
          ...segment,
          status: "closed",
          isOpen: false,
          text: segment.text.trim(),
        }))
        .filter((segment) => segment.text);
      if (closed.length === 0) {
        return { ...m, traceSegments: undefined };
      }
      const shouldPromote = opts?.promote !== false && !m.content.trim();
      if (!shouldPromote) {
        return { ...m, traceSegments: closed };
      }
      const last = closed[closed.length - 1];
      const remaining = closed.slice(0, -1);
      const next: StreamMessageLike = {
        ...m,
        traceSegments: remaining.length > 0 ? remaining : undefined,
      };
      if (last.text) {
        markAssistantOutput();
        next.content = last.text;
      }
      return next as T;
    });
    activeTraceSegmentId = null;
    activeTraceText = "";
  };

  const resetForNewMessage = (opts?: { initialContent?: string }) => {
    activeTraceText = "";
    activeTraceSegmentId = null;
    activeReasoningText = "";
    activeReasoningSegmentId = null;
    answerContent = opts?.initialContent ?? "";
    streamMode = "answer";
    streamLineBuffer = "";
  };

  return {
    appendStatusEvent,
    appendReasoningSummaryDelta,
    appendContentDelta: appendStreamContentDelta,
    appendAnswerDelta,
    flushStreamBuffer,
    closeActiveReasoningSegment,
    closeActiveTraceSegment,
    promoteFinalTraceSegment,
    resetForNewMessage,
    hasAssistantOutput: () => hadAssistantOutput,
  };
}
