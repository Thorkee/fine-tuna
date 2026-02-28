"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Terminal } from "lucide-react";

import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";
import { useArtifactChatId } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import {
  emptySandboxState,
  isTerminalStatus,
  mergeSandboxState,
  normalizeSandboxState,
  type SandboxEvent,
  type SandboxStateV2,
} from "@/lib/sandbox/sandbox-state";
import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import TerminalViewer from "@/app/components/ui/TerminalViewer";

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  starting: "Starting…",
  uploading: "Uploading…",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};




function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function buildTerminalLog(events: SandboxEvent[]): string {
  if (!Array.isArray(events) || events.length === 0) return "";
  const entries = new Map<
    string,
    { kind: string; label: string; stdout?: string; stderr?: string; status: string; durationMs?: number }
  >();
  const order: string[] = [];

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    const kind = evt.kind;
    if (kind !== "command" && kind !== "exec" && kind !== "pty") continue;
    const id = evt.id || `${kind}-${evt.startedAt}`;
    if (!entries.has(id)) {
      entries.set(id, { kind, label: evt.label, status: evt.status, durationMs: evt.durationMs });
      order.push(id);
    }
    const entry = entries.get(id);
    if (!entry) continue;
    if (typeof evt.stdout === "string") entry.stdout = evt.stdout;
    if (typeof evt.stderr === "string") entry.stderr = evt.stderr;
    entry.status = evt.status;
    if (evt.durationMs !== undefined) entry.durationMs = evt.durationMs;
  }

  return order
    .map((id) => {
      const entry = entries.get(id);
      if (!entry) return "";
      const prompt = entry.kind === "pty"
        ? "\x1b[1;34m#\x1b[0m"
        : "\x1b[1;32m$\x1b[0m";
      const header = `${prompt} \x1b[1m${entry.label}\x1b[0m`;
      const stdout = entry.stdout ? entry.stdout.trimEnd() : "";
      const stderr = entry.stderr
        ? `\n\x1b[31m--- STDERR ---\x1b[0m\n${entry.stderr.trimEnd()}`
        : "";
      const suffix = entry.status === "completed" && entry.durationMs != null
        ? `\n\x1b[2m[completed in ${(entry.durationMs / 1000).toFixed(1)}s]\x1b[0m`
        : entry.status === "failed"
          ? `\n\x1b[31m[exited with error]\x1b[0m`
          : "";
      return [header, stdout, stderr, suffix].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}


type SandboxContextValue = {
  state: SandboxStateV2;
  status: SandboxStateV2["status"];
  lastEvent?: SandboxEvent;
  updatedAtLabel: string;
  terminalLog: string;
  lastCommand: string;
  isReadOnly: boolean;
  fallbackData?: unknown;
  hasEverHadSession: boolean;
  isEmpty: boolean;
};

const SandboxContext = createContext<SandboxContextValue | null>(null);

function useSandboxContext() {
  const ctx = useContext(SandboxContext);
  if (!ctx) {
    throw new Error("Sandbox panels must be used within SandboxStateProvider.");
  }
  return ctx;
}

function SandboxEmptyState({ hasEverHadSession }: { hasEverHadSession: boolean }) {
  const loadingLabel = hasEverHadSession
    ? "Waiting for a new sandbox session..."
    : "Waiting for a sandbox session...";
  return (
    <div className="h-full flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400">
      <Terminal className="w-10 h-10 mb-3 opacity-30" />
      <p className="text-sm font-medium">
        {hasEverHadSession ? "No active sandbox session." : "Sandbox is ready when you start a session."}
      </p>
      <p className="text-xs mt-1">
        {hasEverHadSession ? "Start a new sandbox to run commands." : "Ask the agent to start a sandbox or run a command."}
      </p>
      <ArtifactLoadingState
        variant="inline"
        title={loadingLabel}
        className="mt-3 text-xs text-zinc-400 dark:text-zinc-500"
      />
    </div>
  );
}

export function SandboxStateProvider(props: {
  dataOverride?: unknown;
  children: React.ReactNode;
}) {
  const dataOverride = props.dataOverride;
  const { artifacts } = useProjectArtifacts();
  const resolvedData = useMemo(() => {
    if (dataOverride !== undefined) return dataOverride;
    const a = artifacts.find((x) => x.id === "sandbox");
    return a?.data as unknown;
  }, [artifacts, dataOverride]);
  const baseState = useMemo(() => normalizeSandboxState(resolvedData), [resolvedData]);
  const [liveState, setLiveState] = useState<SandboxStateV2 | null>(null);
  const pollRef = useRef<number | null>(null);
  const afterRef = useRef<number>(0);
  const hasSessionRef = useRef(false);
  const params = useParams();
  const routeChatId = useMemo(() => {
    const raw = (params as { chatId?: string | string[] })?.chatId;
    if (Array.isArray(raw)) return raw[0] ?? "";
    return typeof raw === "string" ? raw : "";
  }, [params]);
  const contextChatId = useArtifactChatId();
  const chatId = contextChatId ?? routeChatId;

  const state = useMemo(() => {
    const base = baseState ?? emptySandboxState();
    return mergeSandboxState(base, liveState ?? {});
  }, [baseState, liveState]);

  const isReadOnly = dataOverride !== undefined;
  const sessionId = state.sessionId;
  const status = state.status ?? "idle";
  const lastEvent = state.events[state.events.length - 1];
  const updatedAtLabel = formatTime(state.updatedAt ?? lastEvent?.startedAt);
  const persistRef = useRef<{ lastSeq: number; lastAt: number; lastStatus?: string; timer?: number }>({
    lastSeq: 0,
    lastAt: 0,
    lastStatus: undefined,
  });

  useEffect(() => {
    if (state.sessionId || state.events.length > 0) {
      hasSessionRef.current = true;
    }
  }, [state.sessionId, state.events.length]);

  useEffect(() => {
    if (isReadOnly || !sessionId || !chatId || isTerminalStatus(status)) return;
    const latestSeq = Math.max(
      0,
      ...state.events.map((evt) => (typeof evt.seq === "number" ? evt.seq : 0))
    );
    afterRef.current = latestSeq;

    let cancelled = false;
    const poll = async () => {
      try {
        const eventsResp = await fetch(
          `/api/runner/sessions/${sessionId}/events?chatId=${chatId}&after=${afterRef.current}&limit=200`
        );
        if (eventsResp.ok) {
          const data = (await eventsResp.json()) as { events?: SandboxEvent[]; next_after?: number };
          const events = Array.isArray(data.events) ? data.events : [];
          if (events.length > 0) {
            afterRef.current = typeof data.next_after === "number" ? data.next_after : afterRef.current;
            setLiveState((prev) =>
              mergeSandboxState(prev ?? emptySandboxState(), {
                events,
                updatedAt: new Date().toISOString(),
              })
            );
          }
        }
        const statusResp = await fetch(
          `/api/runner/sessions/${sessionId}/status?chatId=${chatId}`
        );
        if (statusResp.ok) {
          const data = (await statusResp.json()) as { status?: string; updated_at?: string; billing_error?: string };
          if (data?.status) {
            setLiveState((prev) =>
              mergeSandboxState(prev ?? emptySandboxState(), {
                status: data.status as SandboxStateV2["status"],
                updatedAt: data.updated_at ?? new Date().toISOString(),
                summary:
                  data.status === "cancelled" && data.billing_error === "insufficient_credits"
                    ? {
                        headline: "Sandbox stopped (out of credits)",
                        detail: "Add credits to start a new sandbox session.",
                        nextAction: "Buy credits or restart the sandbox.",
                      }
                    : undefined,
              })
            );
          }
        } else if (statusResp.status === 404) {
          // Session expired/cleaned up in runner; stop polling locally.
          setLiveState((prev) =>
            mergeSandboxState(prev ?? emptySandboxState(), {
              status: "cancelled",
              updatedAt: new Date().toISOString(),
              summary: {
                headline: "Sandbox session ended",
                detail: "The sandbox session is no longer available (expired or closed).",
                nextAction: "Start a new sandbox session.",
              },
            })
          );
        }
      } catch (error) {
        // ignore polling errors; we'll retry
      } finally {
        if (!cancelled) {
          pollRef.current = window.setTimeout(poll, 1000);
        }
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [chatId, isReadOnly, sessionId, status, state.events]);

  useEffect(() => {
    if (isReadOnly || !chatId || !sessionId) return;
    const latestSeq = Math.max(
      0,
      ...state.events.map((evt) => (typeof evt.seq === "number" ? evt.seq : 0))
    );
    if (latestSeq <= persistRef.current.lastSeq && persistRef.current.lastStatus === status) return;

    const persist = async () => {
      const now = Date.now();
      persistRef.current.lastSeq = latestSeq;
      persistRef.current.lastAt = now;
      persistRef.current.lastStatus = status;
      const payload = {
        chatId,
        artifact: {
          id: "sandbox",
          type: "markdown",
          data: state,
          status: "executing",
          isCollaborative: false,
        },
      };
      try {
        await fetch("/api/chat/artifacts/upsert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        // ignore persistence errors
      }
    };

    const now = Date.now();
    const elapsed = now - persistRef.current.lastAt;
    if (elapsed < 1500) {
      if (persistRef.current.timer) window.clearTimeout(persistRef.current.timer);
      persistRef.current.timer = window.setTimeout(persist, 1500 - elapsed);
      return;
    }
    persist();
  }, [chatId, isReadOnly, sessionId, state, state.events]);
  const terminalLog = buildTerminalLog(state.events);
  const commandFromMeta =
    typeof lastEvent?.meta?.command === "string" ? String(lastEvent.meta.command) : undefined;
  const lastCommand =
    commandFromMeta ?? (typeof state.lastCommand === "string" ? state.lastCommand : "");

  const fallbackData = resolvedData && !baseState ? resolvedData : undefined;
  const isEmpty = !state.sessionId && !state.events.length;

  const value = useMemo<SandboxContextValue>(
    () => ({
      state,
      status,
      lastEvent,
      updatedAtLabel,
      terminalLog,
      lastCommand,
      isReadOnly,
      fallbackData,
      hasEverHadSession: hasSessionRef.current,
      isEmpty,
    }),
    [
      state,
      status,
      lastEvent,
      updatedAtLabel,
      terminalLog,
      lastCommand,
      isReadOnly,
      fallbackData,
      isEmpty,
    ]
  );

  return <SandboxContext.Provider value={value}>{props.children}</SandboxContext.Provider>;
}

export function SandboxCodePanel() {
  const { fallbackData, hasEverHadSession, isEmpty } = useSandboxContext();
  const { sandboxCode } = useProjectArtifacts();

  if (fallbackData) {
    return (
      <div className="h-full overflow-y-auto animate-fade-in-up">
        <GenericArtifactRenderer artifactId="sandbox" dataOverride={fallbackData} />
      </div>
    );
  }

  if (isEmpty) {
    return <SandboxEmptyState hasEverHadSession={hasEverHadSession} />;
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500">Code</div>
      <div className="glass-inset p-3 text-xs font-mono whitespace-pre-wrap break-words">
        {sandboxCode || "No code selected yet."}
      </div>
    </div>
  );
}

export function SandboxTerminalPanel() {
  const {
    status,
    terminalLog,
    lastCommand,
    fallbackData,
    hasEverHadSession,
    isEmpty,
  } = useSandboxContext();

  if (fallbackData) {
    return (
      <div className="h-full overflow-y-auto animate-fade-in-up">
        <GenericArtifactRenderer artifactId="sandbox" dataOverride={fallbackData} />
      </div>
    );
  }

  if (isEmpty) {
    return <SandboxEmptyState hasEverHadSession={hasEverHadSession} />;
  }

  const combined = terminalLog;
  const isActive = status === "running" || status === "starting" || status === "uploading" || status === "waiting";
  const isFailed = status === "failed";
  const statusLabel = STATUS_LABELS[status] ?? "Idle";
  const titleText = lastCommand
    ? `${lastCommand.length > 50 ? lastCommand.slice(0, 47) + "…" : lastCommand}`
    : "Sandbox Terminal";

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-xl border border-[#21262d] bg-[#0d1117]">
      {/* Mac-style terminal header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-[#161b22] border-b border-[#21262d] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e0443e]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e] border border-[#dea123]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840] border border-[#1aab29]" />
        </div>
        <div className="flex-1 min-w-0 flex items-center justify-center gap-2">
          <span className="text-[11px] text-[#8b949e] font-mono truncate">
            {titleText}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {isActive ? (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] text-emerald-400 font-mono">{statusLabel}</span>
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              <span className="text-[10px] text-red-400 font-mono">{statusLabel}</span>
            </span>
          ) : (
            <span className="text-[10px] text-[#484f58] font-mono">{statusLabel}</span>
          )}
        </div>
      </div>
      {/* Terminal content */}
      <div className="flex-1 min-h-0">
        <TerminalViewer
          content={combined || ""}
          showCursor={isActive}
          variant={isFailed ? "error" : "default"}
          className="!rounded-none !border-0 !min-h-0 h-full"
        />
      </div>
      {!combined ? (
        <div className="px-4 py-3 text-xs text-[#484f58] font-mono border-t border-[#21262d]">
          Waiting for output…
        </div>
      ) : null}
    </div>
  );
}

export function SandboxFilesPanel() {
  const { state, fallbackData, hasEverHadSession, isEmpty } = useSandboxContext();

  if (fallbackData) {
    return (
      <div className="h-full overflow-y-auto animate-fade-in-up">
        <GenericArtifactRenderer artifactId="sandbox" dataOverride={fallbackData} />
      </div>
    );
  }

  if (isEmpty) {
    return <SandboxEmptyState hasEverHadSession={hasEverHadSession} />;
  }

  return (
    <div className="space-y-3">
      {state.files && state.files.length > 0 ? (
        state.files.map((file) => (
          <div key={file.path} className="flex items-start justify-between gap-3 glass-inset px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{file.name ?? file.path}</div>
              <div className="text-[11px] text-zinc-500 truncate">{file.path}</div>
            </div>
            {file.downloadUrl ? (
              <a
                href={file.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-emerald-600 dark:text-emerald-300 hover:underline whitespace-nowrap"
              >
                Download
              </a>
            ) : (
              <span className="text-xs text-zinc-400 whitespace-nowrap">No link</span>
            )}
          </div>
        ))
      ) : (
        <div className="text-xs text-zinc-500">No files recorded yet.</div>
      )}
    </div>
  );
}

export function SandboxBrowserPanel() {
  const { state, fallbackData, hasEverHadSession, isEmpty } = useSandboxContext();

  if (fallbackData) {
    return (
      <div className="h-full overflow-y-auto animate-fade-in-up">
        <GenericArtifactRenderer artifactId="sandbox" dataOverride={fallbackData} />
      </div>
    );
  }

  if (isEmpty) {
    return <SandboxEmptyState hasEverHadSession={hasEverHadSession} />;
  }

  return (
    <div className="space-y-4">
      {state.browser && state.browser.length > 0 ? (
        state.browser.map((snap) => (
          <div key={snap.id} className="glass-card overflow-hidden">
            <div className="px-3 py-2 text-xs text-zinc-500 glass-header">
              <div className="truncate">{snap.title ?? snap.url}</div>
              <div className="text-[10px] text-zinc-400 truncate">{snap.url}</div>
            </div>
            {snap.screenshotUrl && (
              <img src={snap.screenshotUrl} alt="Browser preview" className="w-full h-auto" />
            )}
          </div>
        ))
      ) : (
        <div className="text-xs text-zinc-500">No browser previews yet.</div>
      )}
    </div>
  );
}

export default function PythonSandboxArtifact(props: { dataOverride?: unknown } = {}) {
  const dataOverride = props.dataOverride;
  return (
    <SandboxStateProvider dataOverride={dataOverride}>
      <SandboxCodePanel />
    </SandboxStateProvider>
  );
}
