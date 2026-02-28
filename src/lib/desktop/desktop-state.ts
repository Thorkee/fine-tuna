export type DesktopStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type DesktopEvent = {
  id: string;
  seq?: number;
  kind: string;
  label: string;
  status: DesktopStatus;
  startedAt: string;
  finishedAt?: string;
  meta?: Record<string, unknown>;
};

export type DesktopSummary = {
  headline?: string;
  detail?: string;
  nextAction?: string;
};

export type DesktopRecordingFrame = {
  seq: number;
  at: string;
  url?: string;
  key?: string;
};

export type DesktopRecording = {
  status?: "recording" | "stopped" | "failed";
  startedAt?: string;
  stoppedAt?: string;
  intervalMs?: number;
  frameCount?: number;
  truncated?: boolean;
  manifestKey?: string;
  videoUrl?: string;
  error?: string;
  frames?: DesktopRecordingFrame[];
};

export type DesktopStateV1 = {
  kind: "desktop_state_v1";
  status: DesktopStatus;
  sessionId?: string;
  startedAt?: string;
  updatedAt?: string;
  screenshotUrl?: string;
  screenshotUpdatedAt?: string;
  streamUrl?: string;
  streamUpdatedAt?: string;
  lastAction?: string;
  events: DesktopEvent[];
  summary?: DesktopSummary;
  recording?: DesktopRecording;
};

export function emptyDesktopState(partial?: Partial<DesktopStateV1>): DesktopStateV1 {
  return {
    kind: "desktop_state_v1",
    status: partial?.status ?? "idle",
    sessionId: partial?.sessionId,
    startedAt: partial?.startedAt,
    updatedAt: partial?.updatedAt,
    screenshotUrl: partial?.screenshotUrl,
    screenshotUpdatedAt: partial?.screenshotUpdatedAt,
    streamUrl: partial?.streamUrl,
    streamUpdatedAt: partial?.streamUpdatedAt,
    lastAction: partial?.lastAction,
    events: Array.isArray(partial?.events) ? partial!.events : [],
    summary: partial?.summary,
    recording: partial?.recording,
  };
}

function normalizeEventId(event: DesktopEvent): string {
  if (event.id) return event.id;
  if (typeof event.seq === "number") return String(event.seq);
  return `${event.kind}-${event.startedAt}`;
}

export function mergeDesktopState(
  current: DesktopStateV1 | null | undefined,
  update: Partial<DesktopStateV1>
): DesktopStateV1 {
  const base = emptyDesktopState(current ?? undefined);
  const next: DesktopStateV1 = {
    ...base,
    ...update,
    kind: "desktop_state_v1",
    events: base.events,
  };

  const incomingEvents = Array.isArray(update.events) ? update.events : [];
  if (incomingEvents.length > 0) {
    const eventMap = new Map<string, DesktopEvent>();
    for (const evt of base.events) {
      eventMap.set(normalizeEventId(evt), evt);
    }
    for (const evt of incomingEvents) {
      const id = normalizeEventId(evt);
      const prev = eventMap.get(id);
      eventMap.set(id, prev ? { ...prev, ...evt } : evt);
    }
    next.events = Array.from(eventMap.values()).sort((a, b) => {
      const aSeq = typeof a.seq === "number" ? a.seq : Number.POSITIVE_INFINITY;
      const bSeq = typeof b.seq === "number" ? b.seq : Number.POSITIVE_INFINITY;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.startedAt.localeCompare(b.startedAt);
    });
  }

  if (update.recording) {
    const baseRecording = base.recording ?? {};
    const mergedRecording: DesktopRecording = { ...baseRecording, ...update.recording };
    const incomingFrames = Array.isArray(update.recording.frames) ? update.recording.frames : [];
    if (incomingFrames.length > 0) {
      const frameMap = new Map<number, DesktopRecordingFrame>();
      for (const frame of baseRecording.frames ?? []) {
        if (typeof frame.seq === "number") frameMap.set(frame.seq, frame);
      }
      for (const frame of incomingFrames) {
        if (typeof frame.seq === "number") {
          const prev = frameMap.get(frame.seq);
          frameMap.set(frame.seq, prev ? { ...prev, ...frame } : frame);
        }
      }
      mergedRecording.frames = Array.from(frameMap.values()).sort((a, b) => a.seq - b.seq);
    }
    next.recording = mergedRecording;
  }

  return next;
}

export function normalizeDesktopState(raw: unknown): DesktopStateV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Partial<DesktopStateV1> & { kind?: string };
  if (input.kind === "desktop_state_v1") {
    return emptyDesktopState(input);
  }
  return null;
}
