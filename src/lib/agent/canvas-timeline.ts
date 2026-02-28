import type { CanvasTimelineEvent, CanvasTimelineEventKind } from "./types";

export type CanvasTimelineFrameInput = {
  at: string;
  kind: CanvasTimelineEventKind;
  artifactId: string;
  artifactType: string;
  data: unknown;
};

function toEpochMs(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function normalizeSeq(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function normalizeFrame(frame: CanvasTimelineFrameInput): CanvasTimelineFrameInput {
  const at = typeof frame.at === "string" && toEpochMs(frame.at) !== null
    ? frame.at
    : new Date().toISOString();
  return {
    at,
    kind: frame.kind === "open" ? "open" : "upsert",
    artifactId: typeof frame.artifactId === "string" ? frame.artifactId : "",
    artifactType: typeof frame.artifactType === "string" ? frame.artifactType : "markdown",
    data: frame.data,
  };
}

export function safeJsonEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function getCanvasTimelineEventSignature(frame: CanvasTimelineFrameInput): string {
  let data = "";
  try {
    data = JSON.stringify(frame.data);
  } catch {
    data = "";
  }
  return `${frame.kind}|${frame.artifactId}|${frame.artifactType}|${frame.at}|${data}`;
}

export function isRedundantCanvasTimelineEvent(
  last: CanvasTimelineEvent | undefined,
  next: CanvasTimelineFrameInput
): boolean {
  if (!last) return false;
  if (last.artifactId !== next.artifactId) return false;
  if (!safeJsonEqual(last.data, next.data)) return false;
  return last.kind === next.kind || (last.kind === "upsert" && next.kind === "open");
}

export function getNextCanvasTimelineSeq(timeline: CanvasTimelineEvent[]): number {
  let maxSeq = -1;
  for (let i = 0; i < timeline.length; i += 1) {
    const seq = normalizeSeq(timeline[i]?.seq, -1);
    if (seq > maxSeq) maxSeq = seq;
  }
  return maxSeq + 1;
}

export function appendCanvasTimelineEvent(
  timeline: CanvasTimelineEvent[],
  frame: CanvasTimelineFrameInput
): CanvasTimelineEvent | null {
  const normalized = normalizeFrame(frame);
  if (!normalized.artifactId.trim()) return null;
  const last = timeline[timeline.length - 1];
  if (isRedundantCanvasTimelineEvent(last, normalized)) return null;
  const next: CanvasTimelineEvent = {
    seq: getNextCanvasTimelineSeq(timeline),
    at: normalized.at,
    kind: normalized.kind,
    artifactId: normalized.artifactId,
    artifactType: normalized.artifactType,
    data: normalized.data,
  };
  timeline.push(next);
  return next;
}

export function sortCanvasTimelineEvents(timeline: CanvasTimelineEvent[]): CanvasTimelineEvent[] {
  return timeline
    .map((item, idx) => ({
      item,
      idx,
      seq: normalizeSeq(item.seq, idx),
      t: typeof item.at === "string" ? toEpochMs(item.at) : null,
    }))
    .sort((a, b) => {
      const at = a.t ?? Number.POSITIVE_INFINITY;
      const bt = b.t ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.idx - b.idx;
    })
    .map((entry, seq) => ({ ...entry.item, seq }));
}
