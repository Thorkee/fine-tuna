"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Terminal,
  X,
} from "lucide-react";

import { ArtifactScopeProvider } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { CANVAS_ARTIFACT_ID_SET, isDeliverableArtifactId, normalizeArtifactId } from "@/lib/agent/artifact-mapping";
import {
  defaultPanelForArtifact,
  isSandboxPanelId,
  panelToArtifactId,
  type CanvasPanelId,
} from "@/lib/agent/canvas-panels";
import type { CanvasTimelineEvent } from "@/lib/agent/types";
import { cn } from "@/lib/utils";
import { normalizeSandboxState } from "@/lib/sandbox/sandbox-state";
import { sortCanvasTimelineEvents } from "@/lib/agent/canvas-timeline";
import { fileNameFromUrl, looksLikeImageUrl, openUrlInNewTab, parseSupabaseStorageUrl } from "@/lib/client/storage-links";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";

import ChatCodeArtifact from "@/app/components/ui/ChatCodeArtifact";
import ChatArtifactCard from "@/app/components/ui/ChatArtifactCard";
import AgentStatusCard from "@/app/components/ui/AgentStatusCard";
import CanvasTimelineBar from "@/app/components/ui/CanvasTimelineBar";
import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import { extractClarificationPayload, type ClarificationPayload } from "@/app/components/ui/ClarificationCard";
import TakeoverCard, {
  extractTakeoverPayload,
  looksLikeTakeoverRequest,
  type TakeoverPayload,
} from "@/app/components/ui/TakeoverCard";

import PlanArtifact from "@/app/components/artifacts/PlanArtifact";
import DataAnalysisArtifact from "@/app/components/artifacts/DataAnalysisArtifact";
import IntentArtifact from "@/app/components/artifacts/IntentArtifact";
import ResearchArtifact, { CurationArtifact } from "@/app/components/artifacts/ResearchArtifact";
import ProviderComparisonArtifact from "@/app/components/artifacts/ProviderComparisonArtifact";
import TrainingArtifact from "@/app/components/artifacts/TrainingArtifact";
import DesktopArtifact from "@/app/components/artifacts/DesktopArtifact";
import ExportArtifact from "@/app/components/artifacts/ExportArtifact";
import PythonSandboxArtifact, {
  SandboxBrowserPanel,
  SandboxCodePanel,
  SandboxFilesPanel,
  SandboxStateProvider,
  SandboxTerminalPanel,
} from "@/app/components/artifacts/PythonSandboxArtifact";
import ClarificationArtifact from "@/app/components/artifacts/ClarificationArtifact";

const DocumentArtifact = dynamic(() => import("@/app/components/artifacts/DocumentArtifact"), {
  ssr: false,
});
const SpreadsheetArtifact = dynamic(() => import("@/app/components/artifacts/SpreadsheetArtifact"), {
  ssr: false,
});

type MarkdownCodeProps = React.HTMLAttributes<HTMLElement> & {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  node?: unknown;
};

const ARTIFACT_MESSAGE_PREFIX = "__TUNA_ARTIFACT__:";
const BUILTIN_CANVAS_IDS: ReadonlySet<string> = CANVAS_ARTIFACT_ID_SET;
const HIDDEN_ARTIFACT_IDS: ReadonlySet<string> = new Set([]);
const isResearchArtifactId = (id: string | null | undefined) =>
  typeof id === "string" && (id === "research" || id.startsWith("research-"));
const TRACE_PREVIEW_LIMIT = 140;
const REPLAY_SPEEDS = [0.75, 1, 1.5, 2] as const;
const hasSandboxActivity = (data: unknown) => {
  const state = normalizeSandboxState(data);
  if (!state) return false;
  return Boolean(
    state.sessionId ||
      state.events.length > 0 ||
      (state.files?.length ?? 0) > 0 ||
      (state.browser?.length ?? 0) > 0
  );
};

const PANEL_LABELS: Record<string, string> = {
  plan: "Plan",
  analysis: "Analysis",
  intent: "Intent",
  research: "Web Research",
  curation: "Data Curation",
  connectors: "Connectors",
  providers: "Providers",
  training: "Training",
  export: "Export",
  document: "Document",
  spreadsheet: "Spreadsheet",
  sandbox: "Sandbox",
  desktop: "Desktop",
  "sandbox-code": "Sandbox Code",
  "sandbox-terminal": "Sandbox Terminal",
  "sandbox-files": "Sandbox Files",
  "sandbox-browser": "Sandbox Browser",
};

function getPanelLabel(panelId: string) {
  if (panelId.startsWith("research-")) return "Web Research";
  if (panelId.startsWith("clarification-")) return "Clarification";
  return PANEL_LABELS[panelId] ?? panelId;
}

type AgentStatusEvent = { label: string; detail?: string; at: string };
type AgentStatus = { phase?: string; events: AgentStatusEvent[] };
type TraceSegment = {
  id: string;
  text: string;
  status: "streaming" | "closed";
  isOpen?: boolean;
};

type AttachedFile = {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
  storagePath?: string;
  uploadStatus?: "uploading" | "ready" | "error";
  error?: string;
};

type ReasoningSegment = {
  id: string;
  text: string;
  status: "streaming" | "closed";
  isOpen?: boolean;
};

type RenderBlock =
  | { kind: "reasoning"; id: string }
  | { kind: "trace"; id: string }
  | { kind: "status" }
  | { kind: "content" }
  | { kind: "files" };

type ShareSnapshot = {
  version: number;
  createdAt: string;
  chat: { id: string; title: string; created_at: string };
  messages: Array<{
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string;
    files?: unknown;
    status?: unknown;
    reasoning_summary?: string;
    reasoning_segments?: unknown;
    trace_segments?: unknown;
    render_order?: unknown;
    created_at: string;
  }>;
  state: {
    artifacts: Array<{ id: string; type: string; data: unknown; createdAt?: string; updatedAt?: string }>;
    canvasTimeline: CanvasTimelineEvent[];
  };
};

type ArtifactMessagePayload = { id: string; type?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseArtifactMessage(content: string): ArtifactMessagePayload | null {
  if (!content.startsWith(ARTIFACT_MESSAGE_PREFIX)) return null;
  const raw = content.slice(ARTIFACT_MESSAGE_PREFIX.length);
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v)) return null;
    if (typeof v.id !== "string" || !v.id.trim()) return null;
    const type = typeof v.type === "string" ? v.type : undefined;
    const normalizedId = normalizeArtifactId(v.id, type);
    return { id: normalizedId, type };
  } catch {
    return null;
  }
}

function toEpochMs(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function pickTimelineAt(rawAt: unknown, fallbacks: Array<string | undefined>): string {
  if (typeof rawAt === "string" && toEpochMs(rawAt) !== null) return rawAt;
  for (const candidate of fallbacks) {
    if (typeof candidate === "string" && toEpochMs(candidate) !== null) return candidate;
  }
  return new Date().toISOString();
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function normalizeTraceSegments(input: unknown): TraceSegment[] {
  if (!Array.isArray(input)) return [];
  const out: TraceSegment[] = [];
  input.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) return;
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : `trace-${idx}`;
    out.push({ id, text, status: "closed", isOpen: false });
  });
  return out;
}

function extractClarificationFromParts(args: {
  content: string;
  traceSegments?: TraceSegment[];
}): { payload: ClarificationPayload | null; stripped: string; source: "content" | "trace" | "none" } {
  const fromContent = extractClarificationPayload(args.content);
  if (fromContent.payload) {
    return { payload: fromContent.payload, stripped: fromContent.stripped, source: "content" };
  }

  const baseStripped = fromContent.stripped;
  const segments = Array.isArray(args.traceSegments) ? args.traceSegments : [];
  for (const segment of segments) {
    const fromTrace = extractClarificationPayload(segment.text);
    if (fromTrace.payload) {
      return { payload: fromTrace.payload, stripped: baseStripped, source: "trace" };
    }
  }

  return { payload: null, stripped: baseStripped, source: "none" };
}

function extractTakeoverFromParts(args: {
  content: string;
  traceSegments?: TraceSegment[];
}): { payload: TakeoverPayload | null; stripped: string; source: "content" | "trace" | "none" } {
  const fromContent = extractTakeoverPayload(args.content);
  if (fromContent.payload) {
    return { payload: fromContent.payload, stripped: fromContent.stripped, source: "content" };
  }

  const baseStripped = fromContent.stripped;
  const segments = Array.isArray(args.traceSegments) ? args.traceSegments : [];
  for (const segment of segments) {
    const fromTrace = extractTakeoverPayload(segment.text);
    if (fromTrace.payload) {
      return { payload: fromTrace.payload, stripped: baseStripped, source: "trace" };
    }
  }

  return { payload: null, stripped: baseStripped, source: "none" };
}

function normalizeFiles(input: unknown): AttachedFile[] {
  if (!Array.isArray(input)) return [];
  const out: AttachedFile[] = [];
  input.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) return;
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id : `file-${idx}`;
    const size = typeof obj.size === "number" ? obj.size : undefined;
    const mimeType = typeof obj.mimeType === "string" ? obj.mimeType : undefined;
    const storagePath = typeof obj.storagePath === "string" ? obj.storagePath : undefined;
    const uploadStatus =
      obj.uploadStatus === "uploading" || obj.uploadStatus === "ready" || obj.uploadStatus === "error"
        ? obj.uploadStatus
        : undefined;
    const error = typeof obj.error === "string" ? obj.error : undefined;
    out.push({ id, name, size, mimeType, storagePath, uploadStatus, error });
  });
  return out;
}

function getTraceCompactText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  if (singleLine.length <= TRACE_PREVIEW_LIMIT) return singleLine;
  return `${singleLine.slice(0, TRACE_PREVIEW_LIMIT - 3)}...`;
}

function normalizeHeadingParagraphs(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let inFence = false;

  const isFence = (line: string) => line.trim().startsWith("```");
  const inlineHeadingRe =
    /([.!?:])\s*((?:\*\*[^*\n]+?\*\*)|(?:__[^_\n]+?__))/g;
  const isHeaderLine = (trimmed: string) =>
    /^#{1,6}\s+/.test(trimmed) ||
    /^(?:\*\*|__)[^*_]+(?:\*\*|__)$/.test(trimmed);

  // First pass: ensure inline heading-style **...** / __...__ start on their own line.
  const expandedLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isFence(line)) {
      inFence = !inFence;
      expandedLines.push(line);
      continue;
    }

    if (!inFence) {
      const injected = line.replace(inlineHeadingRe, "$1\n\n$2");
      expandedLines.push(...injected.split("\n"));
      continue;
    }

    expandedLines.push(line);
  }

  // Second pass: add blank lines around header paragraphs for better markdown rendering.
  const out: string[] = [];
  inFence = false;
  for (let i = 0; i < expandedLines.length; i += 1) {
    const line = expandedLines[i];
    const trimmed = line.trim();
    if (isFence(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (!inFence) {
      const isHeader = isHeaderLine(trimmed);
      const prevIsBlank = out.length === 0 ? true : out[out.length - 1].trim() === "";
      if (isHeader && !prevIsBlank) {
        out.push("");
      }
      out.push(line);
      if (isHeader) {
        const nextTrimmed = (expandedLines[i + 1] ?? "").trim();
        if (nextTrimmed !== "") {
          out.push("");
        }
      }
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

function normalizeTraceText(text: string): string {
  return normalizeHeadingParagraphs(text);
}

function normalizeReasoningText(text: string): string {
  return normalizeHeadingParagraphs(text);
}

function normalizeReasoningSegments(
  input: unknown,
  fallbackText: string | undefined,
  messageId: string
): ReasoningSegment[] {
  if (Array.isArray(input)) {
    const out: ReasoningSegment[] = [];
    input.forEach((item, idx) => {
      if (!item || typeof item !== "object") return;
      const obj = item as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!text) return;
      const id =
        typeof obj.id === "string" && obj.id.trim()
          ? obj.id
          : `reasoning-${messageId}-${idx}`;
      out.push({ id, text, status: "closed", isOpen: false });
    });
    if (out.length > 0) return out;
  }
  const fallback = typeof fallbackText === "string" ? fallbackText.trim() : "";
  if (!fallback) return [];
  return [{ id: `reasoning-${messageId}`, text: fallback, status: "closed", isOpen: false }];
}

function getReasoningCompactText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  if (singleLine.length <= TRACE_PREVIEW_LIMIT) return singleLine;
  return `${singleLine.slice(0, TRACE_PREVIEW_LIMIT - 3)}...`;
}

function renderInlineBoldMarkdown(text: string): React.ReactNode {
  const value = typeof text === "string" ? text : "";
  if (!value) return null;

  const re = /(\*\*([^*\n]+?)\*\*|__([^_\n]+?)__)/g;
  let didMatch = false;
  let lastIndex = 0;
  const parts: React.ReactNode[] = [];

  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    didMatch = true;
    if (match.index > lastIndex) {
      parts.push(value.slice(lastIndex, match.index));
    }
    const content = match[2] ?? match[3] ?? "";
    parts.push(<strong key={`inline-bold-${match.index}`}>{content}</strong>);
    lastIndex = re.lastIndex;
  }

  if (!didMatch) return value;

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts;
}

function normalizeRenderOrder(input: unknown): RenderBlock[] {
  if (!Array.isArray(input)) return [];
  const reasoning: RenderBlock[] = [];
  const trace: RenderBlock[] = [];
  let hasStatus = false;
  let hasContent = false;
  let hasFiles = false;
  const seenReasoning = new Set<string>();
  const seenTrace = new Set<string>();

  input.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const kind = typeof obj.kind === "string" ? obj.kind : "";
    if (kind === "reasoning") {
      const id = typeof obj.id === "string" ? obj.id : "";
      const trimmed = id.trim();
      if (!trimmed || seenReasoning.has(trimmed)) return;
      seenReasoning.add(trimmed);
      reasoning.push({ kind: "reasoning", id: trimmed });
      return;
    }
    if (kind === "trace") {
      const id = typeof obj.id === "string" ? obj.id : "";
      const trimmed = id.trim();
      if (!trimmed || seenTrace.has(trimmed)) return;
      seenTrace.add(trimmed);
      trace.push({ kind: "trace", id: trimmed });
      return;
    }
    if (kind === "status") {
      hasStatus = true;
      return;
    }
    if (kind === "content") {
      hasContent = true;
      return;
    }
    if (kind === "files") {
      hasFiles = true;
      return;
    }
  });
  const out: RenderBlock[] = [];
  out.push(...reasoning);
  if (hasStatus) out.push({ kind: "status" } as RenderBlock);
  out.push(...trace);
  if (hasContent) out.push({ kind: "content" } as RenderBlock);
  if (hasFiles) out.push({ kind: "files" } as RenderBlock);
  return out;
}

function normalizeAgentStatus(input: unknown): AgentStatus | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const eventsRaw = obj.events;
  if (!Array.isArray(eventsRaw)) return null;
  const events: AgentStatusEvent[] = eventsRaw
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      const ev = e as Record<string, unknown>;
      return {
        label: typeof ev.label === "string" ? ev.label : "",
        detail: typeof ev.detail === "string" ? ev.detail : undefined,
        at: typeof ev.at === "string" ? ev.at : "",
      };
    })
    .filter((e) => e.label.trim() && e.at.trim());
  if (events.length === 0) return null;
  return {
    phase: typeof obj.phase === "string" ? obj.phase : undefined,
    events,
  };
}

function estimateDelayMs(role: "user" | "assistant", content: string) {
  const len = (content || "").trim().length;
  const base = role === "user" ? 550 : 700;
  const variable = len * (role === "user" ? 10 : 14);
  return clamp(base + variable, 650, 2600);
}

function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatMessageTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function SharedChatReplay(props: { shareId: string }) {
  const { shareId } = props;
  const shareScopeId = useMemo(() => `share:${shareId}`, [shareId]);
  const prefersReducedMotion = useReducedMotion();

  const [snapshot, setSnapshot] = useState<ShareSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  const [isDark, setIsDark] = useState(false);
  const isLgUp = useMediaQuery("(min-width: 1024px)");
  const [mobilePane, setMobilePane] = useState<"chat" | "canvas">("chat");

  const [replayPlayback, setReplayPlayback] = useState<"paused" | "playing">("paused");
  const [replayCursor, setReplayCursor] = useState(0); // number of messages visible
  const replayCursorRef = useRef(0);
  const [replaySpeed, setReplaySpeed] = useState<0.75 | 1 | 1.5 | 2>(1);
  const manualTimelineRef = useRef(false);
  const cycleReplaySpeed = useCallback(() => {
    const idx = REPLAY_SPEEDS.indexOf(replaySpeed);
    const next = REPLAY_SPEEDS[(idx + 1) % REPLAY_SPEEDS.length];
    setReplaySpeed(next);
  }, [replaySpeed]);

  const [canvasTimeline, setCanvasTimeline] = useState<CanvasTimelineEvent[]>([]);
  const canvasTimelineRef = useRef<CanvasTimelineEvent[]>([]);
  const [timelineCursor, setTimelineCursor] = useState(0);
  const [timelinePlayback, setTimelinePlayback] = useState<"paused" | "playing">("paused");

  const [canvasWidth, setCanvasWidth] = useState(60);
  const [isResizing, setIsResizing] = useState(false);
  const [isDesktopTakeoverActive, setIsDesktopTakeoverActive] = useState(false);
  const dragConstraintsRef = useRef<HTMLDivElement | null>(null);

  const startResizing = useCallback(() => {
    if (!isLgUp || isDesktopTakeoverActive) return;
    setIsResizing(true);
  }, [isDesktopTakeoverActive, isLgUp]);

  const stopResizing = useCallback(() => setIsResizing(false), []);

  const resize = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !dragConstraintsRef.current) return;
      const containerWidth = dragConstraintsRef.current.offsetWidth;
      if (!containerWidth) return;
      const leftOffset = dragConstraintsRef.current.getBoundingClientRect().left;
      const mouseXInContainer = e.clientX - leftOffset;
      const newCanvasWidth = ((containerWidth - mouseXInContainer) / containerWidth) * 100;
      if (newCanvasWidth >= 30 && newCanvasWidth <= 70) {
        setCanvasWidth(newCanvasWidth);
      }
    },
    [isResizing]
  );

  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const {
    clearArtifacts,
    addArtifact,
    setActiveArtifact,
    activeArtifact,
    artifacts,
  } = useProjectArtifacts(shareScopeId);
  const [openPanels, setOpenPanels] = useState<CanvasPanelId[]>([]);
  const openPanelsRef = useRef<CanvasPanelId[]>([]);
  const [focusedPanel, setFocusedPanel] = useState<CanvasPanelId | null>(null);
  const focusedPanelRef = useRef<CanvasPanelId | null>(null);

  useEffect(() => {
    openPanelsRef.current = openPanels;
  }, [openPanels]);

  useEffect(() => {
    focusedPanelRef.current = focusedPanel;
  }, [focusedPanel]);

  useEffect(() => {
    if (!focusedPanel && openPanels.length > 0) {
      setFocusedPanel(openPanels[openPanels.length - 1]);
    }
  }, [focusedPanel, openPanels]);

  useEffect(() => {
    if (!isResizing) return;
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  useEffect(() => {
    const onTakeover = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      const nextActive = Boolean(detail?.active);
      setIsDesktopTakeoverActive(nextActive);
      if (nextActive) setIsResizing(false);
    };
    window.addEventListener("tuna-desktop-takeover", onTakeover as EventListener);
    return () => {
      window.removeEventListener("tuna-desktop-takeover", onTakeover as EventListener);
    };
  }, []);

  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({});
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const [copiedLink, setCopiedLink] = useState(false);
  const snapshotChatId = snapshot?.chat?.id ?? "";

  const copyShareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = window.location.href;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  }, []);

  const retryLoad = useCallback(() => {
    setRetryKey((prev) => prev + 1);
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsPinnedToBottom(distanceFromBottom < 120);
  }, []);

  const jumpToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    window.setTimeout(() => setIsPinnedToBottom(true), 150);
  }, []);

  const revealCanvasOnMobile = useCallback(() => {
    if (!isLgUp) setMobilePane("canvas");
  }, [isLgUp]);

  const showChatOnMobile = useCallback(() => {
    if (!isLgUp) setMobilePane("chat");
  }, [isLgUp]);

  const renderTraceMarkdown = (content: string) => (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all text-[11px] leading-relaxed",
        isDark ? "prose-invert text-zinc-300" : "text-zinc-600"
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a(props) {
            const { node, href, className, children, ...rest } = props as React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };
            void node;
            const url = typeof href === "string" ? href : "";
            const isStorageLink = Boolean(url && parseSupabaseStorageUrl(url));
            const isImageLink = Boolean(url && looksLikeImageUrl(url));
            const shouldButton = Boolean(url && (isStorageLink || isImageLink));

            if (url && shouldButton) {
              return (
                <button
                  type="button"
                  onClick={() => void openUrlInNewTab(url, { chatId: snapshotChatId || undefined })}
                  className={cn(
                    "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                    isDark
                      ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                      : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                    className
                  )}
                  title={url}
                >
                  <span className="truncate">{fileNameFromUrl(url)}</span>
                  <span className="opacity-60 shrink-0">Open</span>
                </button>
              );
            }

            return (
              <a {...rest} href={url} target="_blank" rel="noopener noreferrer" className={className}>
                {children}
              </a>
            );
          },
          img(props) {
            const { node, src, alt, className } = props as React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };
            void node;
            const url = typeof src === "string" ? src : "";
            if (!url) return null;
            void alt;
            return (
              <button
                type="button"
                onClick={() => void openUrlInNewTab(url, { chatId: snapshotChatId || undefined })}
                className={cn(
                  "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                  isDark
                    ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                    : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                  className
                )}
                title={url}
              >
                <span className="truncate">{fileNameFromUrl(url)}</span>
                <span className="opacity-60 shrink-0">Open</span>
              </button>
            );
          },
          pre(props) {
            const { children } = props;
            const codeChild = React.Children.toArray(children).find((child) =>
              React.isValidElement(child)
            );
            if (React.isValidElement(codeChild)) {
              const codeProps = codeChild.props as {
                className?: string;
                children?: React.ReactNode;
              };
              const match = /language-(\w+)/.exec(codeProps.className || "");
              const rawCode =
                Array.isArray(codeProps.children)
                  ? codeProps.children.join("")
                  : String(codeProps.children ?? "");
              const codeString = rawCode.replace(/\n$/, "");
              if (match) {
                return (
                  <div className="not-prose">
                    <ChatCodeArtifact
                      language={match[1]}
                      code={codeString}
                      isDark={isDark}
                      onOpenSandboxPanel={() => {
                        openPanel("sandbox-code");
                        revealCanvasOnMobile();
                      }}
                    />
                  </div>
                );
              }
              return (
                <pre
                  className={cn(
                    "not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs",
                    isDark
                      ? "bg-white/5 border-white/10 text-zinc-200"
                      : "bg-zinc-100 border-zinc-200 text-zinc-800"
                  )}
                >
                  <code className={codeProps.className}>{codeString}</code>
                </pre>
              );
            }
            return (
              <pre
                className={cn(
                  "not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs",
                  isDark
                    ? "bg-white/5 border-white/10 text-zinc-200"
                    : "bg-zinc-100 border-zinc-200 text-zinc-800"
                )}
              >
                {children}
              </pre>
            );
          },
          code(props) {
            const p = props as unknown as MarkdownCodeProps;
            const inline = p.inline !== false;
            const { children, className, node: nodeProp, ...rest } = p;
            void nodeProp;
            return (
              <code
                className={
                  inline
                    ? `${className ?? ""} bg-zinc-100 dark:bg-white/10 px-1 py-0.5 rounded break-all`
                    : className ?? ""
                }
                {...rest}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {normalizeTraceText(content)}
      </ReactMarkdown>
    </div>
  );

  const renderReasoningMarkdown = (content: string) => (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all text-[12px] leading-relaxed",
        isDark ? "prose-invert text-zinc-300" : "text-zinc-700"
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a(props) {
            const { node, href, className, children, ...rest } = props as React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };
            void node;
            const url = typeof href === "string" ? href : "";
            const isStorageLink = Boolean(url && parseSupabaseStorageUrl(url));
            const isImageLink = Boolean(url && looksLikeImageUrl(url));
            const shouldButton = Boolean(url && (isStorageLink || isImageLink));

            if (url && shouldButton) {
              return (
                <button
                  type="button"
                  onClick={() => void openUrlInNewTab(url, { chatId: snapshotChatId || undefined })}
                  className={cn(
                    "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                    isDark
                      ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                      : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                    className
                  )}
                  title={url}
                >
                  <span className="truncate">{fileNameFromUrl(url)}</span>
                  <span className="opacity-60 shrink-0">Open</span>
                </button>
              );
            }

            return (
              <a {...rest} href={url} target="_blank" rel="noopener noreferrer" className={className}>
                {children}
              </a>
            );
          },
          img(props) {
            const { node, src, alt, className } = props as React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };
            void node;
            const url = typeof src === "string" ? src : "";
            if (!url) return null;
            void alt;
            return (
              <button
                type="button"
                onClick={() => void openUrlInNewTab(url, { chatId: snapshotChatId || undefined })}
                className={cn(
                  "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                  isDark
                    ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                    : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                  className
                )}
                title={url}
              >
                <span className="truncate">{fileNameFromUrl(url)}</span>
                <span className="opacity-60 shrink-0">Open</span>
              </button>
            );
          },
          pre(props) {
            const { children } = props;
            const codeChild = React.Children.toArray(children).find((child) =>
              React.isValidElement(child)
            );
            if (React.isValidElement(codeChild)) {
              const codeProps = codeChild.props as {
                className?: string;
                children?: React.ReactNode;
              };
              const match = /language-(\w+)/.exec(codeProps.className || "");
              const rawCode =
                Array.isArray(codeProps.children)
                  ? codeProps.children.join("")
                  : String(codeProps.children ?? "");
              const codeString = rawCode.replace(/\n$/, "");
              if (match) {
                return (
                  <div className="not-prose">
                    <ChatCodeArtifact
                      language={match[1]}
                      code={codeString}
                      isDark={isDark}
                      onOpenSandboxPanel={() => {
                        openPanel("sandbox-code");
                        revealCanvasOnMobile();
                      }}
                    />
                  </div>
                );
              }
              return (
                <pre
                  className={cn(
                    "not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs",
                    isDark
                      ? "bg-white/5 border-white/10 text-zinc-200"
                      : "bg-zinc-100 border-zinc-200 text-zinc-800"
                  )}
                >
                  <code className={codeProps.className}>{codeString}</code>
                </pre>
              );
            }
            return (
              <pre
                className={cn(
                  "not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs",
                  isDark
                    ? "bg-white/5 border-white/10 text-zinc-200"
                    : "bg-zinc-100 border-zinc-200 text-zinc-800"
                )}
              >
                {children}
              </pre>
            );
          },
          code(props) {
            const p = props as unknown as MarkdownCodeProps;
            const inline = p.inline !== false;
            const { children, className, node: nodeProp, ...rest } = p;
            void nodeProp;
            return (
              <code
                className={
                  inline
                    ? `${className ?? ""} bg-zinc-100 dark:bg-white/10 px-1 py-0.5 rounded break-all`
                    : className ?? ""
                }
                {...rest}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {normalizeReasoningText(content)}
      </ReactMarkdown>
    </div>
  );

  useEffect(() => {
    replayCursorRef.current = replayCursor;
  }, [replayCursor]);

  const pauseReplayForTimeline = useCallback(() => {
    manualTimelineRef.current = true;
    setReplayPlayback("paused");
  }, [setReplayPlayback]);

  useEffect(() => {
    if (replayPlayback === "playing") {
      manualTimelineRef.current = false;
    }
  }, [replayPlayback]);

  useEffect(() => {
    canvasTimelineRef.current = canvasTimeline;
  }, [canvasTimeline]);

  // Track theme from document (Tailwind dark variant uses [data-theme=dark]).
  useEffect(() => {
    const update = () => {
      setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
    };
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Load snapshot
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      setError(null);
      setSnapshot(null);

      try {
        if (!shareId.trim()) throw new Error("Missing share id");
        const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`, {
          method: "GET",
          credentials: "same-origin",
          signal: controller.signal,
        });

        const rawText = await res.text().catch(() => "");
        const parsed: unknown = (() => {
          try {
            return rawText ? (JSON.parse(rawText) as unknown) : null;
          } catch {
            return null;
          }
        })();

        if (!res.ok) {
          const serverMsg =
            isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : rawText.trim();
          const fallback =
            res.status === 404
              ? "Share not found"
              : res.status === 410
                ? "This share has expired or was revoked"
                : res.status === 403
                  ? "This share is not public"
                  : `Failed to load (${res.status})`;
          throw new Error(serverMsg || fallback);
        }

        if (cancelled) return;
        setSnapshot((parsed ?? null) as ShareSnapshot);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === "AbortError") {
          setError("Request timed out. Please try again.");
          return;
        }
        setError(e instanceof Error ? e.message : "Failed to load share");
      } finally {
        window.clearTimeout(timeout);
        if (cancelled) return;
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [shareId, retryKey]);

  // Hydrate artifacts + timeline from snapshot
  useEffect(() => {
    if (!snapshot) return;
    clearArtifacts();
    const snapshotArtifacts = Array.isArray(snapshot.state?.artifacts) ? snapshot.state.artifacts : [];
    const artifactDataById = new Map<string, unknown>();
    for (const a of snapshotArtifacts) {
      if (!a || typeof a !== "object") continue;
      if (typeof a.id !== "string" || !a.id.trim()) continue;
      addArtifact({ id: a.id, type: String(a.type ?? "markdown"), data: a.data });
      const normalizedId = normalizeArtifactId(a.id, typeof a.type === "string" ? a.type : undefined);
      if (normalizedId.trim()) {
        artifactDataById.set(normalizedId, (a as { data?: unknown }).data);
      }
    }
    const baseTimelineRaw: unknown[] = Array.isArray(snapshot.state?.canvasTimeline)
      ? (snapshot.state.canvasTimeline as unknown[])
      : [];
    const artifactCreatedAtById = new Map<string, string>();
    const artifactUpdatedAtById = new Map<string, string>();
    for (const a of snapshotArtifacts) {
      if (!a || typeof a !== "object") continue;
      const rawId = typeof (a as { id?: unknown }).id === "string" ? (a as { id: string }).id : "";
      if (!rawId.trim()) continue;
      const type = typeof (a as { type?: unknown }).type === "string" ? (a as { type: string }).type : undefined;
      const normalizedId = normalizeArtifactId(rawId, type);
      const createdAt = typeof (a as { createdAt?: unknown }).createdAt === "string"
        ? (a as { createdAt: string }).createdAt
        : undefined;
      const updatedAt = typeof (a as { updatedAt?: unknown }).updatedAt === "string"
        ? (a as { updatedAt: string }).updatedAt
        : undefined;
      if (normalizedId.trim() && createdAt && toEpochMs(createdAt) !== null) {
        artifactCreatedAtById.set(normalizedId, createdAt);
      }
      if (normalizedId.trim() && updatedAt && toEpochMs(updatedAt) !== null) {
        artifactUpdatedAtById.set(normalizedId, updatedAt);
      }
    }

    const artifactMessageAtById = new Map<string, string>();
    const clarificationArtifacts: Array<{ id: string; data: unknown; at: string }> = [];
    const rawMessages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    for (const message of rawMessages) {
      if (!message || typeof message !== "object") continue;
      if ((message as { role?: unknown }).role !== "assistant") continue;
      const content = typeof (message as { content?: unknown }).content === "string" ? (message as { content: string }).content : "";
      const artifactPayload = parseArtifactMessage(content);
      if (artifactPayload) {
        if (!artifactMessageAtById.has(artifactPayload.id)) {
          const inferredAt = pickTimelineAt((message as { created_at?: unknown }).created_at, [
            typeof snapshot.chat?.created_at === "string" ? snapshot.chat.created_at : undefined,
            snapshot.createdAt,
          ]);
          artifactMessageAtById.set(artifactPayload.id, inferredAt);
        }
        continue;
      }
      const traceSegments = normalizeTraceSegments(
        (message as { trace_segments?: unknown }).trace_segments
      );
      const { payload: clarificationPayload } = extractClarificationFromParts({
        content,
        traceSegments,
      });
      if (!clarificationPayload) continue;
      const messageId = typeof (message as { id?: unknown }).id === "string" ? (message as { id: string }).id : "";
      if (!messageId) continue;
      const at = pickTimelineAt((message as { created_at?: unknown }).created_at, [
        typeof snapshot.chat?.created_at === "string" ? snapshot.chat.created_at : undefined,
        snapshot.createdAt,
      ]);
      clarificationArtifacts.push({
        id: `clarification-${messageId}`,
        data: clarificationPayload,
        at,
      });
    }
    for (const c of clarificationArtifacts) {
      addArtifact({ id: c.id, type: "clarification", data: c.data });
    }

    const baseTimeline: CanvasTimelineEvent[] = [];
    baseTimelineRaw.forEach((item, idx) => {
      if (!isRecord(item)) return;
      const obj = item;
      const artifactIdRaw = typeof obj.artifactId === "string" ? obj.artifactId : "";
      if (!artifactIdRaw.trim()) return;
      const artifactType = typeof obj.artifactType === "string" ? obj.artifactType : "markdown";
      const normalizedId = normalizeArtifactId(artifactIdRaw, artifactType);
      if (!normalizedId.trim()) return;
      const rawData = (obj as { data?: unknown }).data;
      const data = rawData ?? artifactDataById.get(normalizedId);
      if (normalizedId === "sandbox") {
        if (!hasSandboxActivity(data)) return;
      }
      const at = pickTimelineAt(obj.at, [
        artifactMessageAtById.get(normalizedId),
        artifactCreatedAtById.get(normalizedId),
        artifactUpdatedAtById.get(normalizedId),
        typeof snapshot.chat?.created_at === "string" ? snapshot.chat.created_at : undefined,
        snapshot.createdAt,
      ]);
      baseTimeline.push({
        seq: typeof obj.seq === "number" && Number.isFinite(obj.seq) ? Math.floor(obj.seq) : idx,
        at,
        kind: obj.kind === "open" || obj.kind === "upsert" ? obj.kind : "upsert",
        artifactId: normalizedId,
        artifactType,
        data,
      });
    });

    const timelineWithClarifications: CanvasTimelineEvent[] = [
      ...baseTimeline,
      ...clarificationArtifacts.map((c, idx) => ({
        seq: baseTimeline.length + idx,
        at: c.at,
        kind: "upsert" as const,
        artifactId: c.id,
        artifactType: "clarification",
        data: c.data,
      })),
    ];

    const sorted = sortCanvasTimelineEvents(timelineWithClarifications);

    setCanvasTimeline(sorted);
    setOpenPanels([]);
    setFocusedPanel(null);

    // Start the canvas at the first available frame (if any).
    if (sorted.length > 0) {
      const first = sorted[0];
      if (first?.artifactId) setActiveArtifact(first.artifactId);
      setTimelineCursor(0);
    } else if (snapshotArtifacts.length > 0) {
      const fallback = snapshotArtifacts.find((a) => {
        if (!a || typeof a !== "object") return false;
        const rawId = typeof (a as { id?: unknown }).id === "string" ? (a as { id: string }).id : "";
        if (!rawId.trim()) return false;
        const type = typeof (a as { type?: unknown }).type === "string" ? (a as { type: string }).type : undefined;
        const normalizedId = normalizeArtifactId(rawId, type);
        if (!normalizedId.trim()) return false;
        if (normalizedId === "sandbox") {
          return hasSandboxActivity(artifactDataById.get(normalizedId));
        }
        return true;
      });
      if (fallback && typeof (fallback as { id?: unknown }).id === "string") {
        setActiveArtifact((fallback as { id: string }).id);
        setTimelineCursor(0);
      } else {
        setActiveArtifact(null);
        setTimelineCursor(0);
      }
    }

    // Start replay automatically.
    setReplayCursor(0);
    setReplayPlayback(prefersReducedMotion ? "paused" : "playing");
    setTimelinePlayback("paused");
    setTraceOpen({});
  }, [addArtifact, clearArtifacts, prefersReducedMotion, setActiveArtifact, snapshot]);

  const orderedMessagesWithMs = useMemo(() => {
    const rawMessages = Array.isArray(snapshot?.messages) ? snapshot!.messages : [];
    if (!snapshot) {
      return rawMessages.map((message, idx) => {
        const baseMs = typeof message.created_at === "string" ? toEpochMs(message.created_at) : null;
        return { message, idx, effectiveMs: baseMs ?? Number.POSITIVE_INFINITY };
      });
    }

    // Repair ordering for legacy artifact-messages with late `created_at` by using the persisted
    // canvas timeline timestamps. We only move artifact messages earlier (never later) so we don't
    // disturb chats that already have correct ordering.
    const rawTimeline: unknown[] = Array.isArray(snapshot.state?.canvasTimeline)
      ? (snapshot.state.canvasTimeline as unknown[])
      : [];
    const upsertTimelineAtsByArtifactId = new Map<string, string[]>();
    rawTimeline.forEach((item) => {
      if (!isRecord(item)) return;
      const kind = item.kind === "upsert" || item.kind === "open" ? item.kind : null;
      if (kind !== "upsert") return;
      const artifactIdRaw = typeof item.artifactId === "string" ? item.artifactId : "";
      if (!artifactIdRaw.trim()) return;
      const artifactType = typeof item.artifactType === "string" ? item.artifactType : "markdown";
      const normalizedId = normalizeArtifactId(artifactIdRaw, artifactType);
      if (!normalizedId.trim()) return;
      const at = typeof item.at === "string" ? item.at : "";
      if (!at.trim() || toEpochMs(at) === null) return;
      const list = upsertTimelineAtsByArtifactId.get(normalizedId) ?? [];
      list.push(at);
      upsertTimelineAtsByArtifactId.set(normalizedId, list);
    });
    for (const [artifactId, ats] of upsertTimelineAtsByArtifactId.entries()) {
      if (ats.length <= 1) continue;
      ats.sort((a, b) => {
        const ta = toEpochMs(a) ?? Number.POSITIVE_INFINITY;
        const tb = toEpochMs(b) ?? Number.POSITIVE_INFINITY;
        return ta - tb;
      });
      upsertTimelineAtsByArtifactId.set(artifactId, ats);
    }

    const artifactMsgCursorById = new Map<string, number>();
    return rawMessages
      .map((message, idx) => {
        const baseMs = typeof message.created_at === "string" ? toEpochMs(message.created_at) : null;
        let effectiveMs = baseMs ?? Number.POSITIVE_INFINITY;
        const payload = message.role === "assistant" ? parseArtifactMessage(message.content) : null;
        if (payload) {
          const ats = upsertTimelineAtsByArtifactId.get(payload.id);
          if (ats && ats.length > 0) {
            const cursor = artifactMsgCursorById.get(payload.id) ?? 0;
            artifactMsgCursorById.set(payload.id, cursor + 1);
            const assignedAt = ats[Math.min(cursor, ats.length - 1)];
            const assignedMs = toEpochMs(assignedAt);
            if (assignedMs !== null) {
              if (baseMs === null || assignedMs < baseMs) {
                effectiveMs = assignedMs;
              }
            }
          }
        }
        return { message, idx, effectiveMs };
      })
      .sort((a, b) => {
        if (a.effectiveMs !== b.effectiveMs) return a.effectiveMs - b.effectiveMs;
        return a.idx - b.idx;
      });
  }, [snapshot]);
  const messages = useMemo(() => orderedMessagesWithMs.map((entry) => entry.message), [orderedMessagesWithMs]);
  const messageEffectiveMsByIdx = useMemo(
    () => orderedMessagesWithMs.map((entry) => entry.effectiveMs),
    [orderedMessagesWithMs]
  );
  const totalMessages = messages.length;

  const visibleMessages = useMemo(() => messages.slice(0, clamp(replayCursor, 0, totalMessages)), [messages, replayCursor, totalMessages]);

  const timelineIndexByMessage = useMemo(() => {
    const timelineTimes = canvasTimeline.map((e) => (typeof e?.at === "string" ? toEpochMs(e.at) : null));
    return messageEffectiveMsByIdx.map((t) => {
      if (!Number.isFinite(t) || timelineTimes.length === 0) return -1;
      let idx = -1;
      for (let i = 0; i < timelineTimes.length; i++) {
        const tt = timelineTimes[i];
        if (tt === null) continue;
        if (tt <= t) idx = i;
        else break;
      }
      return idx;
    });
  }, [canvasTimeline, messageEffectiveMsByIdx]);

  const setCursorAndOpenFrame = useCallback(
    (idx: number) => {
      const t = canvasTimelineRef.current;
      if (t.length === 0) return;
      const clamped = Math.min(Math.max(idx, 0), t.length - 1);
      const frame = t[clamped];
      if (!frame?.artifactId) return;
      setTimelineCursor(clamped);
      setActiveArtifact(frame.artifactId);
    },
    [setActiveArtifact]
  );

  const toggleTimelinePlay = useCallback(() => {
    pauseReplayForTimeline();
    setTimelinePlayback((prev) => (prev === "playing" ? "paused" : "playing"));
  }, [pauseReplayForTimeline]);

  const isLive = canvasTimeline.length === 0 || timelineCursor >= canvasTimeline.length - 1;

  const jumpToLive = useCallback(() => {
    pauseReplayForTimeline();
    const t = canvasTimelineRef.current;
    if (t.length === 0) return;
    setTimelinePlayback("paused");
    const idx = t.length - 1;
    setCursorAndOpenFrame(idx);
  }, [pauseReplayForTimeline, setCursorAndOpenFrame]);

  const openCanvasOnMobile = useCallback(() => {
    revealCanvasOnMobile();
    if (openPanelsRef.current.length === 0 && canvasTimelineRef.current.length > 0) {
      jumpToLive();
    }
  }, [jumpToLive, revealCanvasOnMobile]);

  const selectedFrame = canvasTimeline.length > 0
    ? canvasTimeline[Math.min(timelineCursor, canvasTimeline.length - 1)]
    : null;
  const dataOverrideByArtifact = useMemo(() => {
    if (isLive || !selectedFrame?.artifactId) return new Map<string, unknown>();
    return new Map([[selectedFrame.artifactId, selectedFrame.data]]);
  }, [isLive, selectedFrame]);

  // When the sandbox panel is open during replay, we want it to follow the timeline cursor
  // without falling back to "live" polling (which can cause the panel to flip to idle between
  // non-sandbox frames).
  const snapshotSandboxData = useMemo(() => {
    const a = artifacts.find((x) => x.id === "sandbox");
    return a?.data as unknown;
  }, [artifacts]);
  const sandboxPlaybackOverride = useMemo(() => {
    if (canvasTimeline.length === 0) return snapshotSandboxData;
    const cursor = clamp(timelineCursor, 0, canvasTimeline.length - 1);
    for (let i = cursor; i >= 0; i -= 1) {
      const frame = canvasTimeline[i];
      if (frame?.artifactId === "sandbox") return frame.data;
    }
    return snapshotSandboxData;
  }, [canvasTimeline, snapshotSandboxData, timelineCursor]);

  // Canvas timeline playback (independent)
  useEffect(() => {
    if (timelinePlayback !== "playing") return;
    const t = canvasTimelineRef.current;
    if (t.length <= 1) {
      setTimelinePlayback("paused");
      return;
    }
    const timer = window.setInterval(() => {
      const timeline = canvasTimelineRef.current;
      const lastIdx = timeline.length - 1;
      setTimelineCursor((prev) => {
        const next = Math.min(prev + 1, lastIdx);
        if (next >= lastIdx) window.setTimeout(() => setTimelinePlayback("paused"), 0);
        return next;
      });
    }, 450);
    return () => window.clearInterval(timer);
  }, [timelinePlayback]);

  // Message replay timer
  useEffect(() => {
    if (replayPlayback !== "playing") return;
    if (totalMessages === 0) return;
    if (replayCursor >= totalMessages) {
      setReplayPlayback("paused");
      return;
    }
    const nextMsg = messages[replayCursor];
    const delay = Math.max(120, Math.round(estimateDelayMs(nextMsg.role, nextMsg.content) / replaySpeed));
    const timer = window.setTimeout(() => {
      setReplayCursor((prev) => Math.min(prev + 1, totalMessages));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [messages, replayCursor, replayPlayback, replaySpeed, totalMessages]);

  // Sync canvas cursor to the most recently revealed message
  useEffect(() => {
    if (replayCursor <= 0) return;
    if (manualTimelineRef.current) return;
    const msgIdx = replayCursor - 1;
    const msg = messages[msgIdx];
    if (msg && msg.role === "assistant" && typeof msg.content === "string") {
      const traceSegments = normalizeTraceSegments((msg as { trace_segments?: unknown }).trace_segments);
      const { payload: clarificationPayload } = extractClarificationFromParts({
        content: msg.content,
        traceSegments,
      });
      if (clarificationPayload) {
        const artifactId = `clarification-${msg.id}`;
        setTimelinePlayback("paused");
        const idx = findLatestFrameIndexForArtifact(artifactId);
        if (idx !== null) {
          setCursorAndOpenFrame(idx);
        } else {
          setActiveArtifact(artifactId);
        }
        return;
      }
    }

    const desired = timelineIndexByMessage[msgIdx] ?? -1;
    if (desired < 0) return;
    setTimelinePlayback("paused");
    setCursorAndOpenFrame(desired);
  }, [replayCursor, setCursorAndOpenFrame, timelineIndexByMessage]);

  // Auto-scroll while replaying
  useEffect(() => {
    if (replayPlayback !== "playing") return;
    if (!isPinnedToBottom) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [isPinnedToBottom, replayCursor, replayPlayback]);

  const toggleReplay = useCallback(() => {
    setReplayPlayback((prev) => (prev === "playing" ? "paused" : "playing"));
  }, []);

  const restartReplay = useCallback(() => {
    setReplayPlayback("paused");
    setReplayCursor(0);
    window.setTimeout(() => setReplayPlayback("playing"), 0);
    if (canvasTimelineRef.current.length > 0) {
      setTimelinePlayback("paused");
      setCursorAndOpenFrame(0);
    }
  }, [setCursorAndOpenFrame]);

  const skipReplay = useCallback(() => {
    setReplayPlayback("paused");
    setReplayCursor(totalMessages);
    const t = canvasTimelineRef.current;
    if (t.length > 0) {
      setTimelinePlayback("paused");
      setCursorAndOpenFrame(t.length - 1);
    }
    window.setTimeout(() => jumpToBottom(), 0);
  }, [jumpToBottom, setCursorAndOpenFrame, totalMessages]);

  const findLatestFrameIndexForArtifact = useCallback(
    (artifactId: string) => {
      const t = canvasTimelineRef.current;
      for (let i = t.length - 1; i >= 0; i--) {
        if (t[i]?.artifactId === artifactId) return i;
      }
      return null;
    },
    []
  );

  const openPanel = useCallback(
    (panelId: CanvasPanelId, opts?: { focus?: boolean }) => {
      setOpenPanels((prev) => (prev.length === 1 && prev[0] === panelId ? prev : [panelId]));
      if (opts?.focus === false) return;
      setFocusedPanel(panelId);
      const artifactId = panelToArtifactId(panelId);
      if (artifactId) setActiveArtifact(artifactId);
    },
    [setActiveArtifact]
  );

  const focusPanel = useCallback(
    (panelId: CanvasPanelId, opts?: { jumpToLatest?: boolean }) => {
      setFocusedPanel(panelId);
      const artifactId = panelToArtifactId(panelId);
      if (artifactId) {
        setActiveArtifact(artifactId);
        if (opts?.jumpToLatest !== false) {
          const idx = findLatestFrameIndexForArtifact(artifactId);
          if (idx !== null) setTimelineCursor(idx);
        }
      }
    },
    [findLatestFrameIndexForArtifact, setActiveArtifact]
  );

  const closePanel = useCallback(
    (panelId: CanvasPanelId) => {
      setOpenPanels((prev) => prev.filter((id) => id !== panelId));
      if (focusedPanelRef.current === panelId) {
        const remaining = openPanelsRef.current.filter((id) => id !== panelId);
        const nextFocused = remaining[remaining.length - 1] ?? null;
        setFocusedPanel(nextFocused);
        const nextArtifact = nextFocused ? panelToArtifactId(nextFocused) : null;
        setActiveArtifact(nextArtifact);
      }
    },
    [setActiveArtifact]
  );

  const togglePanel = useCallback(
    (panelId: CanvasPanelId) => {
      if (openPanelsRef.current.includes(panelId)) {
        closePanel(panelId);
        return;
      }
      openPanel(panelId, { focus: false });
      focusPanel(panelId);
    },
    [closePanel, focusPanel, openPanel]
  );

  const openPanelForArtifact = useCallback(
    (artifactId: string, opts?: { jumpToLatest?: boolean }) => {
      const panelId = defaultPanelForArtifact(artifactId);
      if (!panelId) return;
      openPanel(panelId, { focus: false });
      focusPanel(panelId, opts);
    },
    [focusPanel, openPanel]
  );

  const stepTimeline = useCallback(
    (delta: number) => {
      const t = canvasTimelineRef.current;
      if (t.length === 0) return;
      pauseReplayForTimeline();
      setTimelinePlayback("paused");
      const next = Math.min(Math.max(timelineCursor + delta, 0), t.length - 1);
      setCursorAndOpenFrame(next);
    },
    [pauseReplayForTimeline, setCursorAndOpenFrame, timelineCursor]
  );

  useEffect(() => {
    if (!activeArtifact) return;
    const panelId = defaultPanelForArtifact(activeArtifact);
    if (!panelId) return;
    if (openPanelsRef.current.includes(panelId) && focusedPanelRef.current === panelId) return;
    openPanelForArtifact(activeArtifact, { jumpToLatest: false });
  }, [activeArtifact, openPanelForArtifact]);

  const renderPanelShell = useCallback(
    (panelId: CanvasPanelId, content: React.ReactNode) => {
      const isFocused = focusedPanel === panelId;
      const artifactId = panelToArtifactId(panelId);
      const isDeliverable = isDeliverableArtifactId(artifactId);
      return (
        <div
          key={panelId}
          className={`glass-card overflow-hidden ${isFocused ? "ring-1 ring-emerald-500/30" : ""}`}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-black/5 dark:border-white/10">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => focusPanel(panelId)}
                className="min-w-0 text-xs font-medium text-zinc-700 dark:text-zinc-200 truncate"
              >
                {getPanelLabel(panelId)}
              </button>
              {isDeliverable ? (
                <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300">
                  Deliverable
                </span>
              ) : null}
            </div>
            {panelId !== "desktop" ? (
              <button
                type="button"
                onClick={() => closePanel(panelId)}
                className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
          <div className="p-3">{content}</div>
        </div>
      );
    },
    [closePanel, focusPanel, focusedPanel]
  );

  const renderPanelContent = useCallback(
    (panelId: CanvasPanelId) => {
      const artifactId = panelToArtifactId(panelId);
      const dataOverride = dataOverrideByArtifact.get(artifactId);
      if (isSandboxPanelId(panelId) || panelId === "sandbox") {
        const sandboxOverride = sandboxPlaybackOverride ?? null;
        return (
          <SandboxStateProvider dataOverride={sandboxOverride}>
            {panelId === "sandbox-code" && <SandboxCodePanel />}
            {panelId === "sandbox-terminal" && <SandboxTerminalPanel />}
            {panelId === "sandbox-files" && <SandboxFilesPanel />}
            {panelId === "sandbox-browser" && <SandboxBrowserPanel />}
            {panelId === "sandbox" && <SandboxTerminalPanel />}
          </SandboxStateProvider>
        );
      }
      if (panelId === "plan") return <PlanArtifact dataOverride={dataOverride} />;
      if (panelId === "analysis") return <DataAnalysisArtifact dataOverride={dataOverride} />;
      if (panelId === "intent") return <IntentArtifact dataOverride={dataOverride} />;
      if (isResearchArtifactId(panelId)) {
        return <ResearchArtifact artifactId={panelId} dataOverride={dataOverride} />;
      }
      if (panelId === "curation") return <CurationArtifact dataOverride={dataOverride} />;
      if (panelId === "providers") return <ProviderComparisonArtifact dataOverride={dataOverride} />;
      if (panelId === "training") return <TrainingArtifact dataOverride={dataOverride} />;
      if (panelId === "desktop") return <DesktopArtifact dataOverride={dataOverride} shareId={shareId} />;
      if (panelId === "document") return <DocumentArtifact dataOverride={dataOverride} />;
      if (panelId === "spreadsheet") return <SpreadsheetArtifact dataOverride={dataOverride} />;
      if (panelId === "export") return <ExportArtifact dataOverride={dataOverride} />;
      if (panelId?.startsWith("clarification-")) {
        return <ClarificationArtifact artifactId={panelId} onSend={() => {}} disabled />;
      }
      if (panelId && !BUILTIN_CANVAS_IDS.has(panelId) && !panelId.startsWith("clarification-")) {
        return (
          <GenericArtifactRenderer
            artifactId={panelId}
            isDark={isDark}
            dataOverride={dataOverride}
          />
        );
      }
      return null;
    },
    [dataOverrideByArtifact, isDark, sandboxPlaybackOverride]
  );

  const activePanel = useMemo(
    () => focusedPanel ?? openPanels[openPanels.length - 1] ?? null,
    [focusedPanel, openPanels]
  );
  const headerTitle = (snapshot?.chat?.title || "").trim() || "Shared chat";
  const hasAnyArtifacts = canvasTimeline.length > 0 || openPanels.length > 0;
  const showMobileToggle = !isLgUp && hasAnyArtifacts;
  const shouldShowChat = isLgUp || mobilePane === "chat";
  const shouldShowCanvas = isLgUp || mobilePane === "canvas";
  const shouldAnimateCanvasWidth = !prefersReducedMotion && !isResizing;
  const replayProgress = totalMessages > 0 ? clamp(replayCursor / totalMessages, 0, 1) : 0;
  const isReplayComplete = replayCursor >= totalMessages;
  const snapshotCreatedAt = snapshot?.createdAt ?? "";

  useEffect(() => {
    if (!hasAnyArtifacts) {
      showChatOnMobile();
      return;
    }
    if (openPanels.length === 0 && mobilePane === "canvas") {
      showChatOnMobile();
    }
  }, [hasAnyArtifacts, mobilePane, openPanels.length, showChatOnMobile]);

  return (
    <ArtifactScopeProvider scopeId={shareScopeId} chatId={snapshotChatId || null}>
      <div className="h-dvh overflow-hidden flex flex-col bg-primary text-primary">
      {/* ── Brand header ── */}
      <header className="shrink-0 border-b border-default backdrop-blur bg-[hsl(var(--bg-elevated)/0.85)]">
        {/* Progress bar */}
        {!isLoading && !error && totalMessages > 0 && (
          <div className="h-[2px] w-full bg-transparent">
            <motion.div
              className="h-full bg-emerald-500/70 rounded-r-full"
              initial={{ width: 0 }}
              animate={{ width: `${replayProgress * 100}%` }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          </div>
        )}

        <div className="px-4 sm:px-6 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
          <div className="flex items-center justify-between gap-4">
            {/* Left: Brand + title */}
            <div className="flex items-center gap-3 min-w-0">
              <Link
                href="/"
                className="shrink-0 flex items-center gap-2 transition-opacity hover:opacity-80"
                title="tuna"
              >
                <Image
                  src="/tuna.png"
                  alt="tuna"
                  width={56}
                  height={32}
                  className="object-contain"
                  priority
                />
              </Link>
              <div className="min-w-0">
                <div className="text-[15px] sm:text-[16px] font-semibold tracking-tight truncate">{headerTitle}</div>
                {snapshotCreatedAt ? (
                  <div className={cn("flex items-center gap-1.5 text-[11px]", isDark ? "text-white/40" : "text-zinc-400")}>
                    <Clock className="w-3 h-3" />
                    <span>Shared {formatRelativeTime(snapshotCreatedAt)}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Right: Replay controls + actions */}
            <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2 shrink-0">
              {/* Replay controls */}
              <div className={cn(
                "flex items-center gap-1 rounded-full border px-1 py-1",
                isDark ? "border-white/10 bg-white/5" : "border-black/8 bg-white shadow-sm"
              )}>
                <button
                  type="button"
                  onClick={restartReplay}
                  disabled={isLoading || Boolean(error) || totalMessages === 0}
                  className={cn(
                    "p-1.5 rounded-full transition-colors",
                    isDark ? "hover:bg-white/10" : "hover:bg-zinc-100",
                    isLoading || Boolean(error) || totalMessages === 0 ? "opacity-40 cursor-not-allowed" : ""
                  )}
                  aria-label="Restart replay"
                  title="Restart"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={toggleReplay}
                  disabled={isLoading || Boolean(error) || totalMessages === 0}
                  className={cn(
                    "p-1.5 rounded-full transition-colors",
                    replayPlayback === "playing"
                      ? isDark ? "bg-white/15 text-emerald-300" : "bg-emerald-50 text-emerald-600"
                      : isDark ? "hover:bg-white/10" : "hover:bg-zinc-100",
                    isLoading || Boolean(error) || totalMessages === 0 ? "opacity-40 cursor-not-allowed" : ""
                  )}
                  aria-label={replayPlayback === "playing" ? "Pause replay" : "Play replay"}
                  title={replayPlayback === "playing" ? "Pause" : "Play"}
                >
                  {replayPlayback === "playing" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={skipReplay}
                  disabled={isLoading || Boolean(error) || totalMessages === 0 || isReplayComplete}
                  className={cn(
                    "p-1.5 rounded-full transition-colors",
                    isDark ? "hover:bg-white/10" : "hover:bg-zinc-100",
                    isLoading || Boolean(error) || totalMessages === 0 || isReplayComplete ? "opacity-40 cursor-not-allowed" : ""
                  )}
                  aria-label="Show all messages"
                  title="Show all"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                </button>
                <div className={cn(
                  "px-2 text-[11px] tabular-nums font-medium",
                  isDark ? "text-white/40" : "text-zinc-400"
                )}>
                  {clamp(replayCursor, 0, totalMessages)}/{totalMessages}
                </div>
              </div>

              {/* Speed (mobile cycle) */}
              <button
                type="button"
                onClick={cycleReplaySpeed}
                className={cn(
                  "sm:hidden inline-flex items-center gap-1 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                  isDark ? "border-white/10 bg-white/5 text-white/60 hover:bg-white/10" : "border-black/8 bg-white text-zinc-600 hover:bg-zinc-50"
                )}
                title={`Replay speed ${replaySpeed}x`}
                aria-label={`Replay speed ${replaySpeed}x`}
              >
                {replaySpeed}x
              </button>

              {/* Speed */}
              <div className={cn(
                "hidden sm:flex items-center gap-1 rounded-full border px-1 py-1",
                isDark ? "border-white/10 bg-white/5" : "border-black/8 bg-white shadow-sm"
              )}>
                {REPLAY_SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setReplaySpeed(s)}
                    className={cn(
                      "px-2 py-1 rounded-full text-[11px] tabular-nums font-medium transition-colors",
                      replaySpeed === s
                        ? isDark
                          ? "bg-white/15 text-emerald-300"
                          : "bg-emerald-50 text-emerald-700"
                        : isDark
                          ? "text-white/50 hover:bg-white/10"
                          : "text-zinc-500 hover:bg-zinc-100"
                    )}
                    title={`Replay speed ${s}x`}
                    aria-label={`Set replay speed to ${s}x`}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className={cn("hidden sm:block w-px h-5 mx-0.5", isDark ? "bg-white/10" : "bg-zinc-200")} />

              {/* Copy link */}
              <button
                type="button"
                onClick={copyShareLink}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[12px] font-medium transition-all",
                  copiedLink
                    ? isDark ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" : "border-emerald-500/30 bg-emerald-50 text-emerald-600"
                    : isDark ? "border-white/10 bg-white/5 hover:bg-white/10 text-zinc-300" : "border-black/8 bg-white hover:bg-zinc-50 text-zinc-600 shadow-sm"
                )}
                title={copiedLink ? "Copied!" : "Copy share link"}
              >
                {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{copiedLink ? "Copied" : "Copy link"}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 px-4 sm:px-6 py-4 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <div className={cn(
                  "w-20 h-12 rounded-2xl flex items-center justify-center",
                  isDark ? "bg-white/5" : "bg-zinc-100"
                )}>
                  <Image
                    src="/tuna.png"
                    alt=""
                    width={44}
                    height={24}
                    className="object-contain opacity-70"
                  />
                </div>
                <span className={cn(
                  "absolute -bottom-1 -right-1 inline-flex h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent",
                  isDark ? "text-emerald-400" : "text-emerald-500"
                )} />
              </div>
              <div className="text-center">
                <div className={cn("text-sm font-medium", isDark ? "text-white/70" : "text-zinc-600")}>
                  Loading shared chat…
                </div>
                <div className={cn("text-xs mt-1", isDark ? "text-white/30" : "text-zinc-400")}>
                  Preparing the conversation replay
                </div>
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center">
            <div
              className={cn(
                "max-w-md w-full rounded-2xl border p-6 text-center",
                isDark ? "border-white/10 bg-white/5 text-white" : "border-black/8 bg-white text-zinc-900 shadow-lg"
              )}
            >
              <div className={cn(
                "mx-auto mb-4 w-12 h-12 rounded-2xl flex items-center justify-center",
                isDark ? "bg-red-500/10" : "bg-red-50"
              )}>
                <X className={cn("w-6 h-6", isDark ? "text-red-400" : "text-red-500")} />
              </div>
              <div className="text-base font-semibold">Unable to load shared chat</div>
              <div className={cn("mt-2 text-sm", isDark ? "text-white/60" : "text-zinc-500")}>{error}</div>
              <button
                type="button"
                onClick={retryLoad}
                className={cn(
                  "mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium transition-colors",
                  isDark ? "border-white/10 bg-white/5 hover:bg-white/10" : "border-black/8 bg-zinc-50 hover:bg-zinc-100"
                )}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 flex flex-col">
            {showMobileToggle ? (
              <div className="mb-3 flex items-center justify-center">
                <div className={cn(
                  "inline-flex rounded-full border p-1 text-xs font-medium",
                  isDark ? "border-white/10 bg-white/5" : "border-black/10 bg-white"
                )}>
                  <button
                    type="button"
                    onClick={showChatOnMobile}
                    className={cn(
                      "px-4 py-1.5 rounded-full transition-colors",
                      mobilePane === "chat"
                        ? isDark
                          ? "bg-white/15 text-white"
                          : "bg-zinc-100 text-zinc-900"
                        : isDark
                          ? "text-white/60 hover:bg-white/10"
                          : "text-zinc-500 hover:bg-zinc-50"
                    )}
                    aria-pressed={mobilePane === "chat"}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={openCanvasOnMobile}
                    className={cn(
                      "px-4 py-1.5 rounded-full transition-colors",
                      mobilePane === "canvas"
                        ? isDark
                          ? "bg-white/15 text-white"
                          : "bg-zinc-100 text-zinc-900"
                        : isDark
                          ? "text-white/60 hover:bg-white/10"
                          : "text-zinc-500 hover:bg-zinc-50"
                    )}
                    aria-pressed={mobilePane === "canvas"}
                  >
                    Canvas
                  </button>
                </div>
              </div>
            ) : null}

            <div
              ref={dragConstraintsRef}
              className={cn(
                "min-h-0 flex-1 flex flex-col gap-4 lg:flex-row lg:gap-0",
              )}
              style={{ "--canvas-width": `${canvasWidth}%` } as React.CSSProperties}
            >
              {/* Chat column */}
              {shouldShowChat ? (
                <div className={cn(
                  "min-h-0 rounded-[24px] border border-default overflow-hidden flex flex-col bg-secondary relative",
                  hasAnyArtifacts ? "flex-1" : "flex-1 max-w-3xl mx-auto w-full"
                )}>
              <div
                ref={messagesScrollRef}
                onScroll={handleMessagesScroll}
                className={cn("flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-0", "scrollbar-hide")}
              >
                <AnimatePresence initial={false}>
                  {visibleMessages.map((message, idx) => {
                    const artifactPayload =
                      message.role === "assistant" ? parseArtifactMessage(message.content) : null;
                    const isArtifactMessage = Boolean(artifactPayload);
                    const isHiddenArtifact = artifactPayload ? HIDDEN_ARTIFACT_IDS.has(artifactPayload.id) : false;
                    if (isHiddenArtifact) return null;

                    const status = message.role === "assistant" ? normalizeAgentStatus(message.status) : null;
                    const traceSegments =
                      message.role === "assistant"
                        ? normalizeTraceSegments(message.trace_segments)
                        : [];
                    const hasTraceSegments = traceSegments.length > 0;
                    const reasoningSegments =
                      message.role === "assistant"
                        ? normalizeReasoningSegments(
                            message.reasoning_segments,
                            message.reasoning_summary,
                            message.id
                          ).map((seg) => ({
                            ...seg,
                            isOpen: Boolean(reasoningOpen[`${message.id}:${seg.id}`]),
                          }))
                        : [];
                    const hasReasoningSegments = reasoningSegments.length > 0;
                    const shouldShowReasoningSummary =
                      message.role === "assistant" && hasReasoningSegments;
                    const reasoningText =
                      typeof message.reasoning_summary === "string"
                        ? message.reasoning_summary.trim()
                        : "";
                    const renderOrder = normalizeRenderOrder(message.render_order);

                    const { payload: clarificationPayload, stripped: clarificationStrippedContent } =
                      message.role === "assistant" && !isArtifactMessage
                        ? extractClarificationFromParts({ content: message.content, traceSegments })
                        : { payload: null, stripped: message.content };
                    const { payload: takeoverPayload, stripped: strippedContent } =
                      message.role === "assistant" && !isArtifactMessage
                        ? extractTakeoverFromParts({
                            content: clarificationStrippedContent,
                            traceSegments,
                          })
                        : { payload: null, stripped: clarificationStrippedContent };
                    const displayContent =
                      message.role === "user" ? strippedContent.trimEnd() : strippedContent;
                    const hasDisplayContent = Boolean(displayContent && displayContent.trim());
                    const hasStatus = Boolean(status?.events?.length);
                    const clarificationArtifactId = clarificationPayload ? `clarification-${message.id}` : null;
                    const files = normalizeFiles(message.files);
                    const hasFiles = files.length > 0;
                    const showTakeoverInline =
                      message.role === "assistant" &&
                      !isArtifactMessage &&
                      (Boolean(takeoverPayload) ||
                        looksLikeTakeoverRequest(message.content) ||
                        traceSegments.some((segment) => looksLikeTakeoverRequest(segment.text)));
                    const hasContentBlock =
                      hasDisplayContent || Boolean(clarificationArtifactId) || showTakeoverInline;
                    const isUtilityAssistant =
                      message.role === "assistant" &&
                      !isArtifactMessage &&
                      !hasContentBlock &&
                      (hasStatus || shouldShowReasoningSummary || hasTraceSegments);
                    const nextMessage = visibleMessages[idx + 1];
                    const nextMessageIsUser = nextMessage?.role === "user";
                    const rowSpacingClass =
                      message.role === "user"
                        ? "mb-4"
                        : isArtifactMessage
                          ? nextMessageIsUser
                            ? "mb-4"
                            : "mb-0.5"
                          : isUtilityAssistant
                            ? "mb-1"
                            : "mb-2";
                    const fallbackRenderOrder: RenderBlock[] = [
                      ...reasoningSegments.map(
                        (segment): RenderBlock => ({
                          kind: "reasoning",
                          id: segment.id,
                        })
                      ),
                      ...(hasStatus ? [{ kind: "status" } as RenderBlock] : []),
                      ...traceSegments.map(
                        (segment): RenderBlock => ({
                          kind: "trace",
                          id: segment.id,
                        })
                      ),
                      ...(hasContentBlock ? [{ kind: "content" } as RenderBlock] : []),
                      ...(hasFiles ? [{ kind: "files" } as RenderBlock] : []),
                    ];
                    const resolvedRenderOrder = (() => {
                      const base = renderOrder.length > 0 ? renderOrder : fallbackRenderOrder;
                      if (!hasContentBlock) return base;
                      if (base.some((block) => block.kind === "content")) return base;
                      const next = [...base];
                      const filesIdx = next.findIndex((block) => block.kind === "files");
                      const insertAt = filesIdx === -1 ? next.length : filesIdx;
                      next.splice(insertAt, 0, { kind: "content" } as RenderBlock);
                      return next;
                    })();

                    const isEmptyUser = message.role === "user" && !hasDisplayContent && !hasFiles;
                    const isEmptyAssistantShell =
                      message.role === "assistant" &&
                      !isArtifactMessage &&
                      !shouldShowReasoningSummary &&
                      !hasStatus &&
                      !hasContentBlock &&
                      !hasTraceSegments &&
                      !clarificationPayload;
                    if (isEmptyUser || isEmptyAssistantShell) return null;

                    const isCurrent = idx === visibleMessages.length - 1;
                    const messageTime = formatMessageTime(message.created_at);
                    const baseBubble =
                      message.role === "user"
                        ? "max-w-[85%] rounded-[24px] px-5 pt-4 pb-3.5 text-[15px] leading-relaxed bg-tertiary text-primary"
                        : isArtifactMessage
                          ? "w-full max-w-[85%] bg-transparent px-0 py-0"
                          : `max-w-[85%] ${
                              isUtilityAssistant ? "w-full " : ""
                            }rounded-[24px] px-5 py-3.5 text-[15px] leading-relaxed bg-transparent pl-0 ${
                              isDark ? "text-zinc-200" : "text-zinc-800"
                            }`;

                    const isFocused = replayPlayback === "playing" && isCurrent;
                    const focusClass = isFocused
                      ? cn(
                          "rounded-md",
                          isDark ? "ring-1 ring-white/15" : "ring-1 ring-black/10"
                        )
                      : "";

                    return (
                      <motion.div
                        key={message.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        className={cn(
                          "flex flex-col last:mb-0",
                          message.role === "user" ? "items-end" : "items-start",
                          rowSpacingClass
                        )}
                      >
                        <div className={cn(baseBubble, focusClass)}>
                          {isArtifactMessage && artifactPayload ? (
                            <ChatArtifactCard
                              artifactId={artifactPayload.id}
                              onSelect={(artifactId) => {
                                revealCanvasOnMobile();
                                const idx = findLatestFrameIndexForArtifact(artifactId);
                                setTimelinePlayback("paused");
                                if (idx !== null) {
                                  setCursorAndOpenFrame(idx);
                                } else {
                                  openPanelForArtifact(artifactId, { jumpToLatest: false });
                                }
                              }}
                            />
                          ) : (
                            <div
                              className={cn(
                                "prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all",
                                isDark ? "prose-invert" : "",
                                message.role === "user" ? "prose-p:my-0 prose-ul:my-0 prose-ol:my-0" : ""
                              )}
                            >
                              {resolvedRenderOrder.map((block) => {
                                if (block.kind === "reasoning") {
                                  const segment = reasoningSegments.find((s) => s.id === block.id);
                                  if (!segment) return null;
                                  const reasoningKey = `${message.id}:${segment.id}`;
                                  const isOpen = Boolean(reasoningOpen[reasoningKey]);
                                  const compactText = getReasoningCompactText(segment.text);
                                  const previewText = compactText || reasoningText || "Reasoning details";
                                  const segmentText = segment.text.trim()
                                    ? segment.text
                                    : reasoningText;
                                  return (
                                    <div key={`reasoning-${segment.id}`} className="not-prose mt-0.5 space-y-0.5">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setReasoningOpen((prev) => ({
                                            ...prev,
                                            [reasoningKey]: !isOpen,
                                          }))
                                        }
                                        aria-expanded={isOpen}
                                        className={cn(
                                          "flex w-full min-w-0 items-center gap-2 py-1 text-[10px]",
                                          "text-zinc-500"
                                        )}
                                      >
                                        <span className="shrink-0 uppercase tracking-[0.2em]">
                                          Reasoning
                                        </span>
                                        {!isOpen ? (
                                          <span
                                            className={cn(
                                              "min-w-0 flex-1 truncate text-[11px] normal-case",
                                              isDark ? "text-zinc-300" : "text-zinc-600"
                                            )}
                                          >
                                            {renderInlineBoldMarkdown(previewText)}
                                          </span>
                                        ) : (
                                          <span className="flex-1" />
                                        )}
                                      </button>
                                      {isOpen ? (
                                        <div className="pl-3">
                                          {renderReasoningMarkdown(segmentText)}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                }

                                if (block.kind === "status") {
                                  return message.role === "assistant" && hasStatus && status ? (
                                    <div key="status" className="not-prose">
                                      <AgentStatusCard status={status} isDark={isDark} />
                                    </div>
                                  ) : null;
                                }

                                if (block.kind === "content") {
                                  if (!hasContentBlock) return null;
                                  return (
                                    <div key="content">
                                      {showTakeoverInline ? (
                                        <div className="not-prose mb-3">
                                          <TakeoverCard payload={takeoverPayload} />
                                        </div>
                                      ) : null}
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                          a(props) {
                                            const { node, href, className, children, ...rest } = props as React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };
                                            void node;
                                            const url = typeof href === "string" ? href : "";
                                            const isStorageLink = Boolean(url && parseSupabaseStorageUrl(url));
                                            const isImageLink = Boolean(url && looksLikeImageUrl(url));
                                            const shouldButton = Boolean(url && (isStorageLink || isImageLink));

                                            if (url && shouldButton) {
                                              return (
                                                <button
                                                  type="button"
                                                  onClick={() => void openUrlInNewTab(url, { chatId: snapshotChatId || undefined })}
                                                  className={cn(
                                                    "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                                                    isDark
                                                      ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                                                      : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                                                    className
                                                  )}
                                                  title={url}
                                                >
                                                  <span className="truncate">{fileNameFromUrl(url)}</span>
                                                  <span className="opacity-60 shrink-0">Open</span>
                                                </button>
                                              );
                                            }

                                            return (
                                              <a {...rest} href={url} target="_blank" rel="noopener noreferrer" className={className}>
                                                {children}
                                              </a>
                                            );
                                          },
                                          img(props) {
                                            const { node, src, alt, className } = props as React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };
                                            void node;
                                            const url = typeof src === "string" ? src : "";
                                            if (!url) return null;
                                            void alt;
                                            return (
                                              <button
                                                type="button"
                                                onClick={() => void openUrlInNewTab(url, { chatId: snapshotChatId || undefined })}
                                                className={cn(
                                                  "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                                                  isDark
                                                    ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                                                    : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                                                  className
                                                )}
                                                title={url}
                                              >
                                                <span className="truncate">{fileNameFromUrl(url)}</span>
                                                <span className="opacity-60 shrink-0">Open</span>
                                              </button>
                                            );
                                          },
                                          pre(props) {
                                            const { children } = props;
                                            const codeChild = React.Children.toArray(children).find((child) =>
                                              React.isValidElement(child)
                                            );

                                            if (React.isValidElement(codeChild)) {
                                              const codeProps = codeChild.props as {
                                                className?: string;
                                                children?: React.ReactNode;
                                              };
                                              const match = /language-(\w+)/.exec(codeProps.className || "");
                                              const rawCode =
                                                Array.isArray(codeProps.children)
                                                  ? codeProps.children.join("")
                                                  : String(codeProps.children ?? "");
                                              const codeString = rawCode.replace(/\n$/, "");

                                              if (match) {
                                                return (
                                                  <div className="not-prose">
                                                    <ChatCodeArtifact
                                                      language={match[1]}
                                                      code={codeString}
                                                      isDark={isDark}
                                                      onOpenSandboxPanel={() => {
                                                        openPanel("sandbox-code");
                                                        revealCanvasOnMobile();
                                                      }}
                                                    />
                                                  </div>
                                                );
                                              }

                                              return (
                                                <pre
                                                  className={cn(
                                                    "not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs",
                                                    isDark
                                                      ? "bg-white/5 border-white/10 text-zinc-200"
                                                      : "bg-zinc-100 border-zinc-200 text-zinc-800"
                                                  )}
                                                >
                                                  <code className={codeProps.className}>{codeString}</code>
                                                </pre>
                                              );
                                            }

                                            return (
                                              <pre
                                                className={cn(
                                                  "not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs",
                                                  isDark
                                                    ? "bg-white/5 border-white/10 text-zinc-200"
                                                    : "bg-zinc-100 border-zinc-200 text-zinc-800"
                                                )}
                                              >
                                                {children}
                                              </pre>
                                            );
                                          },
                                          code(props) {
                                            const p = props as unknown as MarkdownCodeProps;
                                            const inline = p.inline !== false;
                                            const { children, className, node: nodeProp, ...rest } = p;
                                            void nodeProp;
                                            return (
                                              <code
                                                className={
                                                  inline
                                                    ? `${className ?? ""} bg-zinc-100 dark:bg-white/10 px-1 py-0.5 rounded break-all`
                                                    : className ?? ""
                                                }
                                                {...rest}
                                              >
                                                {children}
                                              </code>
                                            );
                                          },
                                        }}
                                      >
                                        {displayContent}
                                      </ReactMarkdown>

                                      {message.role === "assistant" && clarificationArtifactId ? (
                                        <div className="not-prose mt-4">
                                          <ChatArtifactCard
                                            artifactId={clarificationArtifactId}
                                            titleOverride={clarificationPayload?.title || "Clarification"}
                                            onSelect={(artifactId) => {
                                              revealCanvasOnMobile();
                                              const idx = findLatestFrameIndexForArtifact(artifactId);
                                              setTimelinePlayback("paused");
                                              if (idx !== null) {
                                                setCursorAndOpenFrame(idx);
                                              } else {
                                                openPanelForArtifact(artifactId, { jumpToLatest: false });
                                              }
                                            }}
                                          />
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                }

                                if (block.kind === "trace") {
                                  const segment = traceSegments.find((s) => s.id === block.id);
                                  if (!segment) return null;
                                  const extractedTrace = extractClarificationPayload(segment.text);
                                  const clarStripped =
                                    extractedTrace.payload || extractedTrace.stripped !== segment.text
                                      ? extractedTrace.stripped
                                      : segment.text;
                                  const extractedTakeover = extractTakeoverPayload(clarStripped);
                                  const traceText =
                                    extractedTakeover.payload || extractedTakeover.stripped !== clarStripped
                                      ? extractedTakeover.stripped
                                      : clarStripped;
                                  if (!traceText.trim()) return null;
                                  const traceKey = `${message.id}:${segment.id}`;
                                  const isOpen = Boolean(traceOpen[traceKey]);
                                  const compactText = getTraceCompactText(traceText);
                                  const previewText = compactText || "Trace details";
                                  return (
                                    <div key={`trace-${segment.id}`} className="not-prose mt-0.5 space-y-0.5">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setTraceOpen((prev) => ({
                                            ...prev,
                                            [traceKey]: !isOpen,
                                          }))
                                        }
                                        aria-expanded={isOpen}
                                        className={cn(
                                          "flex w-full min-w-0 items-center gap-2 py-1 text-[10px]",
                                          "text-zinc-500"
                                        )}
                                      >
                                        <span className="shrink-0 uppercase tracking-[0.2em]">
                                          Trace
                                        </span>
                                        {!isOpen ? (
                                          <span
                                            className={cn(
                                              "min-w-0 flex-1 truncate text-[11px] normal-case",
                                              isDark ? "text-zinc-300" : "text-zinc-600"
                                            )}
                                          >
                                            {renderInlineBoldMarkdown(previewText)}
                                          </span>
                                        ) : (
                                          <span className="flex-1" />
                                        )}
                                      </button>
                                      {isOpen ? (
                                        <div className="pl-3">
                                          {renderTraceMarkdown(traceText)}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                }

                                if (block.kind === "files") {
                                  return hasFiles ? (
                                    <div key="files" className="not-prose mt-3 flex flex-wrap gap-2">
                                      {files.map((file) => {
                                        const isError = file.uploadStatus === "error";
                                        const baseClass =
                                          "inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border shadow-sm";
                                        const toneClass = isError
                                          ? "bg-red-50 text-red-600 border-red-200 dark:bg-red-500/10 dark:text-red-200 dark:border-red-500/30"
                                          : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/5";
                                        return (
                                          <span key={file.id} className={`${baseClass} ${toneClass}`}>
                                            <FileText className="w-3.5 h-3.5 opacity-50" />
                                            <span className="truncate max-w-[160px]">{file.name}</span>
                                            {isError ? <span className="text-[10px]">Upload failed</span> : null}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  ) : null;
                                }

                                return null;
                              })}
                            </div>
                          )}
                        </div>
                        {/* Timestamp */}
                        {messageTime && !isArtifactMessage && !isUtilityAssistant && (
                          <div className={cn(
                            "mt-1 px-2 text-[10px] tabular-nums",
                            isDark ? "text-white/25" : "text-zinc-300"
                          )}>
                            {messageTime}
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>

                {replayPlayback === "playing" && replayCursor < totalMessages ? (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] px-5 py-3.5">
                      <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                        <span>Replaying…</span>
                        <div className="flex space-x-1">
                          <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.32s]" />
                          <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.16s]" />
                          <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div ref={messagesEndRef} />
              </div>

              {!isPinnedToBottom && visibleMessages.length > 0 ? (
                <div className="pointer-events-none absolute bottom-4 right-4 z-10">
                  <button
                    type="button"
                    onClick={jumpToBottom}
                    className={cn(
                      "pointer-events-auto inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium shadow-lg transition-colors",
                      isDark
                        ? "border-white/10 bg-white/10 text-white/80 hover:bg-white/15"
                        : "border-black/8 bg-white text-zinc-700 hover:bg-zinc-50"
                    )}
                    title="Jump to latest"
                    aria-label="Jump to latest message"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                    Jump to latest
                  </button>
                </div>
              ) : null}
                </div>
              ) : null}

              {hasAnyArtifacts && shouldShowChat && shouldShowCanvas && !isDesktopTakeoverActive ? (
                <div
                  className="hidden lg:flex relative w-2.5 min-h-0 cursor-col-resize items-center justify-center transition-colors z-10 group shrink-0"
                  onMouseDown={startResizing}
                >
                  <div className="h-20 w-1.5 rounded-full bg-zinc-200/70 dark:bg-white/10 group-hover:bg-zinc-300/80 dark:group-hover:bg-white/20 transition-colors" />
                </div>
              ) : null}

              {/* Canvas – only shown when artifacts exist */}
              {hasAnyArtifacts && shouldShowCanvas ? (
                <div
                  className={cn(
                    "flex-1 min-h-0 rounded-[24px] overflow-hidden flex flex-col glass-panel macos-frame w-full lg:flex-none lg:w-[var(--canvas-width)]",
                    shouldAnimateCanvasWidth ? "lg:transition-[width] lg:duration-500 lg:ease-out" : "",
                    isDark ? "glass-panel-strong" : ""
                  )}
                >
              <div className="h-14 flex items-center px-5 shrink-0 gap-3 relative glass-header macos-titlebar">
                <div className="flex gap-2 mr-1 relative z-10">
                  <div className="w-3 h-3 rounded-full bg-red-400/90 ring-1 ring-black/10 dark:ring-white/10" />
                  <div className="w-3 h-3 rounded-full bg-amber-400/90 ring-1 ring-black/10 dark:ring-white/10" />
                  <div className="w-3 h-3 rounded-full bg-green-400/90 ring-1 ring-black/10 dark:ring-white/10" />
                </div>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className={cn("text-[13px] font-semibold tracking-tight", isDark ? "text-white/90" : "text-zinc-800")}>
                    Canvas Replay
                  </div>
                </div>
                <div className="flex-1" />
              </div>

          <div className="flex-1 min-h-0 overflow-y-auto bg-primary/70 p-2 sm:p-3">
            {openPanels.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 py-10">
                <Terminal className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm font-medium">No panels open.</p>
                <p className="text-xs mt-1">Open a panel from an artifact.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {activePanel
                  ? renderPanelShell(activePanel, renderPanelContent(activePanel))
                  : null}
              </div>
            )}
          </div>

              <div className="border-t border-black/5 dark:border-white/10 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
                <CanvasTimelineBar
                  maxIndex={Math.max(canvasTimeline.length - 1, 0)}
                  value={Math.min(
                    timelineCursor,
                    Math.max(canvasTimeline.length - 1, 0)
                  )}
                  isLive={isLive}
                  playback={timelinePlayback}
                  isDark={isDark}
                  onScrubPreview={(idx) => {
                    pauseReplayForTimeline();
                    setTimelinePlayback("paused");
                    setCursorAndOpenFrame(idx);
                  }}
                  onScrubCommit={(idx) => {
                    pauseReplayForTimeline();
                    setTimelinePlayback("paused");
                    setCursorAndOpenFrame(idx);
                  }}
                  onStep={(delta) => stepTimeline(delta)}
                  onTogglePlay={toggleTimelinePlay}
                  onJumpToLive={jumpToLive}
                />
              </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* CTA footer for visitors */}
      {!isLoading && !error && (
        <footer className={cn(
          "shrink-0 border-t border-default px-4 sm:px-6 py-2.5",
          "backdrop-blur bg-[hsl(var(--bg-elevated)/0.85)]"
        )}>
          <div className="flex items-center justify-between gap-4">
            <div className={cn("text-[12px]", isDark ? "text-white/40" : "text-zinc-400")}>
              Built with{" "}
              <Link href="/" className="font-medium text-emerald-600 dark:text-emerald-400 hover:underline">
                tuna
              </Link>
            </div>
            <Link
              href="/"
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors",
                isDark
                  ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/20"
                  : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200/60"
              )}
            >
              Try Tuna
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </footer>
      )}
      </div>
    </ArtifactScopeProvider>
  );
}

