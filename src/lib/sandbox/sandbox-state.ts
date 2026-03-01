export type SandboxStatus =
  | "idle"
  | "starting"
  | "uploading"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type SandboxEvent = {
  id: string;
  seq?: number;
  kind: string;
  label: string;
  status: SandboxStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  meta?: Record<string, unknown>;
};

export type SandboxFile = {
  path: string;
  name?: string;
  size?: number;
  updatedAt?: string;
  downloadUrl?: string;
};

export type SandboxBrowserSnapshot = {
  id: string;
  url: string;
  title?: string;
  screenshotUrl?: string;
  htmlSnippet?: string;
  textSnippet?: string;
  createdAt: string;
};

export type SandboxResources = {
  runtimeSeconds?: number;
  cpuPct?: number;
  memoryMb?: number;
};

export type SandboxSummary = {
  headline?: string;
  detail?: string;
  nextAction?: string;
};

export type SandboxStateV2 = {
  kind: "sandbox_state_v2";
  status: SandboxStatus;
  sessionId?: string;
  workdir?: string;
  startedAt?: string;
  updatedAt?: string;
  lastCommand?: string;
  events: SandboxEvent[];
  files?: SandboxFile[];
  browser?: SandboxBrowserSnapshot[];
  resources?: SandboxResources;
  summary?: SandboxSummary;
  view?: { mode?: "simple" | "detailed" };
};

export function isTerminalStatus(status: SandboxStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function emptySandboxState(partial?: Partial<SandboxStateV2>): SandboxStateV2 {
  return {
    kind: "sandbox_state_v2",
    status: partial?.status ?? "idle",
    sessionId: partial?.sessionId,
    workdir: partial?.workdir,
    startedAt: partial?.startedAt,
    updatedAt: partial?.updatedAt,
    lastCommand: partial?.lastCommand,
    events: Array.isArray(partial?.events) ? partial!.events : [],
    files: Array.isArray(partial?.files) ? partial!.files : [],
    browser: Array.isArray(partial?.browser) ? partial!.browser : [],
    resources: partial?.resources,
    summary: partial?.summary,
    view: partial?.view,
  };
}

function normalizeEventId(event: SandboxEvent): string {
  if (event.id) return event.id;
  if (typeof event.seq === "number") return String(event.seq);
  return `${event.kind}-${event.startedAt}`;
}

export function mergeSandboxState(
  current: SandboxStateV2 | null | undefined,
  update: Partial<SandboxStateV2>
): SandboxStateV2 {
  const base = emptySandboxState(current ?? undefined);
  const next: SandboxStateV2 = {
    ...base,
    ...update,
    kind: "sandbox_state_v2",
    events: base.events,
  };

  const incomingEvents = Array.isArray(update.events) ? update.events : [];
  if (incomingEvents.length > 0) {
    const eventMap = new Map<string, SandboxEvent>();
    for (const evt of base.events) {
      eventMap.set(normalizeEventId(evt), evt);
    }
    for (const evt of incomingEvents) {
      const id = normalizeEventId(evt);
      const prev = eventMap.get(id);
      if (prev) {
        const merged = { ...prev };
        for (const [k, v] of Object.entries(evt)) {
          if (v !== undefined) {
            (merged as Record<string, unknown>)[k] = v;
          }
        }
        eventMap.set(id, merged);
      } else {
        eventMap.set(id, evt);
      }
    }
    next.events = Array.from(eventMap.values()).sort((a, b) => {
      const aSeq = typeof a.seq === "number" ? a.seq : Number.POSITIVE_INFINITY;
      const bSeq = typeof b.seq === "number" ? b.seq : Number.POSITIVE_INFINITY;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.startedAt.localeCompare(b.startedAt);
    });
  }

  if (Array.isArray(update.files)) {
    const fileMap = new Map<string, SandboxFile>();
    for (const file of base.files ?? []) {
      fileMap.set(file.path, file);
    }
    for (const file of update.files) {
      const prev = fileMap.get(file.path);
      fileMap.set(file.path, prev ? { ...prev, ...file } : file);
    }
    next.files = Array.from(fileMap.values());
  }

  if (Array.isArray(update.browser)) {
    const browserMap = new Map<string, SandboxBrowserSnapshot>();
    for (const item of base.browser ?? []) {
      browserMap.set(item.id, item);
    }
    for (const item of update.browser) {
      const prev = browserMap.get(item.id);
      browserMap.set(item.id, prev ? { ...prev, ...item } : item);
    }
    next.browser = Array.from(browserMap.values());
  }

  return next;
}

export function normalizeSandboxState(raw: unknown): SandboxStateV2 | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Partial<SandboxStateV2> & { kind?: string };
  if (input.kind === "sandbox_state_v2") {
    return emptySandboxState(input);
  }
  if ((input as { kind?: string }).kind === "e2b_sandbox_v1") {
    const v1 = input as Record<string, unknown>;
    return emptySandboxState({
      status: "idle",
      sessionId: typeof v1.sessionId === "string" ? v1.sessionId : undefined,
      workdir: typeof v1.workdir === "string" ? v1.workdir : undefined,
      startedAt: typeof v1.startedAt === "string" ? v1.startedAt : undefined,
      updatedAt: typeof v1.updatedAt === "string" ? v1.updatedAt : undefined,
      lastCommand: typeof v1.lastCommand === "string" ? v1.lastCommand : undefined,
      events: [],
    });
  }
  return null;
}
