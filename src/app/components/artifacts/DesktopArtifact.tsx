"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Monitor, MousePointer2, Pause, Play, RefreshCcw, X } from "lucide-react";

import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";
import { useArtifactChatId } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import {
  emptyDesktopState,
  mergeDesktopState,
  normalizeDesktopState,
  type DesktopRecording,
  type DesktopRecordingFrame,
  type DesktopEvent,
  type DesktopStateV1,
} from "@/lib/desktop/desktop-state";
import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import { parseSupabaseStorageUrl, resolveSignedStorageUrl } from "@/lib/client/storage-links";

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

const STATUS_STYLES: Record<string, string> = {
  idle: "bg-zinc-200/70 text-zinc-700 dark:bg-white/10 dark:text-zinc-200",
  starting: "bg-amber-100/80 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  running: "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  completed: "bg-green-100/80 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  failed: "bg-red-100/80 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  stopped: "bg-zinc-100/70 text-zinc-600 dark:bg-zinc-700/30 dark:text-zinc-300",
};

const STATUS_NORMALIZATION: Record<string, DesktopStateV1["status"]> = {
  idle: "idle",
  starting: "starting",
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  active: "running",
  live: "running",
  streaming: "running",
};

const CONTROL_SHIELD_CLASS =
  "absolute inset-x-0 top-0 h-16 pointer-events-auto z-10";

function normalizeDesktopStatus(raw: unknown): DesktopStateV1["status"] | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = STATUS_NORMALIZATION[raw.trim().toLowerCase()];
  return normalized;
}

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DesktopEmptyState({ hasSession }: { hasSession: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 px-6 text-center">
      <div className="w-12 h-12 rounded-2xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-white/5 flex items-center justify-center mb-4">
        <Monitor className="w-6 h-6 opacity-60" />
      </div>
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {hasSession ? "Desktop session is idle." : "Desktop is ready when you start a session."}
      </p>
      <p className="text-xs mt-2 text-zinc-500 dark:text-zinc-400">
        {hasSession ? "Start a new session to continue." : "Ask the agent to start a desktop session."}
      </p>
    </div>
  );
}

function DesktopPreviewPlaceholder({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 px-6 text-center">
      <div className="w-12 h-12 rounded-2xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-white/5 flex items-center justify-center mb-4">
        <Monitor className="w-6 h-6 opacity-60" />
      </div>
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
      {subtitle ? <p className="text-xs mt-2 text-zinc-500 dark:text-zinc-400">{subtitle}</p> : null}
      <ArtifactLoadingState
        variant="inline"
        title="Waiting for updates..."
        className="mt-3 text-xs text-zinc-400 dark:text-zinc-500"
      />
    </div>
  );
}

function getArtifactsStorageTarget(raw: string): { bucket: "artifacts" | "runner-artifacts"; storagePath: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("artifacts/")) {
    return { bucket: "artifacts", storagePath: trimmed.slice("artifacts/".length) };
  }
  if (trimmed.startsWith("runner-outputs/") || trimmed.startsWith("exports/")) {
    return { bucket: "artifacts", storagePath: trimmed };
  }
  if (trimmed.startsWith("desktop/")) {
    return { bucket: "runner-artifacts", storagePath: trimmed };
  }
  const parsed = parseSupabaseStorageUrl(trimmed);
  if (parsed && (parsed.bucket === "artifacts" || parsed.bucket === "runner-artifacts")) {
    return { bucket: parsed.bucket, storagePath: parsed.storagePath };
  }
  return null;
}

export default function DesktopArtifact(props: { dataOverride?: unknown; shareId?: string } = {}) {
  const dataOverride = props.dataOverride;
  const shareId = props.shareId;
  const { artifacts } = useProjectArtifacts();
  const resolvedData = useMemo(() => {
    if (dataOverride !== undefined) return dataOverride;
    const artifact = artifacts.find((x) => x.id === "desktop");
    return artifact?.data as unknown;
  }, [artifacts, dataOverride]);

  const baseState = useMemo(() => normalizeDesktopState(resolvedData), [resolvedData]);
  const [liveState, setLiveState] = useState<DesktopStateV1 | null>(null);
  const [streamRefreshKey, setStreamRefreshKey] = useState(0);
  const [streamActive, setStreamActive] = useState<boolean | null>(null);
  const [resolvedStreamUrl, setResolvedStreamUrlState] = useState<string | null>(null);
  const resolvedStreamUrlRef = useRef<string | null>(null);
  const setResolvedStreamUrl = (url: string | null) => {
    resolvedStreamUrlRef.current = url;
    setResolvedStreamUrlState(url);
  };
  const desktopPollRef = useRef<number | null>(null);
  const eventsAfterRef = useRef<number>(0);
  const recordingAfterRef = useRef<number>(0);
  const lastSessionKeyRef = useRef<string>("");
  const streamFrameRef = useRef<HTMLIFrameElement | null>(null);
  const persistRef = useRef<{
    lastAt: number;
    lastSeq: number;
    lastFrameSeq: number;
    lastStatus?: string;
    timer?: number;
  }>({
    lastAt: 0,
    lastSeq: 0,
    lastFrameSeq: 0,
    lastStatus: undefined,
  });
  const streamActiveRef = useRef<boolean | null>(null);
  const streamInactiveCountRef = useRef(0);
  const previewCacheRef = useRef<Map<string, string>>(new Map());
  const previewRequestRef = useRef(0);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [takeoverEnabled, setTakeoverEnabled] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffNotes, setHandoffNotes] = useState("");
  const [resolvedPreviewUrl, setResolvedPreviewUrl] = useState<string | null>(null);

  const params = useParams();
  const routeChatId = useMemo(() => {
    const raw = (params as { chatId?: string | string[] })?.chatId;
    if (Array.isArray(raw)) return raw[0] ?? "";
    return typeof raw === "string" ? raw : "";
  }, [params]);
  const contextChatId = useArtifactChatId();
  const chatId = contextChatId ?? routeChatId;

  const state = useMemo(() => {
    const base = baseState ?? emptyDesktopState();
    return mergeDesktopState(base, liveState ?? {});
  }, [baseState, liveState]);

  // `DesktopArtifact` can run live polling + dispatch takeover/handoff events.
  // For shared chat replays we must *always* be read-only (no polling, no control events),
  // even if we're rendering the "latest" snapshot frame (no dataOverride passed).
  const isReadOnly = dataOverride !== undefined || Boolean(shareId);
  const sessionId = state.sessionId;
  const status = state.status ?? "idle";
  const sessionKey = `${chatId || "unknown"}:${sessionId ?? "none"}`;
  const lastEvent: DesktopEvent | undefined = state.events[state.events.length - 1];
  const updatedAtLabel = formatTime(state.updatedAt ?? lastEvent?.startedAt);
  const hasSession = Boolean(
    sessionId ||
      state.events.length > 0 ||
      state.streamUrl ||
      state.screenshotUrl ||
      state.startedAt ||
      state.updatedAt ||
      status !== "idle"
  );

  const streamUrl = state.streamUrl;
  const recording = state.recording;
  const recordingFrames = recording?.frames ?? [];
  const recordingIntervalMs = recording?.intervalMs ?? 1000;
  const hasRecording = recordingFrames.length > 0;
  const recordingLabel =
    recording?.status === "recording"
      ? "live"
      : recording?.status === "failed"
        ? "failed"
        : recording?.status === "stopped"
          ? "replay"
          : status === "running"
            ? "live"
            : "replay";

  const handleStopAgent = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("tuna-desktop-stop-agent", { detail: { source: "desktop" } }));
  };

  const handleTakeover = () => {
    handleStopAgent();
    setTakeoverEnabled(true);
  };

  const handleHandoff = () => {
    if (typeof window === "undefined") return;
    const notes = handoffNotes.trim();
    window.dispatchEvent(new CustomEvent("tuna-desktop-handoff", { detail: { notes } }));
    setHandoffNotes("");
    setHandoffOpen(false);
    setTakeoverEnabled(false);
  };

  useEffect(() => {
    if (!isReadOnly) return;
    if (takeoverEnabled) setTakeoverEnabled(false);
    if (handoffOpen) setHandoffOpen(false);
  }, [handoffOpen, isReadOnly, takeoverEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("tuna-desktop-takeover", {
        detail: { active: takeoverEnabled },
      })
    );
    return () => {
      if (!takeoverEnabled) return;
      window.dispatchEvent(
        new CustomEvent("tuna-desktop-takeover", {
          detail: { active: false },
        })
      );
    };
  }, [takeoverEnabled]);

  useEffect(() => {
    if (takeoverEnabled) return;
    if (handoffOpen) setHandoffOpen(false);
  }, [handoffOpen, takeoverEnabled]);

  useEffect(() => {
    if (!takeoverEnabled) return;
    if (typeof window === "undefined") return;
    const handler = (event: KeyboardEvent) => {
      if (!streamFrameRef.current) return;
      if (document.activeElement !== streamFrameRef.current) return;
      const key = event.key.toLowerCase();
      const normalizedKey = key === " " ? "space" : key;
      const isAlt = event.altKey;
      const isCtrl = event.ctrlKey;
      const isMeta = event.metaKey;
      const isShift = event.shiftKey;
      const blocked =
        (isMeta && ["tab", "q", "w", "m", "h", "`"].includes(normalizedKey)) ||
        (isAlt && ["tab", "f4", "f7", "f8", "f9", "escape", "f10", "f11", "space"].includes(normalizedKey)) ||
        (isCtrl && isAlt && ["delete", "backspace"].includes(normalizedKey)) ||
        (isCtrl && ["escape"].includes(normalizedKey)) ||
        (isCtrl && isShift && normalizedKey === "escape") ||
        normalizedKey === "f11";
      if (!blocked) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [takeoverEnabled]);

  useEffect(() => {
    if (isReadOnly) return;
    if (lastSessionKeyRef.current === sessionKey) return;
    lastSessionKeyRef.current = sessionKey;
    eventsAfterRef.current = 0;
    recordingAfterRef.current = 0;
    persistRef.current.lastAt = 0;
    persistRef.current.lastSeq = 0;
    persistRef.current.lastFrameSeq = 0;
    persistRef.current.lastStatus = undefined;
    if (persistRef.current.timer) window.clearTimeout(persistRef.current.timer);
    persistRef.current.timer = undefined;
    setPlaybackIndex(0);
    setIsPlaying(false);
    setStreamRefreshKey(0);
    setLiveState(null);
    streamActiveRef.current = null;
    streamInactiveCountRef.current = 0;
    setStreamActive(null);
    setResolvedStreamUrl(null);
    setResolvedPreviewUrl(null);
  }, [isReadOnly, sessionKey]);

  useEffect(() => {
    if (!sessionId || !chatId || isReadOnly) return;
    let cancelled = false;

    const normalizeRecording = (input: unknown): DesktopRecording | undefined => {
      if (!input || typeof input !== "object") return undefined;
      const raw = input as Record<string, unknown>;
      const status =
        raw.status === "recording" || raw.status === "stopped" || raw.status === "failed"
          ? (raw.status as DesktopRecording["status"])
          : undefined;
      return {
        status,
        startedAt: typeof raw.started_at === "string" ? raw.started_at : undefined,
        stoppedAt: typeof raw.stopped_at === "string" ? raw.stopped_at : undefined,
        intervalMs: typeof raw.interval_ms === "number" ? raw.interval_ms : undefined,
        frameCount: typeof raw.frame_count === "number" ? raw.frame_count : undefined,
        truncated: typeof raw.truncated === "boolean" ? raw.truncated : undefined,
        manifestKey: typeof raw.manifest_key === "string" ? raw.manifest_key : undefined,
        error: typeof raw.error === "string" ? raw.error : undefined,
        frames: Array.isArray(raw.frames)
          ? raw.frames
              .map((frame) => {
                if (!frame || typeof frame !== "object") return null;
                const f = frame as Record<string, unknown>;
                const seq = typeof f.seq === "number" ? f.seq : NaN;
                const at = typeof f.at === "string" ? f.at : "";
                if (!Number.isFinite(seq) || !at) return null;
                return {
                  seq,
                  at,
                  url: typeof f.url === "string" ? f.url : undefined,
                  key: typeof f.key === "string" ? f.key : undefined,
                } as DesktopRecordingFrame;
              })
              .filter((frame): frame is DesktopRecordingFrame => Boolean(frame))
          : undefined,
      };
    };

    const poll = async () => {
      try {
        const eventsResp = await fetch(
          `/api/runner/desktop/sessions/${sessionId}/events?chatId=${chatId}&after=${eventsAfterRef.current}&limit=200`
        );
        if (eventsResp.ok) {
          const data = (await eventsResp.json()) as { events?: DesktopEvent[]; next_after?: number };
          const events = Array.isArray(data.events) ? data.events : [];
          if (events.length > 0) {
            eventsAfterRef.current =
              typeof data.next_after === "number" ? data.next_after : eventsAfterRef.current;
            setLiveState((prev) =>
              mergeDesktopState(prev ?? emptyDesktopState(), {
                events,
                updatedAt: new Date().toISOString(),
              })
            );
          }
        }

        const statusResp = await fetch(`/api/runner/desktop/sessions/${sessionId}?chatId=${chatId}`);
        if (statusResp.ok) {
          const data = (await statusResp.json()) as Record<string, unknown>;
          const recordingData = normalizeRecording(data.recording);
          const statusNormalized = normalizeDesktopStatus(data.status);
          const streamActiveValue = typeof data.stream_active === "boolean" ? data.stream_active : undefined;
          if (typeof streamActiveValue === "boolean") {
            if (streamActiveValue) {
              streamInactiveCountRef.current = 0;
              if (streamActiveRef.current !== true) {
                streamActiveRef.current = true;
                setStreamActive(true);
              }
            } else {
              streamInactiveCountRef.current = Math.min(streamInactiveCountRef.current + 1, 2);
              if (streamInactiveCountRef.current >= 2 && streamActiveRef.current !== false) {
                streamActiveRef.current = false;
                setStreamActive(false);
              }
            }
          }
          if (statusNormalized && statusNormalized !== "running") {
            streamInactiveCountRef.current = 2;
            if (streamActiveRef.current !== false) {
              streamActiveRef.current = false;
              setStreamActive(false);
            }
          }
          const update: Partial<DesktopStateV1> = {
            updatedAt: typeof data.updated_at === "string" ? data.updated_at : new Date().toISOString(),
            recording: recordingData,
          };
          if (statusNormalized) update.status = statusNormalized;
          else if (streamActiveValue === true) update.status = "running";
          const shouldClearStream = Boolean(statusNormalized && statusNormalized !== "running");
          if (shouldClearStream) {
            update.streamUrl = undefined;
            update.streamUpdatedAt = new Date().toISOString();
            setResolvedStreamUrl(null);
          } else if (streamActiveValue === true && sessionId && chatId) {
            if (!streamUrl) {
              update.streamUrl = `/api/runner/desktop/sessions/${sessionId}/stream?chatId=${chatId}`;
              update.streamUpdatedAt = new Date().toISOString();
            }
            if (!resolvedStreamUrlRef.current) {
              try {
                const streamResp = await fetch(
                  `/api/runner/desktop/sessions/${sessionId}/stream?chatId=${chatId}&format=json`
                );
                if (streamResp.ok) {
                  const streamData = await streamResp.json().catch(() => null) as { url?: string } | null;
                  if (streamData?.url) setResolvedStreamUrl(streamData.url);
                }
              } catch {
                // stream URL resolution failed; keep existing
              }
            }
          }
          setLiveState((prev) => mergeDesktopState(prev ?? emptyDesktopState(), update));
        } else if (statusResp.status === 404) {
          setLiveState((prev) =>
            mergeDesktopState(prev ?? emptyDesktopState(), {
              status: "stopped",
              streamUrl: undefined,
              streamUpdatedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              summary: {
                headline: "Desktop session ended",
                detail: "The desktop session is no longer available.",
                nextAction: "Start a new desktop session.",
              },
            })
          );
        }

        const recordingResp = await fetch(
          `/api/runner/desktop/sessions/${sessionId}/recording?chatId=${chatId}&after=${recordingAfterRef.current}&limit=200`
        );
        if (recordingResp.ok) {
          const data = (await recordingResp.json()) as { recording?: unknown; next_after?: number };
          const recordingData = normalizeRecording(data.recording);
          if (recordingData?.frames && recordingData.frames.length > 0) {
            recordingAfterRef.current =
              typeof data.next_after === "number" ? data.next_after : recordingAfterRef.current;
            setLiveState((prev) =>
              mergeDesktopState(prev ?? emptyDesktopState(), {
                recording: recordingData,
                updatedAt: new Date().toISOString(),
              })
            );
          }
        }
      } catch {
        // ignore polling errors
      } finally {
        if (!cancelled) {
          desktopPollRef.current = window.setTimeout(poll, 2500);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (desktopPollRef.current) window.clearTimeout(desktopPollRef.current);
    };
  }, [chatId, isReadOnly, sessionId]);

  const streamSrc = useMemo(() => {
    if (status !== "running") return null;
    if (resolvedStreamUrl) return resolvedStreamUrl;
    if (!streamUrl) return null;
    const stamp = state.streamUpdatedAt ?? "";
    const suffixes = [];
    if (stamp) suffixes.push(`ts=${encodeURIComponent(stamp)}`);
    if (streamRefreshKey) suffixes.push(`refresh=${streamRefreshKey}`);
    if (suffixes.length === 0) return streamUrl;
    return `${streamUrl}${streamUrl.includes("?") ? "&" : "?"}${suffixes.join("&")}`;
  }, [resolvedStreamUrl, state.streamUpdatedAt, status, streamRefreshKey, streamUrl]);
  const showStream = Boolean(streamSrc) && streamActive !== false;
  const currentFrame = hasRecording
    ? recordingFrames[Math.min(playbackIndex, recordingFrames.length - 1)]
    : undefined;
  const previewCandidate = useMemo(() => {
    if (currentFrame?.url) return currentFrame.url;
    if (currentFrame?.key) return currentFrame.key;
    if (state.screenshotUrl) return state.screenshotUrl;
    return "";
  }, [currentFrame?.key, currentFrame?.url, state.screenshotUrl]);
  const immediatePreviewUrl = useMemo(() => {
    const raw = previewCandidate?.trim();
    if (!raw) return null;
    if (shareId) {
      const target = getArtifactsStorageTarget(raw);
      if (!target) return null;
      return `/api/share/${encodeURIComponent(shareId)}/storage?bucket=${target.bucket}&path=${encodeURIComponent(target.storagePath)}`;
    }
    if (/^(blob|data):/i.test(raw)) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    return null;
  }, [previewCandidate, shareId]);
  const previewUrl = resolvedPreviewUrl ?? immediatePreviewUrl;
  useEffect(() => {
    const raw = previewCandidate?.trim();
    if (!raw) {
      setResolvedPreviewUrl(null);
      return;
    }
    const cacheKey = /^https?:\/\//i.test(raw)
      ? `url:${raw}`
      : (() => {
          const target = getArtifactsStorageTarget(raw);
          return target ? `${target.bucket}:${target.storagePath}` : null;
        })();
    if (cacheKey) {
      const cached = previewCacheRef.current.get(cacheKey);
      if (cached) {
        setResolvedPreviewUrl(cached);
        return;
      }
    }
    if (shareId || /^(blob|data):/i.test(raw)) {
      setResolvedPreviewUrl(immediatePreviewUrl);
      return;
    }
    const requestId = ++previewRequestRef.current;
    setResolvedPreviewUrl(null);
    const resolve = async () => {
      if (/^https?:\/\//i.test(raw)) {
        const signed = await resolveSignedStorageUrl(raw, { chatId });
        if (cacheKey && signed) previewCacheRef.current.set(cacheKey, signed);
        if (requestId === previewRequestRef.current) setResolvedPreviewUrl(signed);
        return;
      }
      const target = getArtifactsStorageTarget(raw);
      if (!target || !chatId) {
        if (requestId === previewRequestRef.current) setResolvedPreviewUrl(null);
        return;
      }
      try {
        const resp = await fetch("/api/storage/signed-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            bucket: target.bucket,
            storagePath: target.storagePath,
          }),
        });
        const data = (await resp.json().catch(() => null)) as { url?: string } | null;
        if (!resp.ok || !data?.url) {
          if (requestId === previewRequestRef.current) setResolvedPreviewUrl(null);
          return;
        }
        if (cacheKey) previewCacheRef.current.set(cacheKey, data.url);
        if (requestId === previewRequestRef.current) setResolvedPreviewUrl(data.url);
      } catch {
        if (requestId === previewRequestRef.current) setResolvedPreviewUrl(null);
      }
    };
    resolve();
  }, [chatId, immediatePreviewUrl, previewCandidate, shareId]);
  const showHeader = !isReadOnly;
  const showFallback = !baseState && resolvedData;
  const isEmpty = !state.sessionId && state.events.length === 0;
  const isSessionOver = status === "completed" || status === "stopped" || status === "failed";
  const snapshotLocked = isReadOnly && !isSessionOver;
  const canShowSnapshot = !snapshotLocked;
  const showSnapshot = Boolean(previewUrl && canShowSnapshot);
  const showRecordingSnapshot = Boolean(previewUrl && canShowSnapshot);
  const takeoverOverlayActive = takeoverEnabled && !isReadOnly;
  const takeoverInteractive = takeoverEnabled && !handoffOpen;
  const statusLabel = STATUS_LABELS[status] ?? status;
  const statusStyle = STATUS_STYLES[status] ?? STATUS_STYLES.idle;
  const sessionShort = sessionId ? `${sessionId.slice(0, 8)}...` : null;
  const previewPlaceholder = snapshotLocked
    ? {
        title: "Replay snapshot pending",
        subtitle: "Snapshot appears once the session ends.",
      }
    : hasSession
      ? {
          title: "No preview yet",
          subtitle: "Waiting for the next session update.",
        }
      : {
          title: "Desktop preview",
          subtitle: "Start a desktop session to see the preview.",
        };
  const recordingPlaceholder = snapshotLocked
    ? {
        title: "Replay snapshot pending",
        subtitle: "Recording previews appear after the session ends.",
      }
    : {
        title: "No snapshot yet",
        subtitle: "Frames will appear here once recording begins.",
      };

  useEffect(() => {
    if (!hasRecording) {
      setPlaybackIndex(0);
      setIsPlaying(false);
      return;
    }
    if (playbackIndex >= recordingFrames.length) {
      setPlaybackIndex(Math.max(0, recordingFrames.length - 1));
    }
  }, [hasRecording, playbackIndex, recordingFrames.length]);

  useEffect(() => {
    if (!isPlaying || recordingFrames.length === 0) return;
    const interval = window.setInterval(() => {
      setPlaybackIndex((prev) => (prev + 1) % recordingFrames.length);
    }, Math.max(250, recordingIntervalMs));
    return () => window.clearInterval(interval);
  }, [isPlaying, recordingFrames.length, recordingIntervalMs]);

  useEffect(() => {
    if (isReadOnly || !chatId || !sessionId) return;
    const latestEventSeq = Math.max(
      0,
      ...state.events.map((evt) => (typeof evt.seq === "number" ? evt.seq : 0))
    );
    const latestFrameSeq = Math.max(
      0,
      ...recordingFrames.map((frame) => (typeof frame.seq === "number" ? frame.seq : 0))
    );
    if (
      latestEventSeq <= persistRef.current.lastSeq &&
      latestFrameSeq <= persistRef.current.lastFrameSeq &&
      persistRef.current.lastStatus === status
    ) {
      return;
    }

    const persist = async () => {
      const now = Date.now();
      persistRef.current.lastSeq = latestEventSeq;
      persistRef.current.lastFrameSeq = latestFrameSeq;
      persistRef.current.lastStatus = status;
      persistRef.current.lastAt = now;
      const payload = {
        chatId,
        artifact: {
          id: "desktop",
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
  }, [chatId, isReadOnly, recordingFrames, sessionId, state, status]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-default bg-secondary p-4">
        {showHeader ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full font-medium ${statusStyle}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${status === "running" ? "bg-emerald-500" : "bg-zinc-400"}`}
                />
                {statusLabel}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {updatedAtLabel ? `Updated ${updatedAtLabel}` : "No updates yet"}
              </span>
              {sessionShort ? (
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Session {sessionShort}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setResolvedStreamUrl(null); setStreamRefreshKey(Date.now()); }}
                disabled={!sessionId || !chatId || !streamSrc}
                className="inline-flex items-center gap-1 rounded-full border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white disabled:opacity-40"
              >
                <RefreshCcw className="w-3 h-3" />
                Refresh
              </button>
            </div>
          </div>
        ) : null}

        {isEmpty ? (
          <div
            className={`${showHeader ? "mt-4 " : ""}rounded-xl border border-black/5 dark:border-white/10 min-h-[240px]`}
          >
            <DesktopEmptyState hasSession={hasSession} />
          </div>
        ) : (
          <div className={`${showHeader ? "mt-4 " : ""}space-y-4`}>
            <div className="relative rounded-xl border border-black/5 dark:border-white/10 overflow-hidden bg-black/5 dark:bg-white/5">
              {showStream ? (
                takeoverOverlayActive ? (
                  <div className="w-full aspect-video bg-black/10 dark:bg-white/5" aria-hidden />
                ) : (
                  <>
                    <iframe
                      ref={streamFrameRef}
                      title="Desktop stream"
                      src={streamSrc ?? undefined}
                      className={`block w-full aspect-video bg-black ${
                        takeoverInteractive ? "pointer-events-auto" : "pointer-events-none select-none"
                      }`}
                      tabIndex={takeoverInteractive ? 0 : -1}
                      allow="fullscreen"
                    />
                    {takeoverInteractive ? <div aria-hidden className={CONTROL_SHIELD_CLASS} /> : null}
                    {!isReadOnly ? (
                      <div className="absolute right-3 top-3 pointer-events-auto z-20">
                        <button
                          type="button"
                          onClick={handleTakeover}
                          className="group inline-flex items-center justify-center gap-0 hover:gap-2 h-9 w-9 hover:w-[128px] rounded-full border border-white/10 bg-black/40 text-white/90 backdrop-blur px-2.5 hover:px-3 shadow-sm hover:bg-black/60 transition-[width,background-color,padding,gap] duration-200 overflow-hidden"
                          aria-label="Take over"
                          title="Take over"
                        >
                          <MousePointer2 className="block w-4 h-4 shrink-0" />
                          <span className="max-w-0 opacity-0 group-hover:max-w-[90px] group-hover:opacity-100 transition-all duration-200 text-xs font-medium whitespace-nowrap overflow-hidden">
                            Take over
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </>
                )
              ) : (
                <div className="relative w-full aspect-video bg-white/70 dark:bg-white/5">
                  {showSnapshot ? (
                    <>
                      <img src={previewUrl ?? ""} alt="Desktop snapshot" className="w-full h-full object-cover" />
                    </>
                  ) : (
                    <DesktopPreviewPlaceholder
                      title={previewPlaceholder.title}
                      subtitle={previewPlaceholder.subtitle}
                    />
                  )}
                </div>
              )}
            </div>

            {takeoverOverlayActive ? (
              <div className="fixed inset-0 z-40 flex items-center justify-center bg-zinc-950/70 backdrop-blur-md px-6 py-8">
                <div className="relative w-full max-w-6xl">
                  <div className="relative aspect-video w-full rounded-2xl border border-white/10 bg-black shadow-2xl ring-1 ring-white/10 overflow-hidden">
                    {showStream ? (
                      <>
                        <iframe
                          ref={streamFrameRef}
                          title="Desktop stream"
                          src={streamSrc ?? undefined}
                          className={`block w-full h-full bg-black ${
                            takeoverInteractive ? "pointer-events-auto" : "pointer-events-none select-none"
                          }`}
                          tabIndex={takeoverInteractive ? 0 : -1}
                          allow="fullscreen"
                        />
                        {takeoverInteractive ? <div aria-hidden className={CONTROL_SHIELD_CLASS} /> : null}
                      </>
                    ) : (
                      <div className="relative w-full h-full bg-black/20">
                        {showSnapshot ? (
                          <img
                            src={previewUrl ?? ""}
                            alt="Desktop snapshot"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <DesktopPreviewPlaceholder
                            title={previewPlaceholder.title}
                            subtitle={previewPlaceholder.subtitle}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
                  <button
                    type="button"
                    onClick={() => setHandoffOpen(true)}
                    className={`inline-flex items-center rounded-full border border-white/10 bg-black/80 px-4 py-2 text-xs font-semibold text-white shadow-xl ring-1 ring-white/10 backdrop-blur transition-colors ${
                      handoffOpen ? "pointer-events-none opacity-0" : "hover:bg-black/90"
                    }`}
                    aria-label="Hand back"
                    aria-haspopup="dialog"
                    aria-expanded={handoffOpen}
                  >
                    Hand back
                  </button>
                </div>
                {handoffOpen ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
                    <div
                      role="dialog"
                      aria-modal="true"
                      className="w-full max-w-md rounded-2xl border border-black/10 dark:border-white/10 bg-white/95 dark:bg-zinc-950/95 p-5 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-zinc-900 dark:text-white">
                            Hand back to Tuna
                          </div>
                          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            Summarize what you changed so Tuna can continue smoothly.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setHandoffOpen(false)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-black/10 dark:border-white/10 text-zinc-400 transition-colors hover:bg-black/5 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-white"
                          aria-label="Close handoff"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <textarea
                        value={handoffNotes}
                        onChange={(event) => setHandoffNotes(event.target.value)}
                        rows={4}
                        autoFocus
                        placeholder="e.g., Logged in, accepted cookies, left the tab open."
                        className="mt-3 w-full rounded-xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400/40"
                      />
                      <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                        This note will be shared with your agent.
                      </div>
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setHandoffOpen(false)}
                          className="rounded-full border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-zinc-500 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleHandoff}
                          disabled={!handoffNotes.trim()}
                          className="rounded-full bg-black px-3 py-1 text-xs font-semibold text-white shadow-sm ring-1 ring-black/20 transition-colors hover:bg-zinc-900 disabled:opacity-60 dark:ring-white/10"
                        >
                          Hand back
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {recording?.videoUrl || hasRecording ? (
              <div className="rounded-xl border border-black/5 dark:border-white/10 p-3 space-y-3">
                <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                  <span>
                    Recording {recordingLabel}
                    {recording?.frameCount ? ` · ${recording.frameCount} frames` : ""}
                  </span>
                  {hasRecording ? (
                    <button
                      type="button"
                      onClick={() => setIsPlaying((prev) => !prev)}
                      className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
                    >
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      {isPlaying ? "Pause" : "Play"}
                    </button>
                  ) : null}
                </div>
                <div className="relative overflow-hidden rounded-lg border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5">
                  {showRecordingSnapshot ? (
                    <>
                      <img src={previewUrl ?? ""} alt="Recording frame" className="w-full h-auto object-cover" />
                      <div className="absolute inset-x-0 bottom-0 p-2 flex items-center justify-between text-[11px] text-white/80 bg-gradient-to-t from-black/60 via-black/20 to-transparent">
                        <span>
                          {typeof currentFrame?.seq === "number" ? `Frame #${currentFrame.seq}` : "Snapshot"}
                        </span>
                        {currentFrame?.at ? <span>{formatTime(currentFrame.at)}</span> : null}
                      </div>
                    </>
                  ) : (
                    <div className="min-h-[140px]">
                      <DesktopPreviewPlaceholder
                        title={recordingPlaceholder.title}
                        subtitle={recordingPlaceholder.subtitle}
                      />
                    </div>
                  )}
                </div>
                {recordingFrames.length > 1 ? (
                  <input
                    type="range"
                    min={0}
                    max={recordingFrames.length - 1}
                    value={Math.min(playbackIndex, recordingFrames.length - 1)}
                    onChange={(event) => {
                      setIsPlaying(false);
                      setPlaybackIndex(Number(event.target.value));
                    }}
                    className="w-full accent-emerald-500"
                  />
                ) : null}
              </div>
            ) : null}

          </div>
        )}
      </div>

      {showFallback ? (
        <div className="rounded-xl border border-black/5 dark:border-white/10">
          <GenericArtifactRenderer artifactId="desktop" dataOverride={resolvedData} />
        </div>
      ) : null}
    </div>
  );
}
