"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";

import {
  Plus,
  ArrowUp,
  FileText,
  FolderOpen,
  Share2,
  X,
  Menu,
  Monitor,
  ChevronDown,
  Check,
} from "lucide-react";
import { ArtifactScopeProvider } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { DEFAULT_SANDBOX_CODE, useProjectStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import DataAnalysisArtifact from "@/app/components/artifacts/DataAnalysisArtifact";
import IntentArtifact from "@/app/components/artifacts/IntentArtifact";
import ResearchArtifact, { CurationArtifact } from "@/app/components/artifacts/ResearchArtifact";
import ProviderComparisonArtifact from "@/app/components/artifacts/ProviderComparisonArtifact";
import TrainingArtifact from "@/app/components/artifacts/TrainingArtifact";
import ExportArtifact from "@/app/components/artifacts/ExportArtifact";
import DesktopArtifact from "@/app/components/artifacts/DesktopArtifact";
import {
  SandboxBrowserPanel,
  SandboxCodePanel,
  SandboxFilesPanel,
  SandboxStateProvider,
  SandboxTerminalPanel,
} from "@/app/components/artifacts/PythonSandboxArtifact";
import PlanArtifact from "@/app/components/artifacts/PlanArtifact";
import ClarificationArtifact from "@/app/components/artifacts/ClarificationArtifact";
import ChatCodeArtifact from "@/app/components/ui/ChatCodeArtifact";
import ChatArtifactCard from "@/app/components/ui/ChatArtifactCard";
import AgentStatusCard from "@/app/components/ui/AgentStatusCard";
import ShareChatModal from "@/app/components/ui/ShareChatModal";
import CreditsModal, {
  type IntegrationProvider,
  type ProfileTab,
  type SettingsTab,
  type ThemePreference,
} from "@/app/components/ui/CreditsModal";
import ClarificationCard, {
  extractClarificationPayload,
  type ClarificationPayload,
  type ClarificationResponseState,
} from "@/app/components/ui/ClarificationCard";
import TakeoverCard, {
  extractTakeoverPayload,
  looksLikeTakeoverRequest,
  type TakeoverPayload,
} from "@/app/components/ui/TakeoverCard";
import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import FilesDrawer from "@/app/components/ui/FilesDrawer";
import ComposerAttachMenu from "@/app/components/ui/ComposerAttachMenu";
import CanvasTimelineBar from "@/app/components/ui/CanvasTimelineBar";
import { motion, AnimatePresence } from "framer-motion";
import { db, type AgentRun } from "@/lib/db";
import { createClient } from "@/lib/supabase/client";
import {
  useConnectionManager,
  broadcastSync,
  createSmartPoll,
  type SyncEvent,
  type SmartPollController,
} from "@/lib/hooks/useConnectionManager";
import { CANVAS_ARTIFACT_ID_SET, isDeliverableArtifactId, normalizeArtifactId } from "@/lib/agent/artifact-mapping";
import {
  PLACEHOLDER_CANVAS_IDS,
  defaultPanelForArtifact,
  isSandboxPanelId,
  panelToArtifactId,
  type CanvasPanelId,
} from "@/lib/agent/canvas-panels";
import { normalizeSandboxState } from "@/lib/sandbox/sandbox-state";
import {
  appendCanvasTimelineEvent,
  sortCanvasTimelineEvents,
} from "@/lib/agent/canvas-timeline";
import type { CanvasTimelineEvent } from "@/lib/agent/types";
import { createStreamParser } from "@/lib/agent/stream-parser";
import { fileNameFromUrl, looksLikeImageUrl, openUrlInNewTab, parseSupabaseStorageUrl } from "@/lib/client/storage-links";
import type {
  MessageStatus,
  ReasoningSegment,
  RenderBlock,
  TraceSegment,
} from "@/lib/agent/message-row";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";

const DocumentArtifact = dynamic(() => import("@/app/components/artifacts/DocumentArtifact"), {
  ssr: false,
});
const SpreadsheetArtifact = dynamic(() => import("@/app/components/artifacts/SpreadsheetArtifact"), {
  ssr: false,
});
const Sidebar = dynamic(() => import("@/components/Sidebar"), {
  ssr: false,
  loading: () => (
    <div className="h-dvh shrink-0" style={{ width: "var(--sidebar-width, 280px)" }} />
  ),
});

type MessageFileStatus = "uploading" | "ready" | "error";
type PendingFileStatus = MessageFileStatus | "pending";

interface MessageFile {
  id: string;
  name: string;
  size: number;
  mimeType?: string;
  storagePath?: string;
  uploadStatus?: MessageFileStatus;
  error?: string;
}

interface PendingFile extends Omit<MessageFile, "uploadStatus"> {
  /**
   * Present for user-selected local files (needs upload).
   * Omitted for storage-backed attachments (already has storagePath).
   */
  file?: File;
  uploadStatus: PendingFileStatus;
}

type QueuedSend = {
  id: string;
  content: string;
  files: PendingFile[];
  enqueuedAt: string;
  source: "input" | "clarification";
};

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  files?: MessageFile[];
  reasoningSummary?: string;
  reasoningSummaryStatus?: "loading" | "done" | "error";
  reasoningSummaryError?: string;
  reasoningSegments?: ReasoningSegment[];
  traceSegments?: TraceSegment[];
  renderOrder?: RenderBlock[];
  status?: MessageStatus;
}

type ContextUsage = {
  inputTokens: number;
  maxInputTokens?: number;
  usedFraction?: number;
};

type MarkdownCodeProps = React.HTMLAttributes<HTMLElement> & {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  node?: unknown;
};

const ARTIFACT_MESSAGE_PREFIX = "__TUNA_ARTIFACT__:";
const THINKING_INDICATOR_DELAY_MS = 450;
const BUILTIN_CANVAS_IDS: ReadonlySet<string> = CANVAS_ARTIFACT_ID_SET;
const HIDDEN_ARTIFACT_IDS: ReadonlySet<string> = new Set(["intent"]);
const THEME_STORAGE_KEY = "tuna.theme";
const CHAT_RESUME_STORAGE_KEY = "tuna.resumeChatId";
const TRACE_PREVIEW_LIMIT = 140;
const REASONING_PREVIEW_LIMIT = 140;

const isHiddenArtifactId = (id: string) => HIDDEN_ARTIFACT_IDS.has(id);
const isResearchArtifactId = (id: string | null | undefined) =>
  typeof id === "string" && (id === "research" || id.startsWith("research-"));
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

const isSandboxStopped = (data: unknown) => {
  const state = normalizeSandboxState(data);
  if (!state) return false;
  return state.status === "cancelled" && !state.sessionId;
};

const shouldHoldSandboxAutoOpen = (artifactId?: string | null, data?: unknown) =>
  artifactId === "sandbox" && isSandboxStopped(data);

const readResumeChatId = (): string => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CHAT_RESUME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

const writeResumeChatId = (chatId: string | null) => {
  if (typeof window === "undefined") return;
  try {
    if (chatId && chatId.trim()) {
      window.localStorage.setItem(CHAT_RESUME_STORAGE_KEY, chatId);
    } else {
      window.localStorage.removeItem(CHAT_RESUME_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
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

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "0";
  const abs = Math.abs(tokens);
  if (abs < 1000) return `${Math.round(tokens)}`;
  if (abs < 1_000_000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  const m = tokens / 1_000_000;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
}

function parseCreditsValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function parseCreditsTotal(value: unknown): number | null {
  const direct = parseCreditsValue(value);
  if (typeof direct === "number") return direct;
  if (!isRecord(value)) return null;
  const total = parseCreditsValue(value.total_credits);
  if (typeof total === "number") return total;
  const base = parseCreditsValue(value.credits_balance);
  const daily = parseCreditsValue(value.daily_credits_balance);
  if (typeof base === "number" && typeof daily === "number") return base + daily;
  return null;
}

function formatCreditsShort(value: number | null, loading: boolean): string {
  if (loading) return "…";
  if (value === null) return "—";
  const abs = Math.abs(value);
  if (abs < 1000) return `${Math.round(value)}`;
  if (abs < 1_000_000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  const m = value / 1_000_000;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
}

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0.0%";
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return `${pct.toFixed(1)}%`;
}

function ContextUsageIndicator(props: { usage: ContextUsage; isDark: boolean }) {
  const max = props.usage.maxInputTokens ?? 0;

  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);

  const fractionRaw =
    typeof props.usage.usedFraction === "number" && Number.isFinite(props.usage.usedFraction)
      ? props.usage.usedFraction
      : max
        ? props.usage.inputTokens / max
        : 0;
  const fraction = Math.max(0, Math.min(1, fractionRaw));

  const tooltip = `${formatPct(fraction)} - ${formatCompactTokens(props.usage.inputTokens)} / ${formatCompactTokens(
    max
  )} context used`;

  const size = 18;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - fraction);

  const isNearLimit = fraction >= 0.95;

  const track = props.isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.14)";
  const progress = isNearLimit
    ? props.isDark
      ? "rgba(251,191,36,0.95)"
      : "rgb(217,119,6)"
    : props.isDark
      ? "rgba(255,255,255,0.85)"
      : "rgba(24,24,27,0.9)";

  const recomputeTooltipPos = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tooltipRef.current;
    if (!anchor || !tip) return;

    const margin = 8;
    const ar = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    let left = ar.right - tr.width; // align right edges
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - tr.width - margin));

    let top = ar.top - tr.height - margin; // above
    if (top < margin) {
      // Not enough space above; place below.
      top = ar.bottom + margin;
    }
    top = Math.min(Math.max(margin, top), Math.max(margin, vh - tr.height - margin));

    setTooltipPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    // Wait one frame so the tooltip node has a measured size.
    const raf = window.requestAnimationFrame(() => {
      recomputeTooltipPos();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open, tooltip, recomputeTooltipPos]);

  useEffect(() => {
    if (!open) return;
    const onReflow = () => recomputeTooltipPos();
    window.addEventListener("resize", onReflow);
    // Capture scroll events from nested scrollers too.
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, recomputeTooltipPos]);

  if (!max) return null;

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {open ? (
        <div
          ref={tooltipRef}
          style={
            tooltipPos
              ? { position: "fixed", left: tooltipPos.left, top: tooltipPos.top }
              : { position: "fixed", left: -10_000, top: -10_000 }
          }
          className={`pointer-events-none z-[9999] whitespace-nowrap rounded-md px-2 py-1 text-[11px] shadow-sm border ${
            props.isDark
              ? "bg-black/80 border-white/10 text-white/90"
              : "bg-white border-black/10 text-zinc-800"
          }`}
        >
          {tooltip}
        </div>
      ) : null}
      <button
        type="button"
        aria-label={tooltip}
        ref={anchorRef}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`h-9 w-9 rounded-full grid place-items-center transition-colors ${
          props.isDark ? "hover:bg-white/5 text-white/70" : "hover:bg-black/5 text-zinc-700"
        }`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={track}
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={progress}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </button>
    </div>
  );
}

function normalizeTraceSegments(input: unknown): TraceSegment[] {
  if (!Array.isArray(input)) return [];
  const out: TraceSegment[] = [];
  input.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) return;
    const id =
      typeof obj.id === "string" && obj.id.trim() ? obj.id : `trace-${idx}`;
    out.push({ id, text, status: "closed", isOpen: false });
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
  // This fixes cases like: "... persisted states!**Analyzing ...**" where the heading gets
  // merged into the previous paragraph during streaming/concatenation.
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
  if (singleLine.length <= REASONING_PREVIEW_LIMIT) return singleLine;
  return `${singleLine.slice(0, REASONING_PREVIEW_LIMIT - 3)}...`;
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

function hasReasoningOutput(message?: Message): boolean {
  if (!message) return false;
  const hasSegments = Array.isArray(message.reasoningSegments) && message.reasoningSegments.length > 0;
  const hasSummaryText = Boolean(message.reasoningSummary && message.reasoningSummary.trim());
  const hasSummaryError = message.reasoningSummaryStatus === "error";
  return hasSegments || hasSummaryText || hasSummaryError;
}

type ArtifactMessagePayload = {
  id: string;
  type?: string;
};

type ArtifactSnapshot = {
  type: string;
  data: unknown;
};

type ClarificationArtifactData = ClarificationPayload & {
  response?: ClarificationResponseState;
};

type ArtifactRenderEntry = {
  messageId: string;
  payload: ArtifactMessagePayload;
  planIndex?: number;
};

type RenderItem =
  | { kind: "message"; message: Message }
  | { kind: "artifactGroup"; entries: ArtifactRenderEntry[] };

function encodeArtifactMessage(payload: ArtifactMessagePayload): string {
  const normalizedId = normalizeArtifactId(payload.id, payload.type);
  return `${ARTIFACT_MESSAGE_PREFIX}${JSON.stringify({ ...payload, id: normalizedId })}`;
}

function inferArtifactTypeFromId(id: string): string | undefined {
  const normalized = String(id || "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith("dataset-search-")) return "dataset";
  if (normalized.startsWith("model-search-")) return "model_card";
  return undefined;
}

function parseArtifactMessage(content: string): ArtifactMessagePayload | null {
  if (!content.startsWith(ARTIFACT_MESSAGE_PREFIX)) return null;
  const raw = content.slice(ARTIFACT_MESSAGE_PREFIX.length);
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const obj = v as Record<string, unknown>;
    if (typeof obj.id !== "string" || !obj.id.trim()) return null;
    const rawType = typeof obj.type === "string" ? obj.type.trim() : "";
    const type = rawType || inferArtifactTypeFromId(obj.id);
    const normalizedId = normalizeArtifactId(obj.id, type);
    return { id: normalizedId, type };
  } catch {
    return null;
  }
}

const ARTIFACT_DATA_KEY_UNDEFINED = "__artifact_undefined__";
const ARTIFACT_DATA_KEY_NONJSON = "__artifact_nonjson__";

function getArtifactDataKey(data: unknown): string {
  if (data === undefined) return ARTIFACT_DATA_KEY_UNDEFINED;
  try {
    const json = JSON.stringify(data);
    return json ?? ARTIFACT_DATA_KEY_UNDEFINED;
  } catch {
    return ARTIFACT_DATA_KEY_NONJSON;
  }
}

function shouldShowInterruptedRunPrompt(params: {
  messages: Message[];
  hasActiveRun: boolean;
}): boolean {
  if (params.hasActiveRun) return false;
  if (params.messages.length === 0) return false;
  // Only show this prompt when the chat *currently ends* with an assistant turn.
  // If the user has sent a newer message since, "continue" is usually confusing/noisy.
  const lastMessage = params.messages[params.messages.length - 1];
  if (lastMessage.role !== "assistant") return false;

  const hasPromptAlready = params.messages.some(
    (message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim() === INTERRUPTED_RUN_PROMPT_MESSAGE
  );
  if (hasPromptAlready) return false;

  // Safe due to the lastMessage check above, but keep the fallback for safety.
  const lastAssistant =
    lastMessage.role === "assistant"
      ? lastMessage
      : [...params.messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return false;

  const content = lastAssistant.content.trim();
  if (content && /reply\s+["']?continue["']?/i.test(content)) {
    return false;
  }

  // If the agent is actively asking the user for clarification, don't show a "continue" prompt.
  // (The correct next step is to answer the question(s), not resume a run.)
  const lastUserIdx = (() => {
    for (let i = params.messages.length - 1; i >= 0; i -= 1) {
      if (params.messages[i].role === "user") return i;
    }
    return -1;
  })();
  const lastClarificationIdx = (() => {
    for (let i = params.messages.length - 1; i >= 0; i -= 1) {
      const m = params.messages[i];
      if (m.role !== "assistant") continue;
      const { payload } = extractClarificationFromMessage(m);
      if (payload) return i;
    }
    return -1;
  })();
  if (lastClarificationIdx !== -1 && lastUserIdx < lastClarificationIdx) {
    return false;
  }

  // Prefer the *latest* status event label over `status.phase`. Phase can lag (and older rows
  // may have it stuck on the initial label), but the last event label reflects where the run ended.
  const statusEvents = Array.isArray(lastAssistant.status?.events)
    ? lastAssistant.status.events
    : [];
  const lastStatusLabel =
    statusEvents.length > 0 && typeof statusEvents[statusEvents.length - 1]?.label === "string"
      ? statusEvents[statusEvents.length - 1].label.trim().toLowerCase()
      : "";
  const statusPhase =
    typeof lastAssistant.status?.phase === "string"
      ? lastAssistant.status.phase.trim().toLowerCase()
      : "";
  const statusSignal = lastStatusLabel || statusPhase;
  const statusLooksIncomplete =
    statusSignal.length > 0 &&
    statusSignal !== "done" &&
    statusSignal !== "failed" &&
    // "blocked" means the agent is waiting for user input, not interrupted.
    statusSignal !== "blocked";
  if (statusSignal === "done" || statusSignal === "failed" || statusSignal === "blocked") {
    return false;
  }

  // Treat artifact messages as non-interruptible UI events.
  // Use trimStart() so accidental leading whitespace doesn't break detection.
  const isArtifactMessage = parseArtifactMessage(lastAssistant.content.trimStart()) !== null;
  const hasStatusEvents = Boolean(lastAssistant.status?.events?.length);
  const hasReasoning = hasReasoningOutput(lastAssistant);
  const hasTrace = Array.isArray(lastAssistant.traceSegments) && lastAssistant.traceSegments.length > 0;
  const hasFiles = Array.isArray(lastAssistant.files) && lastAssistant.files.length > 0;
  const isEmptyAssistantShell =
    !isArtifactMessage &&
    !content &&
    !hasStatusEvents &&
    !hasReasoning &&
    !hasTrace &&
    !hasFiles;

  // Be conservative: show the prompt only with strong evidence the last run didn't finish.
  // Avoid relying on persisted "phase" here; it can lag and would make this show too broadly.
  if (statusLooksIncomplete) return true;
  if (isEmptyAssistantShell) return true;
  return false;
}

const INTENT_CLARIFICATION_TITLE = "Clarify intent details";
const INTENT_CLARIFICATION_DESCRIPTION =
  "Answer these to help us move forward.";
const INTENT_CLARIFICATION_LIMIT = 8;
const STREAM_DISCONNECT_ERROR_CODE = "STREAM_DISCONNECTED";
const STREAM_IDLE_ABORT_MS = 60_000;
const STREAM_IDLE_CHECK_MS = 5_000;
const DEFAULT_STREAM_ERROR_MESSAGE =
  "I apologize, but I'm having trouble connecting to the service right now.";
const STREAM_ERROR_MESSAGE_BY_CODE: Record<string, string> = {
  CONFIGURATION_ERROR:
    "Service is unavailable due to a server configuration issue. If you're the admin, verify server environment variables.",
  UPSTREAM_TIMEOUT: "The AI service timed out. Please retry in a moment.",
  UPSTREAM_ERROR: "The AI service is unavailable. Please retry shortly.",
  STREAM_DISCONNECTED: "Connection lost. Attempting to reconnect…",
  STREAM_ERROR: DEFAULT_STREAM_ERROR_MESSAGE,
};
const INTERRUPTED_RUN_PROMPT_MESSAGE =
  'It looks like the previous run was interrupted before it finished. Reply "continue" to resume.';
const INTENT_MISSING_INFO_PROMPTS: Record<string, string> = {
  budget: "What budget range should we target for this project",
  deadline: "Do you have a deadline or preferred timeline",
  target_accuracy: "What minimum accuracy or error rate do you need",
  deployment_target: "How do you plan to deploy or use the model (API, HuggingFace, local)",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createStreamDisconnectedError(): Error & { code: string } {
  const err = new Error("Stream disconnected before completion.");
  (err as Error & { code: string }).code = STREAM_DISCONNECT_ERROR_CODE;
  return err as Error & { code: string };
}

function shouldAttemptReconnectForStreamError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof DOMException && error.name === "TimeoutError") return true;

  // Only treat our local disconnect sentinel as reconnectable; known server error codes are not.
  if (isRecord(error) && typeof error.code === "string") {
    if (error.code === STREAM_DISCONNECT_ERROR_CODE) return true;
    if (error.code in STREAM_ERROR_MESSAGE_BY_CODE) return false;
  }

  // If this is a structured HTTP-ish error, don't attempt reconnect.
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  if (typeof status === "number" && status >= 400) return false;

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = raw.toLowerCase();
  if (!lower.trim()) return error instanceof TypeError;

  // Browser/network transport errors (exact strings vary by browser).
  if (lower.includes("failed to fetch")) return true;
  if (lower.includes("networkerror")) return true;
  if (lower.includes("network error")) return true;
  if (lower.includes("load failed")) return true;
  if (lower.includes("the network connection was lost")) return true;
  if (lower.includes("socket hang up")) return true;
  if (lower.includes("econnreset") || lower.includes("connection reset")) return true;
  if (lower.includes("net::err")) return true;
  if (lower.includes("err_network")) return true;
  if (lower.includes("connection aborted")) return true;
  if (lower.includes("connection was closed")) return true;
  if (lower.includes("stream") && (lower.includes("closed") || lower.includes("terminated"))) return true;

  return false;
}

function resolveStreamErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") {
    const mapped = STREAM_ERROR_MESSAGE_BY_CODE[error.code];
    if (mapped) return mapped;
  }

  const status =
    isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const isEventStream =
    isRecord(error) && typeof error.isEventStream === "boolean"
      ? error.isEventStream
      : true;

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const normalized = raw.trim();
  if (!normalized) {
    return resolveStatusMessage(status, isEventStream);
  }

  const lower = normalized.toLowerCase();
  if (lower.includes("sign in required")) {
    return "Please sign in to continue.";
  }
  if (lower.includes("streaming is unavailable")) {
    return "Streaming is unavailable right now. Please try again.";
  }
  if (lower.includes("configuration")) {
    return STREAM_ERROR_MESSAGE_BY_CODE.CONFIGURATION_ERROR;
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return STREAM_ERROR_MESSAGE_BY_CODE.UPSTREAM_TIMEOUT;
  }
  if (lower.includes("openai") || lower.includes("azure")) {
    return STREAM_ERROR_MESSAGE_BY_CODE.UPSTREAM_ERROR;
  }

  const looksSensitive = /api-key|authorization|bearer|https?:\/\//i;
  if (looksSensitive.test(normalized)) return DEFAULT_STREAM_ERROR_MESSAGE;

  if (isHtmlLike(normalized) || normalized.length > 240) {
    return DEFAULT_STREAM_ERROR_MESSAGE;
  }

  if (typeof status === "number" && status > 0) {
    const statusMessage = resolveStatusMessage(status, isEventStream);
    if (statusMessage) return statusMessage;
  }

  return normalized;
}

function normalizeErrorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isHtmlLike(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("<!doctype") || lower.includes("<html") || lower.includes("<body");
}

function extractErrorMessageFromBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      if (Array.isArray(parsed)) return "";
      const direct = typeof parsed.message === "string" ? parsed.message : "";
      if (direct) return normalizeErrorText(direct);
      const error = isRecord(parsed.error) ? parsed.error : null;
      if (error && typeof error.message === "string") {
        return normalizeErrorText(error.message);
      }
      if (typeof parsed.error === "string") {
        return normalizeErrorText(parsed.error);
      }
      const detail = typeof parsed.detail === "string" ? parsed.detail : "";
      if (detail) return normalizeErrorText(detail);
    } catch {
      // ignore parse errors
    }
  }

  if (isHtmlLike(trimmed)) return "";
  const normalized = normalizeErrorText(trimmed);
  if (normalized.length > 240) return "";
  return normalized;
}

function resolveStatusMessage(
  status: number | undefined,
  isEventStream: boolean
): string {
  if (status === 401 || status === 403) {
    return "Please sign in to continue.";
  }
  if (status === 404) {
    return "Streaming endpoint is unavailable right now. Please try again.";
  }
  if (status === 413) {
    return "The request is too large to stream. Try a shorter message or remove large files.";
  }
  if (status === 429) {
    return "The service is rate limiting requests. Please try again shortly.";
  }
  if (typeof status === "number" && status >= 500) {
    return "The server failed to start the stream. Please retry shortly.";
  }
  if (!isEventStream) {
    return "Streaming is unavailable right now. Please try again.";
  }
  if (typeof status === "number" && status > 0) {
    return `Stream failed: ${status}.`;
  }
  return DEFAULT_STREAM_ERROR_MESSAGE;
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

function getMessageEpochMs(message: Message): number | null {
  const raw = (message as { created_at?: unknown }).created_at;
  if (typeof raw === "string") return toEpochMs(raw);
  if (typeof message.createdAt === "string") return toEpochMs(message.createdAt);
  return null;
}

function findInsertIndexByTimestamp(messages: Message[], at: string): number {
  const targetMs = toEpochMs(at);
  if (targetMs === null) return messages.length;
  for (let i = 0; i < messages.length; i += 1) {
    const existingMs = getMessageEpochMs(messages[i]);
    if (existingMs === null) continue;
    if (existingMs > targetMs) return i;
  }
  return messages.length;
}

function sortTimelineByAt(timeline: CanvasTimelineEvent[]): CanvasTimelineEvent[] {
  return sortCanvasTimelineEvents(timeline);
}

function normalizePromptKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function ensureQuestion(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;
  return /[?]\s*$/.test(trimmed) ? trimmed : `${trimmed}?`;
}

function promptFromMissingInfo(value: string): string | null {
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return INTENT_MISSING_INFO_PROMPTS[key] ?? null;
}

function buildIntentClarificationPayload(data: unknown): ClarificationPayload | null {
  if (!isRecord(data)) return null;
  const intent = isRecord(data.intent) ? data.intent : null;
  const intentComplete =
    typeof data.intentComplete === "boolean" ? data.intentComplete : undefined;
  const intentBlockers = Array.isArray(data.intentBlockers)
    ? data.intentBlockers.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      )
    : [];
  if (intentComplete === true && intentBlockers.length === 0) return null;
  const neededRaw =
    intent && Array.isArray(intent.clarificationsNeeded)
      ? intent.clarificationsNeeded
      : [];
  const suggestedFollowUp = Array.isArray(data.suggestedFollowUp)
    ? data.suggestedFollowUp
    : [];
  const missingInformation = Array.isArray(data.missingInformation)
    ? data.missingInformation
    : [];

  const prompts: string[] = [];
  const seen = new Set<string>();
  const addPrompt = (prompt: string) => {
    const cleaned = prompt.trim();
    if (!cleaned) return;
    const key = normalizePromptKey(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    prompts.push(cleaned);
  };

  for (const item of neededRaw) {
    if (typeof item !== "string") continue;
    addPrompt(ensureQuestion(item));
  }

  for (const item of missingInformation) {
    if (typeof item !== "string") continue;
    const prompt = promptFromMissingInfo(item);
    if (!prompt) continue;
    addPrompt(ensureQuestion(prompt));
  }

  for (const item of suggestedFollowUp) {
    if (typeof item !== "string") continue;
    addPrompt(ensureQuestion(item));
  }

  if (prompts.length === 0 && intentComplete === false) {
    addPrompt(ensureQuestion("Can you share more detail about the task goals"));
  }

  const limited = prompts.filter(Boolean).slice(0, INTENT_CLARIFICATION_LIMIT);
  if (limited.length === 0) return null;

  const questions = limited.map((prompt, idx) => ({
    id: `q${idx + 1}`,
    prompt,
    allow_multiple: false,
    required: true,
    options: [
      {
        id: "provide",
        label: "Provide details",
      },
      { id: "recommend", label: "Need recommendation" },
      { id: "unsure", label: "Not sure yet" },
    ],
  }));

  const response_format = `Clarification answers:\n${questions
    .map((question) => `- ${question.prompt}: {{${question.id}}}`)
    .join("\n")}`;

  return {
    version: 1,
    title: INTENT_CLARIFICATION_TITLE,
    description: INTENT_CLARIFICATION_DESCRIPTION,
    submit_label: "Send answers",
    layout: questions.length > 3 ? "stepper" : "stacked",
    response_format,
    questions,
  };
}

function buildClarificationKey(payload: ClarificationPayload): string {
  return payload.questions.map((q) => normalizePromptKey(q.prompt)).join("|");
}

function buildClarificationBlock(payload: ClarificationPayload): string {
  return ["```clarification", JSON.stringify(payload, null, 2), "```"].join("\n");
}

function extractClarificationFromMessage(message: {
  content: string;
  traceSegments?: TraceSegment[];
}): { payload: ClarificationPayload | null; stripped: string; source: "content" | "trace" | "none" } {
  const fromContent = extractClarificationPayload(message.content);
  if (fromContent.payload) {
    return { payload: fromContent.payload, stripped: fromContent.stripped, source: "content" };
  }

  const baseStripped = fromContent.stripped;
  const segments = Array.isArray(message.traceSegments) ? message.traceSegments : [];
  for (const segment of segments) {
    const fromTrace = extractClarificationPayload(segment.text);
    if (fromTrace.payload) {
      return { payload: fromTrace.payload, stripped: baseStripped, source: "trace" };
    }
  }

  return { payload: null, stripped: baseStripped, source: "none" };
}

function extractTakeoverFromMessage(message: {
  content: string;
  traceSegments?: TraceSegment[];
}): { payload: TakeoverPayload | null; stripped: string; source: "content" | "trace" | "none" } {
  const fromContent = extractTakeoverPayload(message.content);
  if (fromContent.payload) {
    return { payload: fromContent.payload, stripped: fromContent.stripped, source: "content" };
  }

  const baseStripped = fromContent.stripped;
  const segments = Array.isArray(message.traceSegments) ? message.traceSegments : [];
  for (const segment of segments) {
    const fromTrace = extractTakeoverPayload(segment.text);
    if (fromTrace.payload) {
      return { payload: fromTrace.payload, stripped: baseStripped, source: "trace" };
    }
  }

  return { payload: null, stripped: baseStripped, source: "none" };
}

export function ChatShell() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const routeChatIdRaw = (params as { chatId?: string | string[] }).chatId;
  const routeChatId = Array.isArray(routeChatIdRaw) ? routeChatIdRaw[0] : routeChatIdRaw;

  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [currentChatTitle, setCurrentChatTitle] = useState<string>("");
  const [isCurrentChatPersisted, setIsCurrentChatPersisted] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<PendingFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isFilesDrawerOpen, setIsFilesDrawerOpen] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [queuedSendCount, setQueuedSendCount] = useState(0);
  const [showThinkingIndicator, setShowThinkingIndicator] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [isCanvasLoading, setIsCanvasLoading] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>("light");
  const [isDark, setIsDark] = useState(false);
  const [isThemeHydrated, setIsThemeHydrated] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const [forceDraftScope, setForceDraftScope] = useState(false);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isRunPolling, setIsRunPolling] = useState(false);
  type ConnectionBannerMode = "reconnecting" | "running" | null;
  const [visibleConnectionBannerMode, setVisibleConnectionBannerMode] =
    useState<ConnectionBannerMode>(null);
  const bannerShowTimerRef = useRef<number | null>(null);
  const bannerHideTimerRef = useRef<number | null>(null);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "canvas">("chat");
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isCreditsOpen, setIsCreditsOpen] = useState(false);
  const [creditsTab, setCreditsTab] = useState<SettingsTab>("usage");
  const [creditsProfileTab, setCreditsProfileTab] = useState<ProfileTab>("profile");
  const [creditsIntegrationProvider, setCreditsIntegrationProvider] = useState<
    IntegrationProvider | undefined
  >(undefined);
  const [attachMenuOpen, setAttachMenuOpen] = useState<"landing" | "chat" | null>(null);
  const [, setIsCanvasDismissed] = useState(false);
  const chatPanelsRef = useRef<HTMLDivElement | null>(null);
  const lastPointerInPanelsRef = useRef(false);
  const lastPanelsPointerAtRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const [messagesScrollEl, setMessagesScrollElState] = useState<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const landingAttachMenuRef = useRef<HTMLDivElement | null>(null);
  const chatAttachMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runPollRef = useRef<SmartPollController | null>(null);
  const reconnectRetryCountRef = useRef(0);
  const MAX_RECONNECT_RETRIES = 60; // ~2.5 min with base 2.5s interval before giving up
  const supabase = useMemo(() => createClient(), []);
  const currentChatIdRef = useRef<string | null>(null);
  const draftScopeIdRef = useRef<string>(`draft:${crypto.randomUUID()}`);
  const activeArtifactRef = useRef<string | null>(null);
  const hasMessagesRef = useRef(false);
  const artifactMessageStateRef = useRef<Map<string, string>>(new Map());
  const latestArtifactSnapshotRef = useRef<Map<string, ArtifactSnapshot>>(new Map());
  const clarificationArtifactIdsRef = useRef<Set<string>>(new Set());
  const clarificationTimelineIdsRef = useRef<Set<string>>(new Set());
  const lastClarificationArtifactRef = useRef<string | null>(null);
  const intentClarificationKeyRef = useRef<string>("");
  const pendingIntentClarificationRef = useRef<ClarificationPayload | null>(null);
  const pendingIntentClarificationKeyRef = useRef<string>("");
  const streamHasClarificationRef = useRef(false);
  const latestChatLoadTokenRef = useRef(0);
  const pendingInitialScrollRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const thinkingDelayRef = useRef<number | null>(null);
  const hasStreamSignalRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamGenerationRef = useRef(0);
  const queuedSendsRef = useRef<QueuedSend[]>([]);
  const isDrainingQueueRef = useRef(false);
  const pendingUrlChatIdRef = useRef<string | null>(null);
  const resumeAttemptedRef = useRef(false);
  const resumeChatIdRef = useRef<string | null>(null);
  const [creditsBalance, setCreditsBalance] = useState<number | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);

  const clearQueuedSends = useCallback(() => {
    queuedSendsRef.current = [];
    setQueuedSendCount(0);
  }, []);

  const loadCredits = useCallback(async () => {
    setCreditsLoading(true);
    try {
      const { data, error } = await supabase.rpc("get_credit_summary");
      if (error) {
        const fallback = await supabase.rpc("get_credit_balance");
        if (fallback.error) {
          setCreditsBalance(null);
        } else {
          setCreditsBalance(parseCreditsValue(fallback.data));
        }
      } else {
        setCreditsBalance(parseCreditsTotal(data));
      }
    } finally {
      setCreditsLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    const poll = createSmartPoll(loadCredits, {
      baseInterval: 15_000,
      maxInterval: 60_000,
      pauseWhenHidden: true,
      immediate: true,
    });
    poll.start();
    return () => poll.stop();
  }, [loadCredits]);

  const openCredits = useCallback(
    (tab?: SettingsTab, profileTab?: ProfileTab, integrationProvider?: IntegrationProvider) => {
      setCreditsTab(tab ?? "usage");
      setCreditsProfileTab(profileTab ?? "profile");
      setCreditsIntegrationProvider(integrationProvider);
      setIsCreditsOpen(true);
    },
    []
  );
  const closeCredits = useCallback(() => {
    setIsCreditsOpen(false);
    setCreditsIntegrationProvider(undefined);
  }, []);

  const openAttachMenu = useCallback((target: "landing" | "chat") => {
    setAttachMenuOpen((prev) => (prev === target ? null : target));
  }, []);

  const closeAttachMenu = useCallback(() => {
    setAttachMenuOpen(null);
  }, []);

  const attachViaUpload = useCallback(() => {
    closeAttachMenu();
    fileInputRef.current?.click();
  }, [closeAttachMenu]);

  const attachViaGithubIntegration = useCallback(() => {
    closeAttachMenu();
    openCredits("integrations", "profile", "github");
  }, [closeAttachMenu, openCredits]);

  const attachViaHuggingFaceIntegration = useCallback(() => {
    closeAttachMenu();
    openCredits("integrations", "profile", "huggingface");
  }, [closeAttachMenu, openCredits]);

  const enqueueQueuedSend = useCallback((job: QueuedSend) => {
    queuedSendsRef.current = [...queuedSendsRef.current, job];
    setQueuedSendCount(queuedSendsRef.current.length);
  }, []);

  const dequeueQueuedSend = useCallback((): QueuedSend | null => {
    const next = queuedSendsRef.current[0];
    if (!next) return null;
    queuedSendsRef.current = queuedSendsRef.current.slice(1);
    setQueuedSendCount(queuedSendsRef.current.length);
    return next;
  }, []);

  const clearThinkingTimer = useCallback(() => {
    if (thinkingDelayRef.current !== null) {
      window.clearTimeout(thinkingDelayRef.current);
      thinkingDelayRef.current = null;
    }
  }, []);

  const abortActiveStream = useCallback(() => {
    const controller = streamAbortRef.current;
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
    streamAbortRef.current = null;
  }, []);

  const appendDesktopNotice = useCallback(
    (content: string) => {
      const createdAt = new Date().toISOString();
      const message: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        createdAt,
      };
      setMessages((prev) => [...prev, message]);
      hasMessagesRef.current = true;
      stickToBottomRef.current = true;
      window.requestAnimationFrame(() => {
        const el = messagesScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      });

      const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId;
      if (chatId && isCurrentChatPersisted) {
        void db
          .upsertMessage({
            id: message.id,
            chatId,
            role: message.role,
            content: message.content,
            createdAt,
          })
          .catch((err) => {
            console.error("Failed to persist desktop notice", err);
          });
      }
    },
    [currentChatId, isCurrentChatPersisted, routeChatId]
  );

  const stopAgentFromDesktop = useCallback(
    (reason?: string) => {
      abortActiveStream();
      setIsTyping(false);
      setIsReconnecting(false);
      const stopChatId = currentChatIdRef.current ?? currentChatId ?? routeChatId;
      if (stopChatId) {
        void fetch(`/api/chat/${encodeURIComponent(stopChatId)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason ?? "Stopped by user takeover" }),
        }).catch(() => undefined);
      }
      if (activeRun?.id) {
        void db.updateRunStatus(activeRun.id, "cancelled", reason ?? "Stopped by user");
      }
      setActiveRun(null);
    },
    [abortActiveStream, activeRun, currentChatId, routeChatId]
  );

  // Keep stable global event listeners; use refs so we never miss events during re-renders.
  const stopAgentFromDesktopRef = useRef(stopAgentFromDesktop);
  const appendDesktopNoticeRef = useRef(appendDesktopNotice);
  const handleSendRef = useRef(handleSend);
  stopAgentFromDesktopRef.current = stopAgentFromDesktop;
  appendDesktopNoticeRef.current = appendDesktopNotice;
  handleSendRef.current = handleSend;

  useEffect(() => {
    const onStop = () => {
      stopAgentFromDesktopRef.current("Stopped by user takeover");
      appendDesktopNoticeRef.current("User took over the desktop session. Agent paused.");
    };
    const onHandoff = (event: Event) => {
      const detail = (event as CustomEvent<{ notes?: string }>).detail;
      const notes = detail?.notes?.trim();
      const message = notes
        ? `I handed back the desktop session. Summary of actions: ${notes}`
        : "I handed back the desktop session. Please resume from the current UI state.";
      void handleSendRef.current(message, { source: "input" });
    };
    window.addEventListener("tuna-desktop-stop-agent", onStop as EventListener);
    window.addEventListener("tuna-desktop-handoff", onHandoff as EventListener);
    return () => {
      window.removeEventListener("tuna-desktop-stop-agent", onStop as EventListener);
      window.removeEventListener("tuna-desktop-handoff", onHandoff as EventListener);
    };
  }, []);

  const scheduleThinkingIndicator = useCallback(() => {
    hasStreamSignalRef.current = false;
    setShowThinkingIndicator(false);
    clearThinkingTimer();
    thinkingDelayRef.current = window.setTimeout(() => {
      if (!hasStreamSignalRef.current) {
        setShowThinkingIndicator(true);
      }
    }, THINKING_INDICATOR_DELAY_MS);
  }, [clearThinkingTimer]);

  const markStreamActivity = useCallback(() => {
    if (hasStreamSignalRef.current) return;
    hasStreamSignalRef.current = true;
    clearThinkingTimer();
    setShowThinkingIndicator(false);
  }, [clearThinkingTimer]);

  const persistResumeChatId = useCallback((chatId: string | null) => {
    writeResumeChatId(chatId);
  }, []);

  useEffect(() => {
    return () => clearThinkingTimer();
  }, [clearThinkingTimer]);

  type ModelPreset = "tuna_1_fast" | "tuna_1" | "tuna_1_high";
  const MODEL_LABEL_BASE = "Tuna 1.0";
  const getModelLabelParts = (label: string) => {
    if (!label.startsWith(MODEL_LABEL_BASE)) {
      return { base: label, variant: "" };
    }
    const variant = label.slice(MODEL_LABEL_BASE.length).trim();
    return { base: MODEL_LABEL_BASE, variant };
  };
  const MODEL_PRESETS: {
    id: ModelPreset;
    label: string;
    description: string;
    reasoningEffort?: "low" | "medium" | "xhigh";
  }[] = [
    {
      id: "tuna_1_fast",
      label: MODEL_LABEL_BASE,
      description: "Quick replies for rapid responses",
      reasoningEffort: "low",
    }, // Lite: default, light reasoning summary
    {
      id: "tuna_1",
      label: `${MODEL_LABEL_BASE} Thinking`,
      description: "Balanced speed and depth",
      reasoningEffort: "medium",
    }, // 1.0: Medium
    {
      id: "tuna_1_high",
      label: `${MODEL_LABEL_BASE} Max`,
      description: "Deeper thinking for complex work",
      reasoningEffort: "xhigh",
    }, // 1.0 Pro: xhigh
  ];

  const [modelPreset, setModelPreset] = useState<ModelPreset>("tuna_1_fast");
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const activePreset = MODEL_PRESETS.find((p) => p.id === modelPreset);
  const activeLabelParts = getModelLabelParts(activePreset?.label ?? MODEL_LABEL_BASE);
  const modelVariantActiveClassName = `shrink-0 text-sm sm:text-base font-semibold ${
    isDark ? "text-white/60" : "text-zinc-500"
  }`;
  const modelVariantMenuClassName = `shrink-0 text-xs sm:text-sm font-semibold ${
    isDark ? "text-white/60" : "text-zinc-500"
  }`;
  const renderModelSelector = () => (
    <div ref={modelSelectorRef} className="relative">
      <button
        type="button"
        onClick={() => setModelSelectorOpen((v) => !v)}
        className={`inline-flex items-center gap-2 px-0 py-1 text-[15px] sm:text-[16px] tracking-tight transition-colors ${
          isDark
            ? "text-white hover:text-white/90"
            : "text-zinc-900 hover:text-zinc-700"
        }`}
        aria-haspopup="menu"
        aria-expanded={modelSelectorOpen}
      >
        <span className="inline-flex items-center gap-2 max-w-[180px] sm:max-w-[260px] min-w-0">
          <span
            className={`truncate ${
              modelPreset === "tuna_1_fast" || modelPreset === "tuna_1_high"
                ? "font-semibold"
                : "font-medium"
            }`}
          >
            {activeLabelParts.base}
          </span>
          {activeLabelParts.variant ? (
            <span className={modelVariantActiveClassName}>{activeLabelParts.variant}</span>
          ) : null}
        </span>
        <ChevronDown
          className={`w-[18px] h-[18px] opacity-80 transition-transform ${modelSelectorOpen ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {modelSelectorOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute left-0 mt-2 w-[260px] rounded-2xl border border-default shadow-xl overflow-hidden z-[60] bg-elevated text-primary shadow-black/25"
            role="menu"
          >
            <div className="p-2">
              {MODEL_PRESETS.map((opt) => {
                const selected = opt.id === modelPreset;
                const labelParts = getModelLabelParts(opt.label);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setModelPreset(opt.id);
                      setModelSelectorOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? isDark
                          ? "bg-white/10 text-white"
                          : "bg-black/5 text-zinc-900"
                        : isDark
                          ? "hover:bg-white/5 text-white/90"
                          : "hover:bg-black/5 text-zinc-800"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={`text-[13px] sm:text-sm truncate ${
                            opt.id === "tuna_1_fast" || opt.id === "tuna_1_high"
                              ? "font-semibold"
                              : "font-medium"
                          }`}
                        >
                          {labelParts.base}
                        </div>
                        {labelParts.variant ? (
                          <span className={modelVariantMenuClassName}>{labelParts.variant}</span>
                        ) : null}
                      </div>
                      <div
                        className={`text-[11px] sm:text-xs truncate ${
                          isDark ? "text-white/60" : "text-zinc-500"
                        }`}
                      >
                        {opt.description}
                      </div>
                    </div>
                    {selected ? (
                      <Check className={`w-4 h-4 shrink-0 ${isDark ? "text-white" : "text-zinc-900"}`} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  const artifactScopeId = useMemo(() => {
    if (forceDraftScope) return draftScopeIdRef.current;
    return routeChatId ?? currentChatId ?? draftScopeIdRef.current;
  }, [currentChatId, forceDraftScope, routeChatId]);
  const artifactChatId = useMemo(() => {
    if (forceDraftScope) return currentChatId ?? null;
    return routeChatId ?? currentChatId ?? null;
  }, [currentChatId, forceDraftScope, routeChatId]);

  // Store for Artifacts
  const {
    activeArtifact,
    setActiveArtifact,
    addArtifact,
    clearArtifacts,
    setSandboxCode,
    artifacts,
  } = useProjectArtifacts(artifactScopeId);

  useEffect(() => {
    const next = new Map<string, ArtifactSnapshot>();
    for (const artifact of artifacts) {
      next.set(artifact.id, { type: artifact.type, data: artifact.data });
    }
    latestArtifactSnapshotRef.current = next;
  }, [artifacts]);

  const clearArtifactsForScope = useProjectStore((s) => s.clearArtifacts);
  const setSandboxCodeForScope = useProjectStore((s) => s.setSandboxCode);
  const migrateArtifactScope = useProjectStore((s) => s.migrateArtifactScope);
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
    if (!forceDraftScope) return;
    if (currentChatId) {
      setForceDraftScope(false);
      return;
    }
    if (!routeChatId) {
      setForceDraftScope(false);
    }
  }, [currentChatId, forceDraftScope, routeChatId]);

  useEffect(() => {
    if (!focusedPanel && openPanels.length > 0) {
      setFocusedPanel(openPanels[openPanels.length - 1]);
    }
  }, [focusedPanel, openPanels]);
  const clarificationResponseMap = useMemo(() => {
    const map = new Map<string, ClarificationResponseState>();
    for (const artifact of artifacts) {
      if (!artifact?.id?.startsWith("clarification-")) continue;
      const data = isRecord(artifact.data) ? artifact.data : null;
      const response = data && isRecord(data.response)
        ? (data.response as ClarificationResponseState)
        : null;
      if (response) {
        map.set(artifact.id, response);
      }
    }
    return map;
  }, [artifacts]);
  const clarificationResponseMapRef = useRef(clarificationResponseMap);
  useEffect(() => {
    clarificationResponseMapRef.current = clarificationResponseMap;
  }, [clarificationResponseMap]);
  const shouldHoldClarificationAutoOpen = useCallback((artifactId?: string | null) => {
    const focusedPanel = focusedPanelRef.current;
    if (!focusedPanel || !focusedPanel.startsWith("clarification-")) return false;
    if (artifactId && artifactId.startsWith("clarification-")) return false;
    const response = clarificationResponseMapRef.current.get(focusedPanel);
    return !response || !response.answeredAt;
  }, []);
  const isLgUp = useMediaQuery("(min-width: 1024px)");
  const revealCanvasOnMobile = useCallback(() => {
    if (!isLgUp) setMobilePane("canvas");
  }, [isLgUp]);
  const showChatOnMobile = useCallback(() => {
    if (!isLgUp) setMobilePane("chat");
  }, [isLgUp]);

  useEffect(() => {
    hasMessagesRef.current = messages.length > 0;
  }, [messages.length]);

  const [canvasTimeline, setCanvasTimeline] = useState<CanvasTimelineEvent[]>([]);
  const [timelineCursor, setTimelineCursor] = useState(0);
  const [timelinePlayback, setTimelinePlayback] = useState<"paused" | "playing">("paused");
  const isLive = canvasTimeline.length === 0 || timelineCursor >= canvasTimeline.length - 1;
  const canvasTimelineRef = useRef<CanvasTimelineEvent[]>([]);
  const timelineCursorRef = useRef(0);
  const isLiveRef = useRef(true);

  useEffect(() => {
    activeArtifactRef.current = activeArtifact;
    if (!activeArtifact) setIsCanvasLoading(false);
  }, [activeArtifact]);

  useEffect(() => {
    canvasTimelineRef.current = canvasTimeline;
  }, [canvasTimeline]);

  useEffect(() => {
    timelineCursorRef.current = timelineCursor;
    isLiveRef.current = isLive;
  }, [timelineCursor, isLive]);

  // Sync store from timeline: if the timeline has artifact data that the store is missing,
  // or the store is stale, back-fill/update the store. This guards against artifacts being
  // lost due to scope migrations, clearArtifacts calls on navigation, or stale stream state.
  useEffect(() => {
    if (canvasTimeline.length === 0) return;
    const storeDataKeyById = new Map<string, string>();
    for (const a of artifacts) {
      storeDataKeyById.set(a.id, getArtifactDataKey(a.data));
    }
    const latestByArtifact = new Map<string, { type: string; data: unknown }>();
    for (let i = canvasTimeline.length - 1; i >= 0; i -= 1) {
      const frame = canvasTimeline[i];
      if (!frame?.artifactId || frame.kind !== "upsert") continue;
      if (latestByArtifact.has(frame.artifactId)) continue;
      if (frame.data !== undefined && frame.data !== null) {
        latestByArtifact.set(frame.artifactId, {
          type: frame.artifactType ?? "markdown",
          data: frame.data,
        });
      }
    }
    for (const [id, { type, data }] of latestByArtifact) {
      const storeKey = storeDataKeyById.get(id);
      const timelineKey = getArtifactDataKey(data);
      if (storeKey !== undefined && storeKey === timelineKey) continue;
      addArtifact({ id, type, data });
    }
  }, [canvasTimeline, artifacts, addArtifact]);

  const selectedFrame = canvasTimeline.length > 0
    ? canvasTimeline[Math.min(timelineCursor, canvasTimeline.length - 1)]
    : null;
  const dataOverrideByArtifact = useMemo(() => {
    if (isLive || !selectedFrame?.artifactId) return new Map<string, unknown>();
    return new Map([[selectedFrame.artifactId, selectedFrame.data]]);
  }, [isLive, selectedFrame]);

  const findLatestFrameIndexForArtifact = useCallback((artifactId: string): number | null => {
    const t = canvasTimelineRef.current;
    for (let i = t.length - 1; i >= 0; i -= 1) {
      if (t[i]?.artifactId === artifactId) return i;
    }
    return null;
  }, []);

  const openPanel = useCallback(
    (panelId: CanvasPanelId, opts?: { focus?: boolean }) => {
      setOpenPanels((prev) => (prev.length === 1 && prev[0] === panelId ? prev : [panelId]));
      if (opts?.focus === false) return;
      setFocusedPanel(panelId);
      const artifactId = panelToArtifactId(panelId);
      if (artifactId) setActiveArtifact(artifactId);
      setIsCanvasDismissed(false);
    },
    [setActiveArtifact, setIsCanvasDismissed]
  );

  const focusPanel = useCallback(
    (panelId: CanvasPanelId, opts?: { jumpToLatest?: boolean }) => {
      setFocusedPanel(panelId);
      const artifactId = panelToArtifactId(panelId);
      if (artifactId) {
        setActiveArtifact(artifactId);
        setIsCanvasDismissed(false);
        if (opts?.jumpToLatest !== false) {
          const idx = findLatestFrameIndexForArtifact(artifactId);
          if (idx !== null) setTimelineCursor(idx);
        }
      }
    },
    [findLatestFrameIndexForArtifact, setActiveArtifact, setIsCanvasDismissed]
  );

  const closePanel = useCallback(
    (panelId: CanvasPanelId) => {
      if (!openPanelsRef.current.includes(panelId)) return;
      setOpenPanels([]);
      setFocusedPanel(null);
      setActiveArtifact(null);
      setIsCanvasDismissed(true);
    },
    [setActiveArtifact, setIsCanvasDismissed]
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

  useEffect(() => {
    if (!activeArtifact) return;
    if (!hasMessagesRef.current) return;
    const panelId = defaultPanelForArtifact(activeArtifact);
    if (!panelId) return;
    if (openPanelsRef.current.includes(panelId) && focusedPanelRef.current === panelId) return;
    openPanelForArtifact(activeArtifact);
  }, [activeArtifact, openPanelForArtifact]);

  const appendTimelineEvent = useCallback(
    (event: {
      kind: "upsert" | "open";
      artifactId: string;
      artifactType: string;
      data: unknown;
      at?: string;
    }) => {
      const shouldAutoFollow = isLiveRef.current;
      setCanvasTimeline((prev) => {
        const out = [...prev];
        const pushed = appendCanvasTimelineEvent(out, {
          at: typeof event.at === "string" && event.at.trim() ? event.at : new Date().toISOString(),
          kind: event.kind,
          artifactId: event.artifactId,
          artifactType: event.artifactType,
          data: event.data,
        });
        if (!pushed) return prev;
        if (shouldAutoFollow) {
          setTimelineCursor(out.length - 1);
        }
        return out;
      });
    },
    [setCanvasTimeline, setTimelineCursor]
  );

  const recordClarificationTimeline = useCallback(
    (
      artifactId: string,
      data: ClarificationArtifactData,
      kind: "upsert" | "open" = "upsert",
      at?: string
    ) => {
      appendTimelineEvent({
        kind,
        artifactId,
        artifactType: "clarification",
        data,
        at,
      });
    },
    [appendTimelineEvent]
  );

  const jumpToLive = useCallback(() => {
    const t = canvasTimelineRef.current;
    if (t.length === 0) return;
    const idx = t.length - 1;
    setTimelinePlayback("paused");
    setTimelineCursor(idx);
    const frame = t[idx];
    if (frame?.artifactId) {
      openPanelForArtifact(frame.artifactId, { jumpToLatest: false });
    }
  }, [openPanelForArtifact]);

  const setCursorAndOpenFrame = useCallback(
    (idx: number) => {
      const t = canvasTimelineRef.current;
      if (t.length === 0) return;
      const clamped = Math.min(Math.max(idx, 0), t.length - 1);
      const frame = t[clamped];
      if (!frame?.artifactId) return;
      setTimelineCursor(clamped);
      openPanelForArtifact(frame.artifactId, { jumpToLatest: false });
    },
    [openPanelForArtifact]
  );

  const stepTimeline = useCallback(
    (delta: number) => {
      setTimelinePlayback("paused");
      setCursorAndOpenFrame(timelineCursorRef.current + delta);
    },
    [setCursorAndOpenFrame]
  );

  const toggleTimelinePlay = useCallback(() => {
    setTimelinePlayback((v) => (v === "playing" ? "paused" : "playing"));
  }, []);

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
        if (next >= lastIdx) {
          window.setTimeout(() => setTimelinePlayback("paused"), 0);
        }
        return next;
      });
    }, 450);
    return () => window.clearInterval(timer);
  }, [timelinePlayback]);

  useEffect(() => {
    if (!selectedFrame?.artifactId) return;
    if (!hasMessagesRef.current) return;
    if (shouldHoldClarificationAutoOpen(selectedFrame.artifactId)) return;
    if (shouldHoldSandboxAutoOpen(selectedFrame.artifactId, selectedFrame.data)) return;
    const panelId = defaultPanelForArtifact(selectedFrame.artifactId);
    if (!panelId) return;
    if (focusedPanelRef.current === panelId) return;
    // Keep Canvas view aligned with the selected timeline frame.
    openPanelForArtifact(selectedFrame.artifactId, { jumpToLatest: false });
  }, [openPanelForArtifact, selectedFrame?.artifactId, shouldHoldClarificationAutoOpen]);

  const placeholders = [
    "Turn raw data into clear decisions...",
    "Build an AI analyst for your team...",
    "Create reports from a simple prompt...",
    "Spot trends before they impact growth...",
    "Automate insights across your workflow...",
  ];

  // Only consider history "loading" when we're loading the chat that matches the current route.
  // This prevents the old chat UI from flashing/loading while navigation is in-flight.
  const isHistoryLoading = isChatLoading && Boolean(routeChatId) && pendingChatId === routeChatId;
  const isChatInteractionDisabled = isHistoryLoading;
  const composerPlaceholder =
    isTyping || isReconnecting || Boolean(activeRun) ? "Send a follow-up" : "Message Tuna agent...";
  const canSend =
    !isChatInteractionDisabled && (inputValue.trim().length > 0 || attachedFiles.length > 0);
  const hasMessages = messages.length > 0;
  const isSplitView = openPanels.length > 0 && isLgUp;
  const showLanding = !isHistoryLoading && !hasMessages;
  const creditsBadgeLabel = formatCreditsShort(creditsBalance, creditsLoading);

  const renderCreditsBadge = useCallback(
    (variant: "icon" | "pill") => {
      if (variant === "icon") {
        return (
          <button
            type="button"
            aria-label="View credits"
            onClick={() => openCredits()}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
              isDark
                ? "border-white/10 bg-white/5 text-white/80 hover:bg-white/10"
                : "border-black/10 bg-white/70 text-zinc-700 hover:bg-white"
            }`}
          >
            <span className="uppercase tracking-wide text-[10px]">Credits</span>
            <span className="tabular-nums font-semibold">{creditsBadgeLabel}</span>
          </button>
        );
      }
      return (
        <button
          type="button"
          aria-label="View credits"
          onClick={() => openCredits()}
          className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition-colors ${
            isDark
              ? "border-white/10 bg-white/5 text-white/80 hover:bg-white/10"
              : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-50"
          }`}
        >
          <span className="uppercase tracking-wide text-[11px]">Credits</span>
          <span
            className={`h-1 w-1 rounded-full ${isDark ? "bg-white/30" : "bg-black/25"}`}
            aria-hidden="true"
          />
          <span className="tabular-nums text-[12px] font-semibold">{creditsBadgeLabel}</span>
        </button>
      );
    },
    [creditsBadgeLabel, isDark, openCredits]
  );

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
        const sandboxOverride = dataOverrideByArtifact.get("sandbox");
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
      if (panelId === "desktop") return <DesktopArtifact dataOverride={dataOverride} />;
      if (panelId === "document") return <DocumentArtifact dataOverride={dataOverride} />;
      if (panelId === "spreadsheet") return <SpreadsheetArtifact dataOverride={dataOverride} />;
      if (panelId === "export") return <ExportArtifact dataOverride={dataOverride} />;
      if (panelId?.startsWith("clarification-")) {
        return (
          <ClarificationArtifact
            artifactId={panelId}
            onSend={(response) => handleSend(response)}
            disabled={isChatInteractionDisabled}
          />
        );
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
    [dataOverrideByArtifact, handleSend, isChatInteractionDisabled, isDark]
  );

  const activePanel = useMemo(
    () => focusedPanel ?? openPanels[openPanels.length - 1] ?? null,
    [focusedPanel, openPanels]
  );
  const canCloseCanvas = activePanel !== "desktop";

  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    let planIndex = 0;
    for (const message of messages) {
      const payload = message.role === "assistant" ? parseArtifactMessage(message.content) : null;
      if (!payload) {
        items.push({ kind: "message", message });
        continue;
      }
      if (isHiddenArtifactId(payload.id)) {
        continue;
      }

      const entry: ArtifactRenderEntry = {
        messageId: message.id,
        payload,
        planIndex: payload.id === "plan" ? planIndex++ : undefined,
      };

      const last = items[items.length - 1];
      if (last && last.kind === "artifactGroup") {
        last.entries.push(entry);
      } else {
        items.push({ kind: "artifactGroup", entries: [entry] });
      }
    }
    return items;
  }, [messages]);

  useEffect(() => {
    let latestClarification: string | null = null;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (parseArtifactMessage(message.content)) continue;
      const { payload: clarificationPayload } = extractClarificationFromMessage(message);
      if (!clarificationPayload) continue;

      const artifactId = `clarification-${message.id}`;
      if (!clarificationArtifactIdsRef.current.has(message.id)) {
        clarificationArtifactIdsRef.current.add(message.id);
        addArtifact({ id: artifactId, type: "clarification", data: clarificationPayload });
        latestClarification = artifactId;
      }
      if (!clarificationTimelineIdsRef.current.has(artifactId)) {
        const rawMessageAt =
          (message as { createdAt?: unknown }).createdAt ??
          (message as { created_at?: unknown }).created_at;
        const messageAt = pickTimelineAt(rawMessageAt, []);
        recordClarificationTimeline(artifactId, clarificationPayload, "upsert", messageAt);
        clarificationTimelineIdsRef.current.add(artifactId);
      }
    }

    if (latestClarification && isLgUp) {
      if (lastClarificationArtifactRef.current !== latestClarification) {
        lastClarificationArtifactRef.current = latestClarification;
        openPanelForArtifact(latestClarification, { jumpToLatest: false });
      }
    }
  }, [messages, addArtifact, isLgUp, openPanelForArtifact, recordClarificationTimeline]);

  const resetChatState = useCallback(() => {
    // Invalidate any in-flight history load so it can't overwrite a reset/new-chat UI.
    latestChatLoadTokenRef.current += 1;
    abortActiveStream();
    isDrainingQueueRef.current = false;
    pendingUrlChatIdRef.current = null;
    resumeChatIdRef.current = null;
    persistResumeChatId(null);
    setCurrentChatId(null);
    setCurrentChatTitle("");
    setIsCurrentChatPersisted(false);
    setIsGeneratingTitle(false);
    setMessages([]);
    hasMessagesRef.current = false;
    setInputValue("");
    setAttachedFiles([]);
    clearQueuedSends();
    setIsTyping(false);
    setShowThinkingIndicator(false);
    setContextUsage(null);
    clearThinkingTimer();
    hasStreamSignalRef.current = false;
    setIsChatLoading(false);
    setPendingChatId(null);
    setForceDraftScope(true);
    if (runPollRef.current) {
      runPollRef.current.stop();
      runPollRef.current = null;
    }
    reconnectRetryCountRef.current = 0;
    setActiveRun(null);
    setIsReconnecting(false);
    const draftScopeId = draftScopeIdRef.current;
    clearArtifactsForScope(draftScopeId);
    setSandboxCodeForScope(draftScopeId, DEFAULT_SANDBOX_CODE);
    setOpenPanels([]);
    setFocusedPanel(null);
    setCanvasTimeline([]);
    setTimelineCursor(0);
    setTimelinePlayback("paused");
    setIsCanvasDismissed(true);
    currentChatIdRef.current = null;
    artifactMessageStateRef.current.clear();
    latestArtifactSnapshotRef.current = new Map();
    clarificationArtifactIdsRef.current.clear();
    clarificationTimelineIdsRef.current.clear();
    lastClarificationArtifactRef.current = null;
    intentClarificationKeyRef.current = "";
    pendingIntentClarificationRef.current = null;
    pendingIntentClarificationKeyRef.current = "";
    streamHasClarificationRef.current = false;
  }, [
    abortActiveStream,
    clearArtifactsForScope,
    clearQueuedSends,
    clearThinkingTimer,
    persistResumeChatId,
    setForceDraftScope,
    setSandboxCodeForScope,
    setIsCanvasDismissed,
  ]);

  const loadChatFromDb = useCallback(async (chatId: string) => {
    const token = ++latestChatLoadTokenRef.current;
    abortActiveStream();
    isDrainingQueueRef.current = false;
    pendingUrlChatIdRef.current = null;
    setIsChatLoading(true);
    setPendingChatId(chatId);
    if (runPollRef.current) {
      runPollRef.current.stop();
      runPollRef.current = null;
    }
    reconnectRetryCountRef.current = 0;
    setActiveRun(null);
    setIsReconnecting(false);
    try {
      const storedClarificationResponses = new Map<string, ClarificationResponseState>();
      for (const artifact of artifacts) {
        if (!artifact?.id?.startsWith("clarification-")) continue;
        const data = artifact.data as Record<string, unknown> | null;
        if (!data || typeof data !== "object") continue;
        const response = data.response as ClarificationResponseState | undefined;
        if (response && typeof response === "object") {
          storedClarificationResponses.set(artifact.id, response);
        }
      }

      currentChatIdRef.current = chatId;

      // Reset per-chat UI immediately so we don't show stale state while loading.
      didInitialScrollRef.current = false;
      pendingInitialScrollRef.current = true;
      artifactMessageStateRef.current.clear();
      clarificationArtifactIdsRef.current.clear();
      clarificationTimelineIdsRef.current.clear();
      lastClarificationArtifactRef.current = null;
      pendingIntentClarificationRef.current = null;
      pendingIntentClarificationKeyRef.current = "";
      streamHasClarificationRef.current = false;
      setCurrentChatId(chatId);
      setMessages([]);
      hasMessagesRef.current = false;
      setInputValue("");
      setAttachedFiles([]);
      clearQueuedSends();
      setIsTyping(false);
      setShowThinkingIndicator(false);
      setContextUsage(null);
      clearThinkingTimer();
      hasStreamSignalRef.current = false;
      clearArtifacts();
      setSandboxCode(DEFAULT_SANDBOX_CODE);
      setOpenPanels([]);
      setFocusedPanel(null);
      setCanvasTimeline([]);
      setTimelineCursor(0);
      setTimelinePlayback("paused");
      setIsCanvasDismissed(true);

      const [msgs, chat, persisted, latestRun] = await Promise.all([
        db.getMessages(chatId),
        db.getChat(chatId),
        fetch(`/api/chat/state/${chatId}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        db.getActiveRun(chatId).catch(() => null),
      ]);
      // If the user navigated again while this was loading, ignore stale results.
      if (latestChatLoadTokenRef.current !== token) return;
      setActiveRun(latestRun);

      const nextMessages = ((msgs as unknown as Message[]) || []).map((m) => {
        const raw = m as Message & {
          reasoning_summary?: string;
          trace_segments?: unknown;
          reasoning_segments?: unknown;
          render_order?: unknown;
        };
        let next: Message = raw;
        if (!next.reasoningSummary && typeof raw.reasoning_summary === "string") {
          next = { ...next, reasoningSummary: raw.reasoning_summary };
        }
        const traceInput =
          Array.isArray(raw.trace_segments) ? raw.trace_segments : next.traceSegments;
        if (traceInput) {
          const normalized = normalizeTraceSegments(traceInput);
          if (normalized.length > 0) {
            next = { ...next, traceSegments: normalized };
          } else if (next.traceSegments) {
            const { traceSegments: _unused, ...rest } = next;
            next = rest as Message;
          }
        }
        const reasoningInput =
          Array.isArray(raw.reasoning_segments)
            ? raw.reasoning_segments
            : next.reasoningSegments;
        const normalizedReasoning = normalizeReasoningSegments(
          reasoningInput,
          next.reasoningSummary,
          next.id
        );
        if (normalizedReasoning.length > 0) {
          next = { ...next, reasoningSegments: normalizedReasoning };
        }
        const renderOrderRaw =
          Array.isArray(raw.render_order) ? raw.render_order : next.renderOrder;
        const normalizedOrder = normalizeRenderOrder(renderOrderRaw);
        if (normalizedOrder.length > 0) {
          next = { ...next, renderOrder: normalizedOrder };
        }
        return next;
      });

      const chatCreatedAt =
        isRecord(chat) && typeof chat.created_at === "string"
          ? chat.created_at
          : undefined;

      // Rebuild artifact-message ids from history so future upserts don't duplicate cards.
      const artifactMessageAtById = new Map<string, string>();
      const seenArtifactIds = new Set<string>();
      for (const m of nextMessages) {
        if (m.role !== "assistant") continue;
        const payload = parseArtifactMessage(m.content);
        if (payload) {
          const normalizedId = normalizeArtifactId(payload.id, payload.type);
          seenArtifactIds.add(normalizedId);
          if (!artifactMessageAtById.has(normalizedId)) {
            const messageAt = pickTimelineAt(
              (m as { created_at?: unknown }).created_at,
              [chatCreatedAt]
            );
            artifactMessageAtById.set(normalizedId, messageAt);
          }
        }
      }

      const seenClarifications = new Set<string>();
      const clarificationArtifacts: { id: string; data: ClarificationArtifactData; at: string }[] = [];
      for (const m of nextMessages) {
        if (m.role !== "assistant") continue;
        if (parseArtifactMessage(m.content)) continue;
        const { payload: clarificationPayload } = extractClarificationFromMessage(m);
        if (!clarificationPayload) continue;
        seenClarifications.add(m.id);
        const artifactId = `clarification-${m.id}`;
        const storedResponse = storedClarificationResponses.get(artifactId);
        const dataWithResponse = storedResponse
          ? { ...clarificationPayload, response: storedResponse }
          : clarificationPayload;
        const at = pickTimelineAt((m as { created_at?: unknown }).created_at, [chatCreatedAt]);
        clarificationArtifacts.push({ id: artifactId, data: dataWithResponse, at });
      }
      clarificationArtifactIdsRef.current = seenClarifications;

      let intentClarificationKey = "";
      for (const m of nextMessages) {
        if (m.role !== "assistant") continue;
        if (parseArtifactMessage(m.content)) continue;
        const { payload: clarificationPayload } = extractClarificationFromMessage(m);
        if (!clarificationPayload) continue;
        if (clarificationPayload.title !== INTENT_CLARIFICATION_TITLE) continue;
        intentClarificationKey = buildClarificationKey(clarificationPayload);
        break;
      }
      intentClarificationKeyRef.current = intentClarificationKey;

      // Hydrate artifacts from server-side agent state for THIS chat.
      const incomingArtifacts: { id: string; type: string; data: unknown; createdAt?: string; updatedAt?: string }[] = [];
      let rawTimeline: unknown[] = [];
      if (persisted && typeof persisted === "object") {
        const raw = (persisted as { artifacts?: unknown }).artifacts;
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (!item || typeof item !== "object") continue;
            const obj = item as Record<string, unknown>;
            const rawId = typeof obj.id === "string" ? obj.id : "";
            const rawType = typeof obj.type === "string" ? obj.type.trim() : "";
            const artifactType = rawType || inferArtifactTypeFromId(rawId) || "markdown";
            const normalizedId = normalizeArtifactId(rawId, artifactType);
            if (!normalizedId.trim()) continue;
            const data = obj.data ?? obj.content ?? obj.payload;
            incomingArtifacts.push({
              id: normalizedId,
              type: artifactType,
              data,
              createdAt: typeof obj.createdAt === "string" ? obj.createdAt : undefined,
              updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
            });
          }
        }

        const rawTimelineCandidate = (persisted as { canvasTimeline?: unknown }).canvasTimeline;
        if (Array.isArray(rawTimelineCandidate)) {
          rawTimeline = rawTimelineCandidate as unknown[];
        }

        const rawUsage = (persisted as { contextUsage?: unknown }).contextUsage;
        if (rawUsage && typeof rawUsage === "object") {
          const obj = rawUsage as {
            inputTokens?: unknown;
            maxInputTokens?: unknown;
            usedFraction?: unknown;
          };
          const inputTokensRaw = obj.inputTokens;
          const maxInputTokensRaw = obj.maxInputTokens;
          const usedFractionRaw = obj.usedFraction;

          const inputTokens =
            typeof inputTokensRaw === "number" && Number.isFinite(inputTokensRaw)
              ? Math.max(0, Math.floor(inputTokensRaw))
              : null;
          const maxInputTokens =
            typeof maxInputTokensRaw === "number" && Number.isFinite(maxInputTokensRaw) && maxInputTokensRaw > 0
              ? Math.floor(maxInputTokensRaw)
              : undefined;
          const usedFraction =
            typeof usedFractionRaw === "number" && Number.isFinite(usedFractionRaw)
              ? Math.max(0, Math.min(1, usedFractionRaw))
              : inputTokens !== null && maxInputTokens
                ? Math.max(0, Math.min(1, inputTokens / maxInputTokens))
                : undefined;

          if (inputTokens !== null) {
            setContextUsage({ inputTokens, maxInputTokens, usedFraction });
          }
        }
      }

      const artifactCreatedAtById = new Map<string, string>();
      const artifactUpdatedAtById = new Map<string, string>();
      const artifactDataById = new Map<string, unknown>();
      for (const a of incomingArtifacts) {
        if (!a.id.trim()) continue;
        artifactDataById.set(a.id, a.data);
        if (typeof a.createdAt === "string" && toEpochMs(a.createdAt) !== null) {
          artifactCreatedAtById.set(a.id, a.createdAt);
        }
        if (typeof a.updatedAt !== "string") continue;
        if (toEpochMs(a.updatedAt) === null) continue;
        artifactUpdatedAtById.set(a.id, a.updatedAt);
      }

      const incomingTimeline: CanvasTimelineEvent[] = [];
      rawTimeline.forEach((item, idx) => {
        if (!isRecord(item)) return;
        const artifactIdRaw = typeof item.artifactId === "string" ? item.artifactId : "";
        if (!artifactIdRaw.trim()) return;
        const artifactType = typeof item.artifactType === "string" ? item.artifactType : "markdown";
        const normalizedId = normalizeArtifactId(artifactIdRaw, artifactType);
        if (!normalizedId.trim()) return;
        const rawData = (item as { data?: unknown }).data;
        const data = rawData ?? artifactDataById.get(normalizedId);
        if (normalizedId === "sandbox") {
          if (!hasSandboxActivity(data)) return;
        }
        const at = pickTimelineAt(item.at, [
          artifactMessageAtById.get(normalizedId),
          artifactCreatedAtById.get(normalizedId),
          artifactUpdatedAtById.get(normalizedId),
          chatCreatedAt,
        ]);
        incomingTimeline.push({
          seq: typeof item.seq === "number" && Number.isFinite(item.seq) ? Math.floor(item.seq) : idx,
          at,
          kind: item.kind === "open" || item.kind === "upsert" ? item.kind : "upsert",
          artifactId: normalizedId,
          artifactType,
          data,
        });
      });

      const artifactTimelineAtById = new Map<string, string>();
      for (const event of incomingTimeline) {
        if (!event?.artifactId) continue;
        const atMs = typeof event.at === "string" ? toEpochMs(event.at) : null;
        if (atMs === null) continue;
        const prev = artifactTimelineAtById.get(event.artifactId);
        if (!prev) {
          artifactTimelineAtById.set(event.artifactId, event.at);
          continue;
        }
        const prevMs = toEpochMs(prev);
        if (prevMs === null || atMs < prevMs) {
          artifactTimelineAtById.set(event.artifactId, event.at);
        }
      }

      const nextArtifactMessageState = new Map<string, string>();
      for (const a of incomingArtifacts) {
        nextArtifactMessageState.set(a.id, getArtifactDataKey(a.data));
      }

      const missingArtifacts = incomingArtifacts
        .filter((a) => !seenArtifactIds.has(a.id) && !isHiddenArtifactId(a.id))
        .map((a) => {
          const at = pickTimelineAt(artifactTimelineAtById.get(a.id), [
            artifactCreatedAtById.get(a.id),
            artifactUpdatedAtById.get(a.id),
            chatCreatedAt,
          ]);
          return { ...a, at };
        })
        .sort((a, b) => {
          const ta = toEpochMs(a.at) ?? Number.POSITIVE_INFINITY;
          const tb = toEpochMs(b.at) ?? Number.POSITIVE_INFINITY;
          if (ta !== tb) return ta - tb;
          return a.id.localeCompare(b.id);
        });

      const insertMessageByTime = (message: Message, at: string) => {
        const target = toEpochMs(at);
        if (target === null) {
          nextMessages.push(message);
          return;
        }
        let insertAt = nextMessages.length;
        for (let i = 0; i < nextMessages.length; i += 1) {
          const existingTs = getMessageEpochMs(nextMessages[i]);
          if (existingTs === null) continue;
          if (existingTs > target) {
            insertAt = i;
            break;
          }
        }
        nextMessages.splice(insertAt, 0, message);
      };

      if (missingArtifacts.length > 0) {
        for (const a of missingArtifacts) {
          insertMessageByTime(
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: encodeArtifactMessage({ id: a.id, type: a.type }),
              createdAt: a.at,
            },
            a.at
          );
          seenArtifactIds.add(a.id);
        }
      }

      // Repair ordering for legacy artifact-messages that were persisted with a late `created_at`.
      // We never move an artifact message *later* than its DB timestamp; we only move it earlier
      // based on the persisted canvas timeline for that artifact.
      const upsertTimelineAtsByArtifactId = new Map<string, string[]>();
      for (const evt of incomingTimeline) {
        if (!evt?.artifactId) continue;
        if (evt.kind !== "upsert") continue;
        const ms = typeof evt.at === "string" ? toEpochMs(evt.at) : null;
        if (ms === null) continue;
        const list = upsertTimelineAtsByArtifactId.get(evt.artifactId) ?? [];
        list.push(evt.at);
        upsertTimelineAtsByArtifactId.set(evt.artifactId, list);
      }
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
      const repairedMessages = nextMessages
        .map((message, idx) => {
          const baseMs = getMessageEpochMs(message);
          let effectiveMs = baseMs ?? Number.POSITIVE_INFINITY;

          const payload =
            message.role === "assistant" && typeof message.content === "string"
              ? parseArtifactMessage(message.content)
              : null;
          if (payload) {
            const normalizedId = normalizeArtifactId(payload.id, payload.type);
            const ats = upsertTimelineAtsByArtifactId.get(normalizedId);
            if (ats && ats.length > 0) {
              const cursor = artifactMsgCursorById.get(normalizedId) ?? 0;
              artifactMsgCursorById.set(normalizedId, cursor + 1);
              const assignedAt = ats[Math.min(cursor, ats.length - 1)];
              const assignedMs = toEpochMs(assignedAt);
              if (assignedMs !== null) {
                // Only move earlier (never later).
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
        })
        .map((entry) => entry.message);

      const hydratedMessages = (() => {
        if (
          !shouldShowInterruptedRunPrompt({
            messages: repairedMessages,
            hasActiveRun: Boolean(latestRun),
          })
        ) {
          return repairedMessages;
        }
        const latestMs = repairedMessages.reduce((max, message) => {
          const ts = getMessageEpochMs(message);
          return ts !== null ? Math.max(max, ts) : max;
        }, Date.now());
        return [
          ...repairedMessages,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: INTERRUPTED_RUN_PROMPT_MESSAGE,
            createdAt: new Date(latestMs + 1).toISOString(),
          },
        ];
      })();

      setMessages(hydratedMessages);
      hasMessagesRef.current = hydratedMessages.length > 0;
      setCurrentChatTitle(chat?.title || "");
      setIsCurrentChatPersisted(true);
      setIsGeneratingTitle(false);
      setInputValue("");
      setAttachedFiles([]);
      artifactMessageStateRef.current = nextArtifactMessageState;

      for (const a of incomingArtifacts) {
        addArtifact({ id: a.id, type: a.type, data: a.data });
      }
      for (const clarification of clarificationArtifacts) {
        addArtifact({ id: clarification.id, type: "clarification", data: clarification.data });
      }

      // Prefer the latest artifact referenced in chat history.
      let latestArtifactIdFromHistory: string | null = null;
      for (const m of nextMessages) {
        if (m.role !== "assistant") continue;
        const payload = parseArtifactMessage(m.content);
        if (payload) {
          const normalized = normalizeArtifactId(payload.id, payload.type);
          if (!isHiddenArtifactId(normalized)) {
            if (normalized === "sandbox" && !hasSandboxActivity(artifactDataById.get(normalized))) {
              continue;
            }
            latestArtifactIdFromHistory = normalized;
          }
          continue;
        }
        const { payload: clarificationPayload } = extractClarificationFromMessage(m);
        if (clarificationPayload) {
          latestArtifactIdFromHistory = `clarification-${m.id}`;
        }
      }

      // Open the latest artifact for this chat (best-effort by updatedAt).
      let latestArtifactId: string | null = null;
      let latestTs = -1;
      for (const a of incomingArtifacts) {
        if (isHiddenArtifactId(a.id)) continue;
        if (a.id === "sandbox" && !hasSandboxActivity(artifactDataById.get(a.id))) continue;
        const t = Date.parse(a.updatedAt ?? "");
        const ts = Number.isFinite(t) ? t : 0;
        if (ts >= latestTs) {
          latestTs = ts;
          latestArtifactId = a.id;
        }
      }
      if (!latestArtifactId && incomingArtifacts.length > 0) {
        for (let i = incomingArtifacts.length - 1; i >= 0; i -= 1) {
          const candidate = incomingArtifacts[i].id;
          if (!isHiddenArtifactId(candidate)) {
            if (candidate === "sandbox" && !hasSandboxActivity(artifactDataById.get(candidate))) {
              continue;
            }
            latestArtifactId = candidate;
            break;
          }
        }
      }

      const finalLatestArtifact =
        latestArtifactIdFromHistory ||
        latestArtifactId;

      const timelineWithClarifications = (() => {
        const out = [...incomingTimeline];
        const knownIds = new Set(out.map((item) => item.artifactId));
        for (const clarification of clarificationArtifacts) {
          if (knownIds.has(clarification.id)) continue;
          out.push({
            seq: out.length,
            at: clarification.at,
            kind: "upsert",
            artifactId: clarification.id,
            artifactType: "clarification",
            data: clarification.data,
          });
          knownIds.add(clarification.id);
        }
        clarificationTimelineIdsRef.current = knownIds;
        return out;
      })();

      const sortedTimeline = sortTimelineByAt(timelineWithClarifications);
      setCanvasTimeline(sortedTimeline);

      const timelineLatest =
        sortedTimeline.length > 0
          ? sortedTimeline[sortedTimeline.length - 1]?.artifactId
          : null;
      const preferredLatest =
        latestArtifactIdFromHistory?.startsWith("clarification-")
          ? latestArtifactIdFromHistory
          : (timelineLatest || finalLatestArtifact);
      const preferredIdx = preferredLatest
        ? (() => {
            for (let i = sortedTimeline.length - 1; i >= 0; i -= 1) {
              if (sortedTimeline[i]?.artifactId === preferredLatest) return i;
            }
            return null;
          })()
        : null;
      const lastTimelineIdx = sortedTimeline.length > 0 ? sortedTimeline.length - 1 : 0;
      setTimelineCursor(preferredIdx ?? lastTimelineIdx);
      setTimelinePlayback("paused");

      if (preferredLatest) {
        openPanelForArtifact(preferredLatest, { jumpToLatest: false });
        if (preferredLatest.startsWith("clarification-")) {
          lastClarificationArtifactRef.current = preferredLatest;
        }
      } else {
        setActiveArtifact(null);
        setOpenPanels([]);
        setFocusedPanel(null);
        setIsCanvasDismissed(true);
      }
    } catch (error) {
      console.error("Failed to load history:", error);
    } finally {
      if (latestChatLoadTokenRef.current === token) {
        setIsChatLoading(false);
        setPendingChatId(null);
      }
    }
  }, [
    abortActiveStream,
    addArtifact,
    clearArtifacts,
    clearQueuedSends,
    clearThinkingTimer,
    modelPreset,
    setActiveArtifact,
    setSandboxCode,
    setIsCanvasDismissed,
    artifacts,
  ]);

  // Resume the latest chat on / when the URL isn't specific yet.
  useEffect(() => {
    if (routeChatId) {
      resumeAttemptedRef.current = true;
      return;
    }
    if (currentChatIdRef.current || currentChatId) return;
    if (resumeAttemptedRef.current) return;
    const storedChatId = readResumeChatId();
    resumeAttemptedRef.current = true;
    if (!storedChatId) return;
    resumeChatIdRef.current = storedChatId;
    void loadChatFromDb(storedChatId);
  }, [currentChatId, loadChatFromDb, routeChatId]);

  // Keep state in sync with URL: / -> new chat, /:id -> load chat.
  // Avoid wiping the first message while a new chat is pending a URL update.
  useEffect(() => {
    if (!routeChatId) {
      if (currentChatIdRef.current && !pendingUrlChatIdRef.current) {
        if (
          resumeChatIdRef.current &&
          resumeChatIdRef.current === currentChatIdRef.current
        ) {
          return;
        }
        resetChatState();
      }
      return;
    }

    resumeChatIdRef.current = null;
    if (routeChatId === currentChatIdRef.current) return;
    void loadChatFromDb(routeChatId);
  }, [routeChatId, loadChatFromDb, resetChatState]);

  useEffect(() => {
    if (routeChatId) {
      persistResumeChatId(null);
      resumeChatIdRef.current = null;
      return;
    }
    if (currentChatId) {
      persistResumeChatId(currentChatId);
      return;
    }
    persistResumeChatId(null);
  }, [currentChatId, persistResumeChatId, routeChatId]);

  useEffect(() => {
    if (runPollRef.current) {
      runPollRef.current.stop();
      runPollRef.current = null;
    }
    setIsRunPolling(false);
    if (!currentChatId || !activeRun) {
      setIsReconnecting(false);
      reconnectRetryCountRef.current = 0;
      return;
    }
    reconnectRetryCountRef.current = 0;
    let cancelled = false;

    const checkActiveRun = async () => {
      const chatId = currentChatIdRef.current;
      if (!chatId || chatId !== currentChatId) return;

      // Check if we've exceeded the max retry limit
      if (reconnectRetryCountRef.current >= MAX_RECONNECT_RETRIES) {
        console.warn("Max reconnect retries reached, giving up polling.");
        if (runPollRef.current) {
          runPollRef.current.stop();
          runPollRef.current = null;
        }
        if (!cancelled) {
          setActiveRun(null);
          setIsReconnecting(false);
          void loadChatFromDb(chatId);
        }
        return;
      }

      try {
        const latest = await db.getActiveRun(chatId);
        // Reset backoff on successful API call
        runPollRef.current?.success();
        reconnectRetryCountRef.current = 0;

        if (latest) {
          // If we were using a local placeholder run id, replace it with the server run.
          if (latest.id !== activeRun.id && !cancelled) {
            setActiveRun(latest);
          }
          return;
        }

        // Run completed – stop polling, reload chat
        if (runPollRef.current) {
          runPollRef.current.stop();
          runPollRef.current = null;
        }
        if (cancelled) return;
        setActiveRun(null);
        setIsReconnecting(false);
        // Notify other tabs that this run completed
        broadcastSync("run-completed", { chatId, runId: activeRun.id });
        broadcastSync("chat-updated", { chatId });
        void loadChatFromDb(chatId);
      } catch (error) {
        console.error("Failed to poll active run:", error);
        reconnectRetryCountRef.current++;
        // Signal failure for exponential backoff
        runPollRef.current?.failure();
      }
    };

    const poll = createSmartPoll(checkActiveRun, {
      baseInterval: 2500,
      maxInterval: 15_000,
      pauseWhenHidden: true,
      immediate: true,
    });
    runPollRef.current = poll;
    poll.start();
    setIsRunPolling(true);

    return () => {
      cancelled = true;
      if (runPollRef.current) {
        runPollRef.current.stop();
        runPollRef.current = null;
      }
    };
  }, [activeRun, currentChatId, loadChatFromDb]);

  // ── Connection manager: visibility, online/offline, and cross-tab sync ──
  const { isOnline, isVisible } = useConnectionManager({
    onVisibilityRestore: () => {
      // When the tab becomes visible again, refresh data to catch up.
      const chatId = currentChatIdRef.current;
      if (chatId) {
        // If we have an active run, force an immediate poll check
        if (runPollRef.current) {
          runPollRef.current.forceNow();
        } else if (!isTyping && !activeRun && !isReconnecting) {
          // No active stream or run: reload messages in case something changed while hidden
          void loadChatFromDb(chatId);
        }
      }
      // Refresh credits
      void loadCredits();
    },
    onOnline: () => {
      // On reconnection, force immediate poll if we have an active run
      if (runPollRef.current) {
        runPollRef.current.forceNow();
      }
      // Reload current chat to sync any missed updates
      const chatId = currentChatIdRef.current;
      if (chatId && !isTyping && !activeRun && !isReconnecting) {
        void loadChatFromDb(chatId);
      }
    },
    onSyncEvent: (event: SyncEvent) => {
      const chatId = currentChatIdRef.current;
      switch (event.type) {
        case "chat-updated":
          // Another tab's chat was updated; if it's our current chat, refresh messages
          if (event.chatId && event.chatId === chatId && !isTyping && !activeRun && !isReconnecting) {
            void loadChatFromDb(event.chatId);
          }
          break;
        case "run-completed":
          // Another tab detected a run completed; if it's our current chat, clear reconnecting state
          if (event.chatId && event.chatId === chatId) {
            setActiveRun(null);
            setIsReconnecting(false);
            if (runPollRef.current) {
              runPollRef.current.stop();
              runPollRef.current = null;
            }
            void loadChatFromDb(event.chatId);
          }
          break;
        case "run-started":
          // Another tab started a run; if it's our current chat, start polling.
          if (event.chatId && event.chatId === chatId && !isTyping) {
            // Check for the run to start polling
            void (async () => {
              try {
                const run = await db.getActiveRun(event.chatId!);
                if (run) {
                  setActiveRun(run);
                }
              } catch {
                // ignore
              }
            })();
          }
          break;
        case "credits-changed":
          void loadCredits();
          break;
        case "force-refresh":
          if (chatId && !isTyping && !activeRun && !isReconnecting) {
            void loadChatFromDb(chatId);
          }
          break;
      }
    },
  });

  // Rotate placeholders in the new-chat landing state.
  useEffect(() => {
    if (!showLanding || inputValue) return;
    const timer = window.setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % placeholders.length);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [inputValue, placeholders.length, showLanding]);

  // Persist model selector preference
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("tuna.modelPreset");
      if (raw === "tuna_1_fast" || raw === "tuna_1" || raw === "tuna_1_high") {
        setModelPreset(raw);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("tuna.modelPreset", modelPreset);
    } catch {
      // ignore
    }
  }, [modelPreset]);

  // Hydrate theme preference (light/dark/system)
  useLayoutEffect(() => {
    try {
      const raw =
        window.localStorage.getItem(THEME_STORAGE_KEY) ??
        document.cookie
          .split("; ")
          .find((part) => part.startsWith(`${THEME_STORAGE_KEY}=`))
          ?.split("=")[1];
      const pref: ThemePreference = raw === "dark" || raw === "light" || raw === "system" ? raw : "light";
      setThemePreference(pref);

      if (pref === "dark") setIsDark(true);
      else if (pref === "light") setIsDark(false);
      else {
        try {
          setIsDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
        } catch {
          setIsDark(false);
        }
      }
    } catch {
      // ignore
    }
    setIsThemeHydrated(true);
  }, []);

  useEffect(() => {
    if (!isThemeHydrated) return;
    const pref = themePreference;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch {
      // ignore
    }
    try {
      // Also store as a cookie so the preference can be reused outside this page.
      // `max-age`: 1 year
      document.cookie = `${THEME_STORAGE_KEY}=${pref}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      // ignore
    }
  }, [isThemeHydrated, themePreference]);

  // Resolve "system" theme preference (and keep it updated).
  useEffect(() => {
    if (!isThemeHydrated) return;

    if (themePreference === "dark") {
      setIsDark(true);
      return;
    }

    if (themePreference === "light") {
      setIsDark(false);
      return;
    }

    try {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      setIsDark(mql.matches);
      const onChange = (event: MediaQueryListEvent) => setIsDark(event.matches);
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      if (typeof mql.addListener === "function") {
        mql.addListener(onChange);
        return () => mql.removeListener(onChange);
      }
    } catch {
      // ignore
    }
  }, [isThemeHydrated, themePreference]);

  const applyThemePreference = useCallback((next: ThemePreference) => {
    setThemePreference(next);
    if (next === "dark") {
      setIsDark(true);
      return;
    }
    if (next === "light") {
      setIsDark(false);
      return;
    }
    try {
      setIsDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch {
      setIsDark(false);
    }
  }, []);

  // Close model selector on outside click / escape
  useEffect(() => {
    if (!modelSelectorOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = modelSelectorRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        setModelSelectorOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelSelectorOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelSelectorOpen]);

  useEffect(() => {
    if (!attachMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const isInLandingMenu = Boolean(landingAttachMenuRef.current?.contains(target));
      const isInChatMenu = Boolean(chatAttachMenuRef.current?.contains(target));
      if (!isInLandingMenu && !isInChatMenu) {
        setAttachMenuOpen(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAttachMenuOpen(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  // On refresh/navigation, always start at the bottom of the chat (not the top).
  useEffect(() => {
    try {
      if ("scrollRestoration" in window.history) {
        window.history.scrollRestoration = "manual";
      }
    } catch {
      // ignore
    }
  }, []);

  // Reset initial-scroll guard when switching chats via URL.
  // Use a layout effect so it runs before any scroll-to-bottom layout effects.
  useLayoutEffect(() => {
    if (routeChatId && routeChatId === currentChatIdRef.current) return;
    didInitialScrollRef.current = false;
    pendingInitialScrollRef.current = true;
  }, [routeChatId]);

  // Make chat switching feel instantaneous and safe:
  // - stop any in-flight streams from the previous chat
  // - mark history loading immediately so input is disabled during navigation
  useLayoutEffect(() => {
    if (!routeChatId) return;
    if (routeChatId === currentChatIdRef.current) return;
    abortActiveStream();
    setIsTyping(false);
    setShowThinkingIndicator(false);
    clearThinkingTimer();
    hasStreamSignalRef.current = false;
    setIsChatLoading(true);
    setPendingChatId(routeChatId);
  }, [abortActiveStream, clearThinkingTimer, routeChatId]);

  // When navigating between chats, immediately clear/dismiss any persisted artifacts
  // so we don't flash a stale Canvas from a different chat.
  useLayoutEffect(() => {
    if (routeChatId && routeChatId === currentChatIdRef.current) return;
    clearArtifacts();
    setSandboxCode(DEFAULT_SANDBOX_CODE);
    setOpenPanels([]);
    setFocusedPanel(null);
    setCanvasTimeline([]);
    setTimelineCursor(0);
    setTimelinePlayback("paused");
    setIsCanvasDismissed(true);
  }, [routeChatId, clearArtifacts, setSandboxCode]);

  // We clear artifacts on navigation to avoid showing stale Canvas content.
  // When the chat finishes loading, we hydrate artifacts for that chat and open the latest one.

  useEffect(() => {
    if (openPanels.length > 0) {
      setIsCanvasDismissed(false);
      return;
    }
    setIsCanvasDismissed(true);
    showChatOnMobile();
  }, [openPanels.length, showChatOnMobile]);

  const closeCanvas = () => {
    if (!isLgUp) {
      showChatOnMobile();
      return;
    }
    setActiveArtifact(null);
    setOpenPanels([]);
    setFocusedPanel(null);
    setIsCanvasDismissed(true);
    setTimelinePlayback("paused");
    setIsCanvasLoading(false);
  };

  const attemptInitialScrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      if (didInitialScrollRef.current) return true;
      if (!pendingInitialScrollRef.current) return false;
      if (messages.length === 0 && !isTyping) return false;
      // Only scroll once the loaded chat state matches the route param; otherwise we'd
      // scroll the previous chat's DOM during the transition.
      if (routeChatId && currentChatId !== routeChatId) return false;

      const el = messagesScrollRef.current;
      if (!el) return false;

      el.scrollTop = el.scrollHeight;
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });

      didInitialScrollRef.current = true;
      pendingInitialScrollRef.current = false;
      stickToBottomRef.current = true;
      return true;
    },
    [messages.length, isTyping, routeChatId, currentChatId]
  );

  const forceScrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    stickToBottomRef.current = true;
    window.requestAnimationFrame(() => {
      const el = messagesScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }, []);

  const connectionBannerMode: ConnectionBannerMode = isReconnecting
    ? "reconnecting"
    : activeRun
      ? "running"
      : null;
  const isAgentViewOpen = openPanels.length > 0 && (isLgUp || mobilePane === "canvas");
  const isAgentViewLive = isAgentViewOpen && isLive;
  const hasAgentViewTarget = canvasTimeline.length > 0 || Boolean(activeArtifact);
  const canGoToAgentView = !isAgentViewOpen && hasAgentViewTarget;
  const canCheckAgentNow = isRunPolling;
  const requestedConnectionBannerMode: ConnectionBannerMode = isAgentViewLive
    ? null
    : connectionBannerMode;
  const shouldShowBannerActions = canGoToAgentView || canCheckAgentNow;

  useEffect(() => {
    const clearTimers = () => {
      if (bannerShowTimerRef.current !== null) {
        window.clearTimeout(bannerShowTimerRef.current);
        bannerShowTimerRef.current = null;
      }
      if (bannerHideTimerRef.current !== null) {
        window.clearTimeout(bannerHideTimerRef.current);
        bannerHideTimerRef.current = null;
      }
    };

    clearTimers();

    // Switch between "running" and "reconnecting" immediately.
    if (
      requestedConnectionBannerMode &&
      visibleConnectionBannerMode &&
      requestedConnectionBannerMode !== visibleConnectionBannerMode
    ) {
      setVisibleConnectionBannerMode(requestedConnectionBannerMode);
      return clearTimers;
    }

    if (!requestedConnectionBannerMode) {
      // Debounce hide to avoid flicker during quick state transitions.
      if (visibleConnectionBannerMode) {
        bannerHideTimerRef.current = window.setTimeout(() => {
          setVisibleConnectionBannerMode(null);
          bannerHideTimerRef.current = null;
        }, 450);
      }
      return clearTimers;
    }

    if (!visibleConnectionBannerMode) {
      // Debounce show so the banner doesn't spam on transient states.
      bannerShowTimerRef.current = window.setTimeout(() => {
        setVisibleConnectionBannerMode(requestedConnectionBannerMode);
        bannerShowTimerRef.current = null;
      }, 300);
      return clearTimers;
    }

    setVisibleConnectionBannerMode(requestedConnectionBannerMode);
    return clearTimers;
  }, [requestedConnectionBannerMode, visibleConnectionBannerMode]);

  const goToAgentNow = useCallback(() => {
    revealCanvasOnMobile();
    // Open the last-known agent "canvas" view (if any).
    const t = canvasTimelineRef.current;
    if (t.length > 0) {
      jumpToLive();
    } else {
      const fallbackArtifact = activeArtifactRef.current;
      if (fallbackArtifact) {
        openPanelForArtifact(fallbackArtifact);
      }
    }

    // Ensure the user is at the latest chat output.
    forceScrollToBottom("smooth");
  }, [forceScrollToBottom, jumpToLive, openPanelForArtifact, revealCanvasOnMobile]);

  const checkAgentNow = useCallback(() => {
    if (runPollRef.current) {
      runPollRef.current.forceNow();
      return;
    }
    const chatId = currentChatIdRef.current;
    if (!chatId) return;
    if (isTyping || activeRun || isReconnecting) return;
    void loadChatFromDb(chatId);
  }, [activeRun, isReconnecting, isTyping, loadChatFromDb]);

  const setMessagesScrollEl = useCallback(
    (node: HTMLDivElement | null) => {
      messagesScrollRef.current = node;
      setMessagesScrollElState(node);
      if (node) attemptInitialScrollToBottom("auto");
    },
    [attemptInitialScrollToBottom]
  );

  const setMessagesEndEl = useCallback(
    (node: HTMLDivElement | null) => {
      messagesEndRef.current = node;
      if (node) attemptInitialScrollToBottom("auto");
    },
    [attemptInitialScrollToBottom]
  );

  // Ensure we scroll to bottom after history loads, even when the chat UI is entering
  // (AnimatePresence mode="wait" can delay mounting the scroll container).
  useLayoutEffect(() => {
    attemptInitialScrollToBottom("auto");
  }, [attemptInitialScrollToBottom]);

  // Keep the chat pinned to bottom when:
  // - the user is already at/near the bottom, AND
  // - the container resizes (e.g., Canvas opening changes width and causes text reflow).
  useEffect(() => {
    const el = messagesScrollEl;
    if (!el) return;

    const computeDistanceFromBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const thresholdPx = 80;

    const updateStickiness = () => {
      stickToBottomRef.current = computeDistanceFromBottom() <= thresholdPx;
    };

    updateStickiness();
    el.addEventListener("scroll", updateStickiness, { passive: true });

    const ro = new ResizeObserver(() => {
      // If the user is at the bottom (or we're still doing the initial bottom scroll),
      // keep them pinned as the layout animates.
      if (!stickToBottomRef.current && !pendingInitialScrollRef.current) return;
      window.requestAnimationFrame(() => {
        const node = messagesScrollRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
        messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
        stickToBottomRef.current = true;
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", updateStickiness);
    };
  }, [messagesScrollEl, routeChatId]);

  useEffect(() => {
    if (!didInitialScrollRef.current) return;
    // If the user was already at/near the bottom, keep them pinned even when the
    // new content is taller than our "near bottom" threshold.
    if (!stickToBottomRef.current && !pendingInitialScrollRef.current) return;

    const behavior: ScrollBehavior = isTyping ? "auto" : "smooth";
    window.requestAnimationFrame(() => {
      const el = messagesScrollRef.current;
      if (!el) return;
      // Re-check in case the user scrolls between render and the frame callback.
      if (!stickToBottomRef.current && !pendingInitialScrollRef.current) return;
      el.scrollTop = el.scrollHeight;
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
      stickToBottomRef.current = true;
    });
  }, [messages, isTyping]);

  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [inputValue]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newFiles: PendingFile[] = Array.from(files).map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      size: f.size,
      mimeType: f.type || undefined,
      file: f,
      uploadStatus: "pending",
    }));
    setAttachedFiles((prev) => [...prev, ...newFiles]);
    e.target.value = "";
  };

  const uploadFilesToStorage = useCallback(
    async (chatId: string, files: PendingFile[]): Promise<MessageFile[]> => {
      if (files.length === 0) return [];
      setIsUploadingFiles(true);
      try {
        const results: MessageFile[] = [];
        for (const file of files) {
          // Storage-backed attachment: no upload needed.
          if (file.storagePath && file.uploadStatus === "ready") {
            results.push({
              id: file.id,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              storagePath: file.storagePath,
              uploadStatus: "ready",
            });
            continue;
          }
          if (!file.file) {
            results.push({
              id: file.id,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              uploadStatus: "error",
              error: "Missing local file content",
            });
            continue;
          }
          const formData = new FormData();
          formData.append("chatId", chatId);
          formData.append("fileId", file.id);
          formData.append("file", file.file, file.name);
          formData.append("fileName", file.name);
          if (file.mimeType) formData.append("mimeType", file.mimeType);
          try {
            const response = await fetch("/api/storage/upload", {
              method: "POST",
              body: formData,
            });
            if (!response.ok) {
              const payload = await response.json().catch(() => null);
              const message =
                typeof payload?.error === "string"
                  ? payload.error
                  : `Upload failed (${response.status})`;
              results.push({
                id: file.id,
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                uploadStatus: "error",
                error: message,
              });
              continue;
            }
            const payload = await response.json().catch(() => null);
            const storagePath =
              typeof payload?.storagePath === "string" ? payload.storagePath : "";
            if (!storagePath) {
              results.push({
                id: file.id,
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                uploadStatus: "error",
                error: "Upload failed",
              });
              continue;
            }
            results.push({
              id: file.id,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              storagePath,
              uploadStatus: "ready",
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Upload failed";
            results.push({
              id: file.id,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              uploadStatus: "error",
              error: message,
            });
          }
        }
        return results;
      } finally {
        setIsUploadingFiles(false);
      }
    },
    []
  );

  const removeFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const attachFromDrawer = useCallback(
    (file: { id: string; name: string; size: number; mimeType?: string; storagePath: string }) => {
      if (!file.storagePath) return;
      setAttachedFiles((prev) => {
        const already = prev.some((f) => f.storagePath && f.storagePath === file.storagePath);
        if (already) return prev;
        return [
          ...prev,
          {
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            storagePath: file.storagePath,
            uploadStatus: "ready",
          },
        ];
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    []
  );

  const openFilesDrawer = useCallback(() => setIsFilesDrawerOpen(true), []);
  const closeFilesDrawer = useCallback(() => setIsFilesDrawerOpen(false), []);

  const handleNewChat = () => {
    setIsMobileSidebarOpen(false);
    resetChatState();
    if (pathname !== "/") router.push("/", { scroll: false });
  };

  async function handleSend(
    overrideContent?: string,
    options?: {
      files?: PendingFile[];
      clearComposer?: boolean;
      source?: "input" | "clarification";
      fromQueue?: boolean;
    }
  ) {
    if (isChatInteractionDisabled) return;
    const messageContent = overrideContent ?? inputValue;
    const files = options?.files ?? attachedFiles;
    const source = options?.source ?? (overrideContent === undefined ? "input" : "clarification");
    const clearComposer = options?.clearComposer ?? true;
    const fromQueue = options?.fromQueue === true;

    if (!messageContent.trim() && files.length === 0) return;

    // If the user continues the conversation via the chat input (instead of submitting
    // the clarification card), lock any pending clarification artifacts so they're no longer editable.
    // (The user can still continue the convo normally.)
    if (source === "input") {
      const nowIso = new Date().toISOString();
      for (const artifact of artifacts) {
        if (!artifact?.id?.startsWith("clarification-")) continue;
        if (!isRecord(artifact.data)) continue;
        const response = (artifact.data as Record<string, unknown>).response;
        const answeredAt =
          isRecord(response) && typeof response.answeredAt === "string"
            ? response.answeredAt
            : "";
        if (answeredAt.trim()) continue;

        const skippedResponse: ClarificationResponseState = {
          answers: {},
          customAnswers: {},
          notes: "Skipped: user continued conversation without submitting clarification answers.",
          responseText: "Skipped: user continued conversation without submitting clarification answers.",
          answeredAt: nowIso,
        };

        addArtifact({
          id: artifact.id,
          type: "clarification",
          data: { ...(artifact.data as Record<string, unknown>), response: skippedResponse },
        });
      }
    }

    const isBusy =
      isTyping ||
      Boolean(streamAbortRef.current) ||
      isReconnecting ||
      Boolean(activeRun) ||
      isUploadingFiles ||
      isDrainingQueueRef.current;

    if (isBusy && !fromQueue) {
      enqueueQueuedSend({
        id: crypto.randomUUID(),
        content: messageContent,
        files: files.map((file) => ({ ...file })),
        enqueuedAt: new Date().toISOString(),
        source,
      });
      setInputValue("");
      setAttachedFiles([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    // Invalidate any in-flight stream (even within the same chatId).
    // This prevents an aborted/older stream from toggling UI state (typing/canvas) after a new send.
    streamGenerationRef.current += 1;
    const streamGeneration = streamGenerationRef.current;

    // Only the *first* message of a brand-new chat should default to "no canvas open".
    // After that, don't force-close the Canvas on every user send (it can remain open),
    // and the agent can still update it via ui_open/ui_upsert frames.
    const shouldDefaultCanvasClosed = messages.length === 0;
    if (shouldDefaultCanvasClosed) {
      setActiveArtifact(null);
      // Hard reset per-chat Canvas UI so we never leak the previous chat's panels/timeline
      // into a brand-new conversation.
      setOpenPanels([]);
      setFocusedPanel(null);
      setCanvasTimeline([]);
      setTimelineCursor(0);
      setIsCanvasDismissed(true);
      setIsCanvasLoading(false);
    } else {
      // If the user currently has a Canvas open, avoid showing stale/unfinished content while
      // we wait for the first new ui_upsert/ui_open frame from this run.
      setIsCanvasLoading(Boolean(activeArtifactRef.current));
      {
        const t = canvasTimelineRef.current;
        if (t.length > 0) setTimelineCursor(t.length - 1);
      }
    }
    setTimelinePlayback("paused");

    // Ensure each chat has a stable unique id (even if DB persistence fails)
    let chatId = currentChatId;
    let canPersist = isCurrentChatPersisted;

    if (!chatId) {
      chatId = crypto.randomUUID();
      currentChatIdRef.current = chatId;
      pendingUrlChatIdRef.current = chatId;
      setCurrentChatId(chatId);
      setCurrentChatTitle("New chat");
      setIsCurrentChatPersisted(false);
      canPersist = false;
      migrateArtifactScope(draftScopeIdRef.current, chatId, { onlyIfTargetEmpty: true });

      if (!routeChatId) {
        persistResumeChatId(chatId);
      }

      // IMPORTANT: don't change the URL mid-stream (it can remount the dynamic route segment
      // and interrupt streaming). We'll promote the URL after the stream finishes.
    }

    let lastMessageCreatedAt = Date.now();
    const nextMessageCreatedAt = () => {
      const now = Date.now();
      lastMessageCreatedAt = Math.max(lastMessageCreatedAt + 1, now);
      return new Date(lastMessageCreatedAt).toISOString();
    };

    // When we *visually* insert a message "before" the current assistant bubble (e.g. an artifact card
    // emitted before any assistant text/status appears), we must also timestamp it before that assistant
    // message. Otherwise, DB ordering by `created_at` will move it to the end on reload.
    //
    // We do this by generating ISO timestamps that are a few microseconds before an anchor ISO time.
    // Postgres `timestamptz` preserves microseconds; JS `Date` only has milliseconds, but that's fine—
    // we only need stable ordering on the server.
    let insertBeforeMicros = 999; // counts down so earlier inserts sort first
    const nextCreatedAtBefore = (anchorIso: string) => {
      const anchorMs = Date.parse(anchorIso);
      if (!Number.isFinite(anchorMs)) return anchorIso;
      const microsBefore = Math.max(1, Math.min(999, Math.floor(insertBeforeMicros)));
      insertBeforeMicros = Math.max(1, insertBeforeMicros - 1);
      const base = new Date(anchorMs - 1).toISOString(); // ... .sssZ (one millisecond before)
      const extra = String(1000 - microsBefore).padStart(3, "0"); // append microseconds within that ms
      return base.replace(/Z$/, `${extra}Z`);
    };

    const userMessageCreatedAt = nextMessageCreatedAt();
    const uploadedFiles = files.length > 0 ? await uploadFilesToStorage(chatId, files) : [];
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: messageContent,
      files: uploadedFiles.length > 0 ? uploadedFiles : undefined,
      createdAt: userMessageCreatedAt,
    };

    setMessages((prev) => [...prev, userMessage]);
    hasMessagesRef.current = true;
    forceScrollToBottom("auto");
    if (clearComposer) {
      setInputValue("");
      setAttachedFiles([]);
    }
    setIsTyping(true);
    scheduleThinkingIndicator();
    abortActiveStream();

    const streamChatId = chatId;
    const isActiveStream = () =>
      currentChatIdRef.current === streamChatId &&
      streamGenerationRef.current === streamGeneration;
    const streamArtifactMessageState = new Map(artifactMessageStateRef.current);

    // Try to persist chat (once) so we can save messages + titles
    if (chatId && !canPersist) {
      try {
        await db.createChat("New chat", { id: chatId });
        setIsCurrentChatPersisted(true);
        canPersist = true;
        broadcastSync("chat-created", { chatId });
      } catch (e) {
        console.error("Failed to create chat", e);
        setIsCurrentChatPersisted(false);
        canPersist = false;
      }
    }

    if (chatId && canPersist) {
      void db
        .upsertMessage({
          id: userMessage.id,
          chatId,
          role: "user",
          content: userMessage.content,
          files: userMessage.files,
          status: userMessage.status,
          createdAt: userMessage.createdAt,
        })
        .catch((err) => {
          console.error("Failed to persist user message", err);
        });
    }

    // Generate a workload title (async; don't block chat response)
    const shouldGenerateTitle = Boolean(
      chatId &&
      !isGeneratingTitle &&
      (!currentChatTitle || currentChatTitle.trim().length === 0 || currentChatTitle === "New chat")
    );
    if (chatId && shouldGenerateTitle) {
      const localChatId = chatId;
      const titleFiles = (userMessage.files || []).map((f) => f.name);
      const canPersistTitle = canPersist;
      setIsGeneratingTitle(true);
      fetch("/api/chat/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: userMessage.content,
          files: titleFiles,
          chatId: localChatId,
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            throw new Error(`Failed to generate title (${r.status})`);
          }
          const data: unknown = await r.json().catch(() => null);
          return data;
        })
        .then(async (data) => {
          const nextTitle =
            typeof (data as { title?: unknown } | null)?.title === "string"
              ? (data as { title: string }).title.trim()
              : "";
          if (!nextTitle) return;

          // Persist title if possible; only update UI if we're still on this chat.
          if (canPersistTitle) {
            try {
              await db.updateChatTitle(localChatId, nextTitle);
            } catch (err) {
              console.error("Failed to update chat title", err);
            }
          }

          if (currentChatIdRef.current === localChatId) {
            setCurrentChatTitle(nextTitle);
          }
        })
        .catch((err) => {
          console.error("Failed to generate chat title", err);
        })
        .finally(() => {
          setIsGeneratingTitle(false);
        });
    }

    // Call Real LLM via streaming API
    let streamController: AbortController | null = null;
    let activeAssistantId = "";
    let reasoningOwnerAssistantId = "";
    let flushPersist = () => {};
    let streamIdleTimer: number | null = null;
    let streamIdleAbort = false;
    let lastStreamActivityAt = 0;
    const stopIdleWatch = () => {
      if (streamIdleTimer !== null) {
        window.clearInterval(streamIdleTimer);
        streamIdleTimer = null;
      }
    };
    const noteStreamActivity = () => {
      lastStreamActivityAt = Date.now();
      if (isActiveStream()) {
        markStreamActivity();
      }
    };
    const startIdleWatch = () => {
      lastStreamActivityAt = Date.now();
      if (streamIdleTimer !== null) {
        window.clearInterval(streamIdleTimer);
      }
      streamIdleTimer = window.setInterval(() => {
        if (!isActiveStream()) return;
        if (Date.now() - lastStreamActivityAt >= STREAM_IDLE_ABORT_MS) {
          streamIdleAbort = true;
          streamController?.abort();
        }
      }, STREAM_IDLE_CHECK_MS);
    };
    try {
      const streamFiles = uploadedFiles
        .filter((file) => Boolean(file.storagePath))
        .map((file) => ({
          id: file.id,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          storagePath: file.storagePath,
        }));

      // Prepare history (excluding the current user message which is passed separately)
      const history = messages
        .filter((m) => !(m.role === "assistant" && Boolean(parseArtifactMessage(m.content))))
        .map(m => ({ role: m.role, content: m.content }));

      const reasoningEffort = MODEL_PRESETS.find((p) => p.id === modelPreset)?.reasoningEffort;
      const shouldStreamReasoningSummary = Boolean(reasoningEffort);

      const assistantMessageId = crypto.randomUUID();
      const assistantMessageCreatedAt = nextMessageCreatedAt();
      activeAssistantId = assistantMessageId;
      reasoningOwnerAssistantId = assistantMessageId;
      const initialAssistantMessage: Message = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: assistantMessageCreatedAt,
        ...(shouldStreamReasoningSummary
          ? { reasoningSummary: "", reasoningSummaryStatus: "loading" }
          : {}),
      };
      if (isActiveStream()) {
        setMessages((prev) => [...prev, initialAssistantMessage]);
      }

      if (chatId && canPersist) {
        void db
          .upsertMessage({
            id: assistantMessageId,
            chatId,
            role: "assistant",
            content: initialAssistantMessage.content,
            status: initialAssistantMessage.status,
            reasoningSummary: initialAssistantMessage.reasoningSummary,
            reasoningSegments: initialAssistantMessage.reasoningSegments,
            traceSegments: initialAssistantMessage.traceSegments,
            renderOrder: initialAssistantMessage.renderOrder,
            createdAt: assistantMessageCreatedAt,
          })
          .catch((err) => {
            console.error("Failed to persist assistant message", err);
          });
      }

      streamController = new AbortController();
      streamAbortRef.current = streamController;
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          history,
          chatId: chatId ?? undefined,
          reasoningEffort,
          assistantMessageId,
          assistantMessageCreatedAt,
          files: streamFiles,
        }),
        signal: streamController.signal,
      });

      const contentType = response.headers.get("content-type") || "";
      const isEventStream = contentType.includes("text/event-stream");
      const looksLikeLoginRedirect =
        response.redirected ||
        response.url.includes("/login") ||
        response.url.includes("/auth");
      if (looksLikeLoginRedirect) {
        const err = new Error("Sign in required.");
        (err as Error & { status?: number; isEventStream?: boolean }).status =
          response.status || 401;
        (err as Error & { status?: number; isEventStream?: boolean }).isEventStream =
          isEventStream;
        throw err;
      }

      if (!response.ok || !response.body || !isEventStream) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          // ignore
        }
        const extractedMessage = extractErrorMessageFromBody(bodyText);
        const message =
          extractedMessage || resolveStatusMessage(response.status, isEventStream);
        const preview = bodyText ? bodyText.slice(0, 240) : "";
        console.error("Non-stream response from /api/chat/stream", {
          status: response.status,
          contentType,
          bodyPreview: preview || undefined,
        });
        const err = new Error(message);
        (err as Error & { status?: number; isEventStream?: boolean }).status =
          response.status;
        (err as Error & { status?: number; isEventStream?: boolean }).isEventStream =
          isEventStream;
        throw err;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      startIdleWatch();
      let buffer = "";
      let streamedContent = "";
      let streamHadArtifactMessage = false;
      let streamHadAssistantOutput = false;
      pendingIntentClarificationRef.current = null;
      pendingIntentClarificationKeyRef.current = "";
      streamHasClarificationRef.current = false;
      const streamedMessages: Message[] = [];
      const streamedMessageIndex = new Map<string, number>();
      const reindexStreamedMessages = () => {
        streamedMessageIndex.clear();
        streamedMessages.forEach((msg, idx) => streamedMessageIndex.set(msg.id, idx));
      };
      const recordStreamedMessage = (message: Message) => {
        streamedMessages.push(message);
        streamedMessageIndex.set(message.id, streamedMessages.length - 1);
      };
      recordStreamedMessage(initialAssistantMessage);
      const runStatusEvents: { label: string; detail?: string; at: string }[] = [];

      const updateMessageById = (messageId: string, updater: (m: Message) => Message) => {
        if (isActiveStream()) {
          setMessages((prev) => prev.map((m) => (m.id === messageId ? updater(m) : m)));
        }
        const idx = streamedMessageIndex.get(messageId);
        if (idx !== undefined) {
          streamedMessages[idx] = updater(streamedMessages[idx]);
        }
      };

      const updateAssistant = (updater: (m: Message) => Message) => {
        updateMessageById(activeAssistantId, updater);
      };

      const updateReasoningOwner = (updater: (m: Message) => Message) => {
        updateMessageById(reasoningOwnerAssistantId, updater);
      };

      const finalizeReasoningOwner = (messageId: string) => {
        if (!messageId) return;
        updateMessageById(messageId, (m) => {
          if (m.reasoningSummaryStatus !== "loading") return m;
          const summary = (m.reasoningSummary ?? "").trim();
          if (!summary && (!m.reasoningSegments || m.reasoningSegments.length === 0)) {
            return { ...m, reasoningSummaryStatus: "done" };
          }
          return { ...m, reasoningSummaryStatus: "done" };
        });
      };

      const switchReasoningOwner = (nextId: string) => {
        if (!nextId || reasoningOwnerAssistantId === nextId) return;
        finalizeReasoningOwner(reasoningOwnerAssistantId);
        reasoningOwnerAssistantId = nextId;
      };

      const persistAssistantMessage = async (messageId: string) => {
        if (!chatId || !canPersist) return;
        const idx = streamedMessageIndex.get(messageId);
        const message = idx !== undefined ? streamedMessages[idx] : null;
        if (!message) return;
        try {
          await db.upsertMessage({
            id: message.id,
            chatId,
            role: message.role,
            content: message.content,
            files: message.files,
            status: message.status,
            reasoningSummary: message.reasoningSummary,
            reasoningSegments: message.reasoningSegments,
            traceSegments: message.traceSegments,
            renderOrder: message.renderOrder,
            createdAt: message.createdAt,
          });
        } catch (err) {
          console.error("Failed to persist streamed message", err);
        }
      };

      let persistTimer: ReturnType<typeof setTimeout> | null = null;
      const schedulePersist = () => {
        if (!chatId || !canPersist) return;
        if (persistTimer) return;
        persistTimer = setTimeout(() => {
          persistTimer = null;
          void persistAssistantMessage(activeAssistantId);
        }, 750);
      };

      flushPersist = () => {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        void persistAssistantMessage(activeAssistantId);
      };

      const streamParser = createStreamParser({
        updateAssistant,
        updateReasoningOwner,
        createId: () => crypto.randomUUID(),
        onAssistantOutput: () => {
          streamHadAssistantOutput = true;
        },
      });

      const appendStatusEvent = (event: { label: string; detail?: string; at: string }) => {
        runStatusEvents.push(event);
        streamParser.appendStatusEvent(event);
        schedulePersist();
      };

      const appendReasoningSummaryDelta = (delta: string) => {
        streamParser.appendReasoningSummaryDelta(delta);
        schedulePersist();
      };

      const appendAnswerDelta = (delta: string) => {
        streamParser.appendAnswerDelta(delta);
        schedulePersist();
      };

      const appendStreamContentDelta = (delta: string) => {
        streamParser.appendContentDelta(delta);
        schedulePersist();
      };

      const closeActiveReasoningSegment = () => {
        streamParser.closeActiveReasoningSegment();
      };

      const closeActiveTraceSegment = () => {
        streamParser.closeActiveTraceSegment();
      };

      const flushStreamBuffer = () => {
        streamParser.flushStreamBuffer();
      };

      const promoteFinalTraceSegment = (opts?: { promote?: boolean }) => {
        streamParser.promoteFinalTraceSegment(opts);
      };

      const insertClarificationMessage = (
        payload: ClarificationPayload,
        opts?: { createAssistantShell?: boolean }
      ) => {
        if (!isActiveStream()) return;
        closeActiveReasoningSegment();
        const key = buildClarificationKey(payload);
        if (!key || intentClarificationKeyRef.current === key) return;
        intentClarificationKeyRef.current = key;
        const createAssistantShell = opts?.createAssistantShell !== false;

        const currentIdx = streamedMessageIndex.get(activeAssistantId);
        const currentAssistant =
          currentIdx !== undefined ? streamedMessages[currentIdx] : undefined;
        const currentHasContent = Boolean(currentAssistant?.content?.trim());
        const currentHasTrace = Boolean(currentAssistant?.traceSegments?.length);
        const currentHasStatus = Boolean(currentAssistant?.status?.events?.length);
        const currentHasReasoning = hasReasoningOutput(currentAssistant);
        const shouldInsertBefore =
          !currentHasContent && !currentHasTrace && !currentHasStatus && !currentHasReasoning;
        const anchorAssistantId = activeAssistantId;
        const anchorAt =
          typeof currentAssistant?.createdAt === "string" && currentAssistant.createdAt.trim()
            ? currentAssistant.createdAt
            : assistantMessageCreatedAt;

        const clarificationMessage: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: buildClarificationBlock(payload),
          createdAt: shouldInsertBefore ? nextCreatedAtBefore(anchorAt) : nextMessageCreatedAt(),
        };

        if (isActiveStream()) {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === anchorAssistantId);
            if (idx === -1) return [...prev, clarificationMessage];
            const next = [...prev];
            const insertAt = shouldInsertBefore ? idx : idx + 1;
            next.splice(insertAt, 0, clarificationMessage);
            return next;
          });
        }

        if (currentIdx === undefined) {
          recordStreamedMessage(clarificationMessage);
        } else {
          const insertAt = shouldInsertBefore ? currentIdx : currentIdx + 1;
          streamedMessages.splice(insertAt, 0, clarificationMessage);
          reindexStreamedMessages();
        }

        if (!shouldInsertBefore && createAssistantShell) {
          const newAssistantId = crypto.randomUUID();
          const newAssistantMessage: Message = {
            id: newAssistantId,
            role: "assistant",
            content: "",
            createdAt: nextMessageCreatedAt(),
          };
          if (isActiveStream()) {
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === clarificationMessage.id);
              if (idx === -1) return [...prev, newAssistantMessage];
              const next = [...prev];
              next.splice(idx + 1, 0, newAssistantMessage);
              return next;
            });
          }
          const messageIdx = streamedMessageIndex.get(clarificationMessage.id);
          if (messageIdx === undefined) {
            recordStreamedMessage(newAssistantMessage);
          } else {
            streamedMessages.splice(messageIdx + 1, 0, newAssistantMessage);
            reindexStreamedMessages();
          }
          activeAssistantId = newAssistantId;
          streamParser.resetForNewMessage({ initialContent: "" });
          streamedContent = "";
          switchReasoningOwner(newAssistantId);
        }
      };

      const queueIntentClarification = (intentData: unknown) => {
        if (!isActiveStream()) return;
        const payload = buildIntentClarificationPayload(intentData);
        if (!payload) return;
        const key = buildClarificationKey(payload);
        if (!key || intentClarificationKeyRef.current === key) return;
        if (pendingIntentClarificationKeyRef.current === key) return;
        pendingIntentClarificationRef.current = payload;
        pendingIntentClarificationKeyRef.current = key;
      };

      const flushPendingIntentClarification = (opts?: { createAssistantShell?: boolean }) => {
        if (!isActiveStream()) return;
        const payload = pendingIntentClarificationRef.current;
        if (!payload) return;
        pendingIntentClarificationRef.current = null;
        pendingIntentClarificationKeyRef.current = "";
        if (streamHasClarificationRef.current) return;
        if (streamHadAssistantOutput || streamHadArtifactMessage) return;
        insertClarificationMessage(payload, opts);
      };

      const resolveTimelineAt = () => {
        const currentIdx = streamedMessageIndex.get(activeAssistantId);
        const currentAssistant =
          currentIdx !== undefined ? streamedMessages[currentIdx] : undefined;
        const anchorAt =
          typeof currentAssistant?.createdAt === "string" && currentAssistant.createdAt.trim()
            ? currentAssistant.createdAt
            : assistantMessageCreatedAt;
        return anchorAt || new Date().toISOString();
      };

      const handleOpen = (open: { id: string; at?: string }, opts?: { recordTimeline?: boolean }) => {
        const normalizedId = normalizeArtifactId(open?.id || "");
        if (!normalizedId || isHiddenArtifactId(normalizedId)) return;
        if (!isActiveStream()) return;
        setIsCanvasLoading(false);
        const shouldHoldClarification = shouldHoldClarificationAutoOpen(normalizedId);
        const shouldAutoFollow = isLiveRef.current;
        const shouldForceOpen = PLACEHOLDER_CANVAS_IDS.has(normalizedId);
        const snapshot = latestArtifactSnapshotRef.current.get(normalizedId);
        const fallbackArtifact = artifacts.find((a) => a.id === normalizedId);
        const artifactType = snapshot?.type ?? fallbackArtifact?.type ?? "markdown";
        const artifactData = snapshot?.data ?? fallbackArtifact?.data ?? null;
        const isEmptySandbox = normalizedId === "sandbox" && !hasSandboxActivity(artifactData);
        const shouldHoldSandbox = shouldHoldSandboxAutoOpen(normalizedId, artifactData);
        if (opts?.recordTimeline !== false) {
          if (isEmptySandbox) return;
          setCanvasTimeline((prev) => {
            const timelineAt =
              typeof open.at === "string" && open.at.trim() && toEpochMs(open.at) !== null
                ? open.at
                : resolveTimelineAt();
            const out = [...prev];
            const pushed = appendCanvasTimelineEvent(out, {
              at: timelineAt,
              kind: "open",
              artifactId: normalizedId,
              artifactType,
              data: artifactData,
            });
            if (!pushed) return prev;
            if (shouldAutoFollow) {
              setTimelineCursor(out.length - 1);
            }
            return out;
          });
        }

        if (
          !isEmptySandbox &&
          (shouldAutoFollow || shouldForceOpen) &&
          !shouldHoldClarification &&
          !shouldHoldSandbox &&
          hasMessagesRef.current
        ) {
          openPanelForArtifact(normalizedId, { jumpToLatest: false });
        }
      };

      const handleUpsert = (
        u: { id: string; type: string; data: unknown; at?: string },
        opts?: { recordTimeline?: boolean }
      ) => {
        const normalizedId = normalizeArtifactId(u.id, u.type);
        const shouldHideArtifact = isHiddenArtifactId(normalizedId);
        const shouldSyncUi = isActiveStream();
        const shouldAutoFollow = isLiveRef.current;
        const shouldHoldClarification = shouldHoldClarificationAutoOpen(normalizedId);
        const shouldHoldSandbox = shouldHoldSandboxAutoOpen(normalizedId, u.data);
        const isEmptySandbox = normalizedId === "sandbox" && !hasSandboxActivity(u.data);
        if (shouldSyncUi) {
          const currentActiveArtifact = activeArtifactRef.current;
          const shouldClearCanvasLoading =
            !shouldHideArtifact || (currentActiveArtifact && currentActiveArtifact === normalizedId);
          if (shouldClearCanvasLoading) setIsCanvasLoading(false);
          addArtifact({ id: normalizedId, type: u.type, data: u.data });
          latestArtifactSnapshotRef.current.set(normalizedId, { type: u.type, data: u.data });
          if (
            isLgUp &&
            !shouldHideArtifact &&
            shouldAutoFollow &&
            !isEmptySandbox &&
            !shouldHoldClarification &&
            !shouldHoldSandbox &&
            hasMessagesRef.current
          ) {
            openPanelForArtifact(normalizedId, { jumpToLatest: false });
          }
        }

        if (shouldSyncUi && normalizedId === "intent") {
          queueIntentClarification(u.data);
        }

        if (opts?.recordTimeline !== false) {
          if (isEmptySandbox) return;
          setCanvasTimeline((prev) => {
            const timelineAt =
              typeof u.at === "string" && u.at.trim() && toEpochMs(u.at) !== null
                ? u.at
                : resolveTimelineAt();
            const out = [...prev];
            const pushed = appendCanvasTimelineEvent(out, {
              at: timelineAt,
              kind: "upsert",
              artifactId: normalizedId,
              artifactType: u.type,
              data: u.data,
            });
            if (!pushed) return prev;
            if (shouldAutoFollow) {
              setTimelineCursor(out.length - 1);
            }
            return out;
          });
        }

        const dataKey = getArtifactDataKey(u.data);
        const previousKey = streamArtifactMessageState.get(normalizedId);
        const isPlanArtifact = normalizedId === "plan";
        const shouldEmitArtifactMessage =
          !shouldHideArtifact &&
          previousKey !== dataKey &&
          (!isPlanArtifact || !streamArtifactMessageState.has(normalizedId));

        if (!shouldHideArtifact) {
          streamArtifactMessageState.set(normalizedId, dataKey);
          if (shouldSyncUi) {
            artifactMessageStateRef.current.set(normalizedId, dataKey);
          }
        }

        if (shouldEmitArtifactMessage) {
          closeActiveReasoningSegment();
          streamHadArtifactMessage = true;
          const currentIdx = streamedMessageIndex.get(activeAssistantId);
          const currentAssistant =
            currentIdx !== undefined ? streamedMessages[currentIdx] : undefined;
          const currentHasContent = Boolean(currentAssistant?.content?.trim());
          const currentHasTrace = Boolean(currentAssistant?.traceSegments?.length);
          const currentHasStatus = Boolean(currentAssistant?.status?.events?.length);
          const currentHasReasoning = hasReasoningOutput(currentAssistant);
          const shouldInsertBeforeNoOutput =
            !currentHasContent && !currentHasTrace && !currentHasStatus && !currentHasReasoning;
          const anchorAssistantId = activeAssistantId;
          const anchorAt =
            typeof currentAssistant?.createdAt === "string" && currentAssistant.createdAt.trim()
              ? currentAssistant.createdAt
              : assistantMessageCreatedAt;
          const upsertAt =
            typeof u.at === "string" && toEpochMs(u.at) !== null ? u.at : null;
          const upsertAtMs = upsertAt ? toEpochMs(upsertAt) : null;
          const anchorAtMs = toEpochMs(anchorAt);
          const shouldInsertBeforeByTimestamp =
            upsertAtMs !== null && anchorAtMs !== null && upsertAtMs < anchorAtMs;
          const shouldInsertBefore = shouldInsertBeforeNoOutput || shouldInsertBeforeByTimestamp;
          const shouldInsertUsingTimestamp = Boolean(upsertAt && !shouldInsertBeforeNoOutput);
          const artifactCreatedAt = shouldInsertBeforeNoOutput
            ? nextCreatedAtBefore(anchorAt)
            : upsertAt ?? nextMessageCreatedAt();

          const artifactMessage: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: encodeArtifactMessage({ id: normalizedId, type: u.type }),
            createdAt: artifactCreatedAt,
          };

          if (shouldSyncUi) {
            setMessages((prev) => {
              if (shouldInsertUsingTimestamp) {
                const next = [...prev];
                const insertAt = findInsertIndexByTimestamp(next, artifactCreatedAt);
                next.splice(insertAt, 0, artifactMessage);
                return next;
              }
              const idx = prev.findIndex((m) => m.id === anchorAssistantId);
              if (idx === -1) return [...prev, artifactMessage];
              const next = [...prev];
              const insertAt = shouldInsertBefore ? idx : idx + 1;
              next.splice(insertAt, 0, artifactMessage);
              return next;
            });
          }

          if (shouldInsertUsingTimestamp) {
            const insertAt = findInsertIndexByTimestamp(streamedMessages, artifactCreatedAt);
            streamedMessages.splice(insertAt, 0, artifactMessage);
            reindexStreamedMessages();
          } else if (currentIdx === undefined) {
            recordStreamedMessage(artifactMessage);
          } else {
            const insertAt = shouldInsertBefore ? currentIdx : currentIdx + 1;
            streamedMessages.splice(insertAt, 0, artifactMessage);
            reindexStreamedMessages();
          }

          if (!shouldInsertBefore) {
            const newAssistantId = crypto.randomUUID();
            const newAssistantMessage: Message = {
              id: newAssistantId,
              role: "assistant",
              content: "",
              createdAt: nextMessageCreatedAt(),
            };
            if (shouldSyncUi) {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === artifactMessage.id);
                if (idx === -1) return [...prev, newAssistantMessage];
                const next = [...prev];
                next.splice(idx + 1, 0, newAssistantMessage);
                return next;
              });
            }
            const artifactIdx = streamedMessageIndex.get(artifactMessage.id);
            if (artifactIdx === undefined) {
              recordStreamedMessage(newAssistantMessage);
            } else {
              streamedMessages.splice(artifactIdx + 1, 0, newAssistantMessage);
              reindexStreamedMessages();
            }
            activeAssistantId = newAssistantId;
            streamParser.resetForNewMessage({ initialContent: "" });
            switchReasoningOwner(newAssistantId);
            streamedContent = "";
          }
        }
      };

      const parseEvents = (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        return parts;
      };

      let sawDoneEvent = false;
      const processEventBlock = (raw: string) => {
        const lines = raw.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          }
        }
        if (!data) return;
        noteStreamActivity();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        if (event === "status" && parsed && typeof parsed === "object") {
          appendStatusEvent(parsed as { label: string; detail?: string; at: string });
        } else if (event === "context" && parsed && typeof parsed === "object") {
          const obj = parsed as {
            inputTokens?: unknown;
            maxInputTokens?: unknown;
            usedFraction?: unknown;
          };
          const inputTokensRaw = obj.inputTokens;
          const maxInputTokensRaw = obj.maxInputTokens;
          const usedFractionRaw = obj.usedFraction;

          const inputTokens =
            typeof inputTokensRaw === "number" && Number.isFinite(inputTokensRaw)
              ? Math.max(0, Math.floor(inputTokensRaw))
              : null;
          const maxInputTokens =
            typeof maxInputTokensRaw === "number" &&
            Number.isFinite(maxInputTokensRaw) &&
            maxInputTokensRaw > 0
              ? Math.floor(maxInputTokensRaw)
              : undefined;
          const usedFraction =
            typeof usedFractionRaw === "number" && Number.isFinite(usedFractionRaw)
              ? Math.max(0, Math.min(1, usedFractionRaw))
              : inputTokens !== null && maxInputTokens
                ? Math.max(0, Math.min(1, inputTokens / maxInputTokens))
                : undefined;

          if (inputTokens !== null) {
            setContextUsage({ inputTokens, maxInputTokens, usedFraction });
          }
        } else if (event === "reasoning_summary") {
          const chunkText = typeof parsed === "string" ? parsed : "";
          if (chunkText) {
            appendReasoningSummaryDelta(chunkText);
          }
        } else if (event === "ui_upsert" && parsed && typeof parsed === "object") {
          handleUpsert(parsed as { id: string; type: string; data: unknown; at?: string }, { recordTimeline: true });
        } else if (event === "ui_open" && parsed && typeof parsed === "object") {
          const openId = (parsed as { id?: unknown }).id;
          const openAt = (parsed as { at?: unknown }).at;
          if (typeof openId === "string") {
            handleOpen(
              {
                id: openId,
                at: typeof openAt === "string" ? openAt : undefined,
              },
              { recordTimeline: true }
            );
          }
        } else if (event === "content") {
          const chunkText = typeof parsed === "string" ? parsed : "";
          if (chunkText) {
            streamedContent += chunkText;
            appendStreamContentDelta(chunkText);
            if (
              !streamHasClarificationRef.current &&
              streamedContent.includes("```clarification")
            ) {
              streamHasClarificationRef.current = true;
              const { payload: clarificationPayload } =
                extractClarificationPayload(streamedContent);
              if (
                clarificationPayload?.title === INTENT_CLARIFICATION_TITLE
              ) {
                const key = buildClarificationKey(clarificationPayload);
                if (key) intentClarificationKeyRef.current = key;
              }
            }
          }
        } else if (event === "done") {
          sawDoneEvent = true;
          const doneContent =
            parsed && typeof parsed === "object" && "content" in parsed
              ? (parsed as { content?: unknown }).content
              : undefined;
          // Some coordinator exits (timeouts/errors) return content without streaming deltas.
          // If we received no content events for this assistant message, apply the fallback here.
          if (!streamedContent.trim() && typeof doneContent === "string" && doneContent.trim()) {
            appendAnswerDelta(doneContent);
          }
          if (parsed && typeof parsed === "object") {
            const ui = (parsed as { ui?: { upserts?: unknown; openArtifactId?: unknown } }).ui;
            if (ui && typeof ui === "object") {
              const upserts = (ui as { upserts?: unknown }).upserts;
              if (Array.isArray(upserts)) {
                for (const upsert of upserts) {
                  if (!upsert || typeof upsert !== "object") continue;
                  const u = upsert as { id?: unknown; type?: unknown; data?: unknown; at?: unknown };
                  if (typeof u.id === "string" && typeof u.type === "string") {
                    const normalizedId = normalizeArtifactId(u.id, u.type);
                    // Always write to the store from the "done" payload, even if
                    // isActiveStream() is stale. This ensures seeded/persisted artifacts
                    // (intent, plan, etc.) are always available for canvas panels in live
                    // mode, regardless of stream timing.
                    addArtifact({ id: normalizedId, type: u.type, data: u.data });
                    latestArtifactSnapshotRef.current.set(normalizedId, { type: u.type, data: u.data });
                    handleUpsert(
                      {
                        id: u.id,
                        type: u.type,
                        data: u.data,
                        at: typeof u.at === "string" ? u.at : undefined,
                      },
                      { recordTimeline: false }
                    );
                  }
                }
              }
              const openId = (ui as { openArtifactId?: unknown }).openArtifactId;
              const openAt = (ui as { openArtifactAt?: unknown }).openArtifactAt;
              const shouldAutoOpen = !streamHadArtifactMessage && !streamHadAssistantOutput;
              if (typeof openId === "string" && openId.trim() && shouldAutoOpen) {
                // Avoid duplicating timeline frames on the synthetic "done" payload.
                handleOpen(
                  { id: openId, at: typeof openAt === "string" ? openAt : undefined },
                  { recordTimeline: false }
                );
              }
            }
          }
        } else if (event === "error") {
          const payload = isRecord(parsed) ? parsed as { message?: unknown; code?: unknown } : null;
          const message =
            payload && typeof payload.message === "string"
              ? payload.message
              : "Stream error";
          const err = new Error(message);
          if (payload && typeof payload.code === "string") {
            (err as Error & { code?: string }).code = payload.code;
          }
          throw err;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        noteStreamActivity();
        const text = decoder.decode(value, { stream: true });
        const events = parseEvents(text);
        for (const raw of events) {
          processEventBlock(raw);
        }
      }

      // If the server ended the stream without a final delimiter, process it.
      for (const raw of parseEvents("\n\n")) {
        processEventBlock(raw);
      }

      flushStreamBuffer();

      // If we never saw a "done" frame, assume the stream dropped and enter reconnect mode.
      if (!sawDoneEvent) {
        throw createStreamDisconnectedError();
      }

      closeActiveTraceSegment();
      closeActiveReasoningSegment();

      updateReasoningOwner((m) => {
        if (m.reasoningSummaryStatus !== "loading") return m;
        const summary = (m.reasoningSummary ?? "").trim();
        if (summary) {
          return {
            ...m,
            reasoningSummary: summary,
            reasoningSummaryStatus: "done",
          };
        }
        return {
          ...m,
          reasoningSummaryStatus: "error",
          reasoningSummaryError: "Reasoning summary unavailable.",
        };
      });

      promoteFinalTraceSegment({ promote: false });
      flushPersist();

      flushPendingIntentClarification({ createAssistantShell: false });

      const activeIdx = streamedMessageIndex.get(activeAssistantId);
      const activeAssistant =
        activeIdx !== undefined ? streamedMessages[activeIdx] : undefined;
      const activeHasTrace = Boolean(activeAssistant?.traceSegments?.length);
      const activeHasStatus = Boolean(activeAssistant?.status?.events?.length);
      const activeHasReasoning =
        Boolean(activeAssistant?.reasoningSummary?.trim()) ||
        activeAssistant?.reasoningSummaryStatus === "loading" ||
        activeAssistant?.reasoningSummaryStatus === "error";
      if (
        activeIdx !== undefined &&
        activeAssistant &&
        !activeAssistant.content.trim() &&
        !activeHasTrace &&
        !activeHasStatus &&
        !activeHasReasoning
      ) {
        if (isActiveStream()) {
          setMessages((prev) => prev.filter((m) => m.id !== activeAssistant.id));
        }
        streamedMessages.splice(activeIdx, 1);
        reindexStreamedMessages();
      }

      if (chatId && canPersist) {
        if (streamedMessages.length > 0) {
          void (async () => {
            for (const m of streamedMessages) {
              try {
              await db.upsertMessage({
                id: m.id,
                chatId,
                role: m.role,
                content: m.content,
                files: m.files,
                status: m.status,
                reasoningSummary: m.reasoningSummary,
                reasoningSegments: m.reasoningSegments,
                traceSegments: m.traceSegments,
                renderOrder: m.renderOrder,
                createdAt: m.createdAt,
              });
              } catch (err) {
                console.error("Failed to persist message", err);
              }
            }
            // Notify other tabs that this chat was updated
            broadcastSync("chat-updated", { chatId });
          })();
        }
      }

    } catch (error) {
      let reconnectError: unknown = error;
      if (error instanceof DOMException && error.name === "AbortError") {
        if (!streamIdleAbort) {
          return;
        }
        reconnectError = createStreamDisconnectedError();
      }

      // If the SSE stream drops mid-run (network blip/tab suspend), enter "Reconnecting…"
      // mode and let the existing run polling reload history once the background run completes.
      if (shouldAttemptReconnectForStreamError(reconnectError) && isActiveStream()) {
        let hasSession = false;
        try {
          const { data } = await supabase.auth.getSession();
          hasSession = Boolean(data.session?.user?.id);
        } catch {
          hasSession = false;
        }

        if (hasSession && typeof streamChatId === "string" && streamChatId.trim()) {
          setIsReconnecting(true);
          try {
            const run = await db.getActiveRun(streamChatId);
            if (run) {
              setActiveRun(run);
              return;
            }
            // No active run anymore: likely we missed the final "done" frame—refresh history.
            void loadChatFromDb(streamChatId);
            return;
          } catch {
            // Likely offline: create a local placeholder run so the poller keeps trying.
            const now = new Date().toISOString();
            setActiveRun((prev) =>
              prev ??
              ({
                id: `reconnect-${crypto.randomUUID()}`,
                chat_id: streamChatId,
                status: "running",
                created_at: now,
                updated_at: now,
              } satisfies AgentRun)
            );
            return;
          }
        }
      }

      console.error("Failed to get LLM response", reconnectError);
      const errorMessage = resolveStreamErrorMessage(reconnectError);
      if (isActiveStream()) {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== reasoningOwnerAssistantId) return m;
          if (m.reasoningSummaryStatus !== "loading") return m;
          return {
            ...m,
            reasoningSummaryStatus: "error",
            reasoningSummaryError: "Reasoning summary unavailable.",
          };
        }));
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: errorMessage,
            createdAt: nextMessageCreatedAt(),
          },
        ]);
      }
    } finally {
      stopIdleWatch();
      flushPersist();
      if (isActiveStream()) {
        setIsTyping(false);
        setShowThinkingIndicator(false);
        clearThinkingTimer();
        hasStreamSignalRef.current = false;
        setIsCanvasLoading(false);
      }
      if (streamController && streamAbortRef.current === streamController) {
        streamAbortRef.current = null;
      }
    }
  }

  useEffect(() => {
    if (isChatInteractionDisabled) return;
    if (isUploadingFiles) return;
    if (isTyping) return;
    if (isReconnecting || activeRun) return;
    if (isDrainingQueueRef.current) return;
    if (queuedSendsRef.current.length === 0) return;

    const next = dequeueQueuedSend();
    if (!next) return;

    isDrainingQueueRef.current = true;
    void handleSend(next.content, {
      files: next.files,
      clearComposer: false,
      source: next.source,
      fromQueue: true,
    }).finally(() => {
      isDrainingQueueRef.current = false;
    });
  }, [
    activeRun,
    dequeueQueuedSend,
    handleSend,
    isChatInteractionDisabled,
    isReconnecting,
    isTyping,
    isUploadingFiles,
  ]);

  const editNextQueuedSend = useCallback(() => {
    const next = queuedSendsRef.current[0];
    if (!next) return;
    queuedSendsRef.current = queuedSendsRef.current.slice(1);
    setQueuedSendCount(queuedSendsRef.current.length);
    setInputValue(next.content);
    setAttachedFiles(next.files.map((file) => ({ ...file })));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const sendNextQueuedSendNow = useCallback(() => {
    if (isChatInteractionDisabled) return;
    if (isUploadingFiles) return;
    if (isDrainingQueueRef.current) return;
    const next = dequeueQueuedSend();
    if (!next) return;

    isDrainingQueueRef.current = true;
    void handleSend(next.content, {
      files: next.files,
      clearComposer: false,
      source: next.source,
      fromQueue: true,
    }).finally(() => {
      isDrainingQueueRef.current = false;
    });
  }, [dequeueQueuedSend, handleSend, isChatInteractionDisabled, isUploadingFiles]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const panelsEl = chatPanelsRef.current;
      const target = event.target as Node | null;
      if (panelsEl && target && panelsEl.contains(target)) {
        lastPointerInPanelsRef.current = true;
        lastPanelsPointerAtRef.current = Date.now();
      } else {
        lastPointerInPanelsRef.current = false;
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    const isTextInputLike = (el: Element | null) => {
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || tag === "select") return true;
      if (tag === "input") {
        const input = el as HTMLInputElement;
        const type = (input.type || "text").toLowerCase();
        // Treat most input types as text inputs; skip click-only controls.
        if (
          type === "button" ||
          type === "submit" ||
          type === "reset" ||
          type === "checkbox" ||
          type === "radio"
        ) {
          return false;
        }
        return true;
      }
      if ((el as HTMLElement).isContentEditable) return true;
      const role = el.getAttribute("role");
      if (role === "textbox" || role === "searchbox") return true;
      return false;
    };

    const isInteractive = (el: Element | null) => {
      if (!el) return false;
      if (isTextInputLike(el)) return true;
      const tag = el.tagName.toLowerCase();
      if (tag === "button" || tag === "a") return true;
      const role = el.getAttribute("role");
      if (role === "button" || role === "link" || role === "menuitem") return true;
      return false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.repeat) return;
      if ((event as KeyboardEvent & { isComposing?: boolean }).isComposing) return;

      // Only "send queued now" when the composer is empty.
      if (inputValue.trim() || attachedFiles.length > 0) return;
      if (queuedSendsRef.current.length === 0) return;

      const activeEl = document.activeElement as Element | null;
      const targetEl = event.target as Element | null;
      if (isInteractive(activeEl) || isInteractive(targetEl)) return;

      const panelsEl = chatPanelsRef.current;
      const inPanels = Boolean(panelsEl && activeEl && panelsEl.contains(activeEl));
      const bodyFocused = activeEl === document.body || activeEl === document.documentElement;
      const recentPanelsPointer =
        lastPointerInPanelsRef.current && Date.now() - lastPanelsPointerAtRef.current < 20000;
      if (!inPanels && !(bodyFocused && recentPanelsPointer)) return;

      event.preventDefault();
      sendNextQueuedSendNow();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [attachedFiles.length, inputValue, sendNextQueuedSendNow]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
      if (native.isComposing) return;
      e.preventDefault();
      const hasComposerPayload = Boolean(inputValue.trim() || attachedFiles.length > 0);
      if (hasComposerPayload) {
        void handleSend();
        return;
      }
      if (queuedSendsRef.current.length > 0) {
        sendNextQueuedSendNow();
      }
    }
  };

  const handleInsertResponse = (response: string) => {
    if (isChatInteractionDisabled || !response.trim()) return;
    setInputValue(response);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleFileDownload = useCallback(
    async (file: MessageFile) => {
      if (!file.storagePath) return;
      try {
        const chatId = currentChatIdRef.current ?? currentChatId;
        if (!chatId) throw new Error("Missing chat id");
        const response = await fetch("/api/storage/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            storagePath: file.storagePath,
            fileName: file.name,
            mimeType: file.mimeType,
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : `Download failed (${response.status})`;
          throw new Error(message);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("Failed to download file", err);
      }
    },
    [currentChatId]
  );

  const renderTraceMarkdown = (content: string) => (
    <div
      className={`prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all text-[11px] leading-relaxed ${
        isDark ? "prose-invert text-zinc-300" : "text-zinc-600"
      }`}
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
              const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId;
              return (
                <button
                  type="button"
                  onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
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
            const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId;
            return (
              <button
                type="button"
                onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
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
                  className={`not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs ${
                    isDark
                      ? "bg-white/5 border-white/10 text-zinc-200"
                      : "bg-zinc-100 border-zinc-200 text-zinc-800"
                  }`}
                >
                  <code className={codeProps.className}>{codeString}</code>
                </pre>
              );
            }
            return (
              <pre
                className={`not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs ${
                  isDark
                    ? "bg-white/5 border-white/10 text-zinc-200"
                    : "bg-zinc-100 border-zinc-200 text-zinc-800"
                }`}
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
      className={`prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all text-[12px] leading-relaxed ${
        isDark ? "prose-invert text-zinc-300" : "text-zinc-700"
      }`}
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
              const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId;
              return (
                <button
                  type="button"
                  onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
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
            const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId;
            return (
              <button
                type="button"
                onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
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
                  className={`not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs ${
                    isDark
                      ? "bg-white/5 border-white/10 text-zinc-200"
                      : "bg-zinc-100 border-zinc-200 text-zinc-800"
                  }`}
                >
                  <code className={codeProps.className}>{codeString}</code>
                </pre>
              );
            }
            return (
              <pre
                className={`not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs ${
                  isDark
                    ? "bg-white/5 border-white/10 text-zinc-200"
                    : "bg-zinc-100 border-zinc-200 text-zinc-800"
                }`}
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

  /* Drag Resizing Logic */
  const [canvasWidth, setCanvasWidth] = useState(60); // Percentage for Canvas
  const [isResizing, setIsResizing] = useState(false);
  const [isDesktopTakeoverActive, setIsDesktopTakeoverActive] = useState(false);
  const dragConstraintsRef = useRef<HTMLDivElement>(null);

  const startResizing = React.useCallback(() => {
    if (isDesktopTakeoverActive) return;
    setIsResizing(true);
  }, [isDesktopTakeoverActive]);
  const stopResizing = React.useCallback(() => setIsResizing(false), []);

  const resize = React.useCallback(
    (e: MouseEvent) => {
      if (isResizing && dragConstraintsRef.current) {
        const containerWidth = dragConstraintsRef.current.offsetWidth;
        const leftOffset = dragConstraintsRef.current.getBoundingClientRect().left;
        const mouseXInContainer = e.clientX - leftOffset;

        console.log("Resize Debug:", {
          clientX: e.clientX,
          leftOffset,
          containerWidth,
          mouseXInContainer,
          calcRaw: ((containerWidth - mouseXInContainer) / containerWidth) * 100
        });

        // Calculate new percentage based on mouse position relative to container
        // Chat width = mouseXInContainer
        // Canvas width % = ((Container Width - Chat Width) / Container Width) * 100
        const newCanvasWidth = ((containerWidth - mouseXInContainer) / containerWidth) * 100;

        // Clamp between 30% and 70%
        if (newCanvasWidth >= 30 && newCanvasWidth <= 70) {
          setCanvasWidth(newCanvasWidth);
        }
      }
    },
    [isResizing]
  );

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", resize);
      window.addEventListener("mouseup", stopResizing);
    }
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

  const handleSelectChat = (chatId: string) => {
    setIsMobileSidebarOpen(false);
    if (chatId === currentChatIdRef.current || chatId === routeChatId || chatId === pendingChatId) {
      return;
    }
    router.push(`/${chatId}`, { scroll: false });
  };

  return (
    <ArtifactScopeProvider scopeId={artifactScopeId} chatId={artifactChatId}>
      <div className="h-dvh flex overflow-hidden bg-primary">

      {/* SIDEBAR (desktop) */}
      <div className="hidden md:block">
        <Sidebar
          onNewChat={handleNewChat}
          onSelectChat={handleSelectChat}
          isDark={isDark}
          onToggleTheme={() => applyThemePreference(isDark ? "light" : "dark")}
          activeChatId={currentChatId}
          loadingChatId={pendingChatId}
          isChatLoading={isChatLoading}
          onOpenCredits={openCredits}
        />
      </div>

      {/* SIDEBAR (mobile drawer) */}
      <AnimatePresence>
        {isMobileSidebarOpen && (
          <motion.div
            className="fixed inset-0 z-[80] md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileSidebarOpen(false)}
            />
            <div className="absolute inset-y-0 left-0">
              <Sidebar
                onNewChat={handleNewChat}
                onSelectChat={handleSelectChat}
                isDark={isDark}
                onToggleTheme={() => applyThemePreference(isDark ? "light" : "dark")}
                className="shadow-2xl"
                activeChatId={currentChatId}
                loadingChatId={pendingChatId}
                isChatLoading={isChatLoading}
                onOpenCredits={openCredits}
              />
            </div>
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setIsMobileSidebarOpen(false)}
              className="absolute top-[calc(env(safe-area-inset-top)+0.75rem)] right-4 p-2.5 rounded-full bg-black/40 text-white backdrop-blur-md"
            >
              <X className="w-5 h-5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col relative overflow-hidden transition-all duration-300 m-0 md:my-2 md:mr-2 rounded-none md:rounded-[2rem] border-0 md:border border-default shadow-none md:shadow-2xl bg-gradient-to-br from-[hsl(var(--bg-secondary))] to-[hsl(var(--bg-primary))] shadow-black/20">

        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
          <button
            type="button"
            aria-label="Open sidebar"
            onClick={() => setIsMobileSidebarOpen(true)}
            className="p-2.5 rounded-full transition-colors bg-tertiary hover:bg-elevated text-primary"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            {renderModelSelector()}
          </div>
          <div className="flex items-center gap-1.5">
            {contextUsage?.maxInputTokens ? (
              <ContextUsageIndicator usage={contextUsage} isDark={isDark} />
            ) : null}
            {hasAgentViewTarget ? (
              <button
                type="button"
                aria-label="Open agent canvas"
                onClick={goToAgentNow}
                className={`p-2.5 rounded-full transition-colors ${
                  isDark ? "bg-white/5 hover:bg-white/10 text-white" : "bg-black/5 hover:bg-black/10 text-zinc-900"
                }`}
                title="Open canvas"
              >
                <Monitor className="w-5 h-5" />
              </button>
            ) : null}
            {showLanding ? (
              renderCreditsBadge("icon")
            ) : (
              <button
                type="button"
                aria-label="Share chat"
                disabled={!isCurrentChatPersisted || !currentChatId}
                onClick={() => setIsShareOpen(true)}
                className={`p-2.5 rounded-full transition-colors ${
                  !isCurrentChatPersisted || !currentChatId
                    ? "opacity-50 cursor-not-allowed"
                    : isDark
                      ? "bg-white/5 hover:bg-white/10 text-white"
                      : "bg-black/5 hover:bg-black/10 text-zinc-900"
                }`}
              >
                <Share2 className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        <div ref={dragConstraintsRef} className="flex-1 min-h-0 flex flex-row relative overflow-hidden">
          <AnimatePresence initial={false}>
            {showLanding && (
              // --- EMPTY STATE: LANDING ---
              <div
                key="landing"
                className="absolute inset-0 z-30 flex flex-col"
              >
                {/* Landing Header (match in-chat top-left selector) */}
                <header className="hidden md:block px-4 sm:px-6 pt-4 sm:pt-6 pb-3 shrink-0">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex items-center">{renderModelSelector()}</div>
                    <div className="flex items-center gap-2">
                      {contextUsage?.maxInputTokens ? (
                        <ContextUsageIndicator usage={contextUsage} isDark={isDark} />
                      ) : null}
                      {renderCreditsBadge("pill")}
                    </div>
                  </div>
                </header>

                <div className="flex-1 flex flex-col items-center justify-center p-4">
                  <div className="max-w-3xl w-full text-center -mt-10 sm:-mt-12">
                  <div className="flex flex-col items-center justify-center w-full max-w-2xl mx-auto space-y-8">
                    {/* Minimal Header */}
                    <h2
                      className={`text-2xl sm:text-3xl font-semibold tracking-tight text-center transition-colors duration-500 mb-6 sm:mb-8 ${
                        isDark ? "text-white" : "text-zinc-800"
                      }`}
                    >
                      What are we building today?
                    </h2>

                    {/* Input Card */}
                    <div className="w-full max-w-[48rem] mx-auto rounded-[24px] sm:rounded-[32px] p-2.5 sm:p-4 transition-all duration-300 relative shadow-sm border border-default bg-elevated/85 dark:bg-tertiary/80 backdrop-blur-xl text-left">
                      {attachedFiles.length > 0 && (
                        <div className="px-2 pb-3 flex flex-wrap gap-2">
                          {attachedFiles.map((file) => (
                            <div
                              key={file.id}
                              className="flex items-center gap-2 text-sm bg-secondary px-3 py-1.5 rounded-full border border-default shadow-sm"
                            >
                              <FileText className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                              <span className="truncate max-w-[150px]">{file.name}</span>
                              {isUploadingFiles ? (
                                <span className="text-[10px] text-zinc-400">Uploading…</span>
                              ) : (
                                <button
                                  onClick={() => removeFile(file.id)}
                                  className="hover:text-red-400 p-0.5 rounded-full hover:bg-tertiary transition-colors"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center gap-2.5 sm:gap-3 relative">
                        {/* Attach Button */}
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept=".csv,.json,.jsonl,.parquet,.xlsx"
                          onChange={handleFileSelect}
                          className="hidden"
                        />
                        <div ref={landingAttachMenuRef} className="relative">
                          <button
                            onClick={() => openAttachMenu("landing")}
                            className="h-10 w-10 sm:h-11 sm:w-11 inline-flex items-center justify-center rounded-full border border-default bg-tertiary/80 text-zinc-500 hover:bg-tertiary transition-colors dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
                            title="Attach options"
                            aria-haspopup="menu"
                            aria-expanded={attachMenuOpen === "landing"}
                          >
                            <Plus className="w-5 h-5 sm:w-6 sm:h-6" />
                          </button>
                          <ComposerAttachMenu
                            open={attachMenuOpen === "landing"}
                            isDark={isDark}
                            onUploadFiles={attachViaUpload}
                            onConnectGithub={attachViaGithubIntegration}
                            onConnectHuggingFace={attachViaHuggingFaceIntegration}
                          />
                        </div>

                        {/* Text Input */}
                        <div className="relative flex-1 min-w-0">
                          <AnimatePresence mode="wait">
                            {showLanding && !inputValue && (
                              <motion.div
                                key={placeholders[placeholderIndex]}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                                className="absolute inset-0 flex items-center text-[16px] sm:text-lg leading-6 sm:leading-relaxed text-zinc-500 dark:text-zinc-400 pointer-events-none truncate"
                              >
                                {placeholders[placeholderIndex]}
                              </motion.div>
                            )}
                          </AnimatePresence>
                          <textarea
                            ref={textareaRef}
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder=""
                            aria-label="Message"
                            rows={1}
                            className="w-full bg-transparent border-0 focus:ring-0 resize-none py-3 sm:py-3.5 text-[16px] sm:text-lg max-h-52 min-h-[44px] leading-6 sm:leading-relaxed scrollbar-hide text-zinc-900 dark:text-zinc-100"
                            autoFocus
                          />
                        </div>

                        {/* Send Button */}
                        <button
                          onClick={() => handleSend()}
                          disabled={!inputValue.trim() && attachedFiles.length === 0}
                          className={`h-10 w-10 sm:h-11 sm:w-11 inline-flex items-center justify-center rounded-full transition-all duration-200 shrink-0 ${
                            inputValue.trim() || attachedFiles.length > 0
                              ? "bg-zinc-900 hover:bg-zinc-800 text-white shadow-md hover:shadow-lg active:scale-95 dark:bg-white dark:hover:bg-white/90 dark:text-black"
                              : "bg-tertiary/80 text-zinc-400 border border-default cursor-not-allowed dark:bg-white/10 dark:text-white/25"
                          }`}
                        >
                          <ArrowUp className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                </div>
              </div>
            )}
            <div
              ref={chatPanelsRef}
              className={`flex flex-1 min-w-0 ${
                showLanding ? "opacity-0 pointer-events-none" : "opacity-100"
              }`}
              aria-hidden={showLanding}
            >
              {/* ACTIVE STATE: SPLIT VIEW */}

              {/* LEFT PANEL: Chat Interface */}
              <motion.div
                layout
                initial={false}
                className="flex flex-col h-full relative z-0 flex-1 min-w-0"
              >
                <div className="flex flex-col h-full w-full min-w-0">
                  {/* Chat Header (anchored next to sidebar) */}
                  <header className="hidden md:block px-4 sm:px-6 pt-4 sm:pt-6 pb-3 shrink-0">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex items-center">
                        {!showLanding ? renderModelSelector() : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {contextUsage?.maxInputTokens ? (
                          <ContextUsageIndicator usage={contextUsage} isDark={isDark} />
                        ) : null}
                        <button
                          type="button"
                          aria-label="Share chat"
                          disabled={!isCurrentChatPersisted || !currentChatId}
                          onClick={() => setIsShareOpen(true)}
                          className={`inline-flex items-center gap-2 px-3 py-2 rounded-full border transition-colors ${
                            !isCurrentChatPersisted || !currentChatId
                              ? "opacity-50 cursor-not-allowed"
                              : isDark
                                ? "border-white/10 bg-white/5 hover:bg-white/10 text-white"
                                : "border-black/10 bg-white hover:bg-zinc-50 text-zinc-900"
                          }`}
                        >
                          <Share2 className="w-4 h-4" />
                          <span className="hidden sm:inline text-[13px] font-medium">Share</span>
                        </button>
                      </div>
                    </div>
                  </header>

                  <div className={`flex flex-col flex-1 min-h-0 mx-auto transition-all duration-500 w-full min-w-0 ${!isSplitView ? "max-w-3xl" : "max-w-full"}`}>
                    {/* Chat Messages */}
                    <div
                      ref={setMessagesScrollEl}
                      aria-busy={isHistoryLoading}
                      className="relative flex-1 overflow-y-auto px-4 sm:px-6 py-2 space-y-0 scrollbar-hide"
                    >
                    <AnimatePresence>
                      {isHistoryLoading && messages.length === 0 && (
                        <motion.div
                          key="chat-loading"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="space-y-4 pointer-events-none select-none"
                        >
                          <div className="space-y-3">
                            <div className="flex justify-start">
                              <div className="h-4 w-[62%] rounded-full animate-shimmer opacity-70 dark:opacity-40" />
                            </div>
                            <div className="flex justify-start">
                              <div className="h-4 w-[48%] rounded-full animate-shimmer opacity-70 dark:opacity-40" />
                            </div>
                            <div className="flex justify-end">
                              <div className="h-4 w-[40%] rounded-full animate-shimmer opacity-70 dark:opacity-40" />
                            </div>
                            <div className="flex justify-start">
                              <div className="h-4 w-[55%] rounded-full animate-shimmer opacity-70 dark:opacity-40" />
                            </div>
                            <div className="flex justify-end">
                              <div className="h-4 w-[35%] rounded-full animate-shimmer opacity-70 dark:opacity-40" />
                            </div>
                          </div>
                        </motion.div>
                      )}
                      {isHistoryLoading && messages.length > 0 && (
                        <motion.div
                          key="chat-loading-overlay"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="absolute inset-0 z-30 flex items-center justify-center"
                        >
                          <div className="absolute inset-0 bg-white/50 dark:bg-black/40 backdrop-blur-md" />
                          <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.98 }}
                            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
                            className="relative flex items-center gap-3 rounded-2xl px-4 py-3 shadow-lg border border-default bg-[hsl(var(--bg-elevated)/0.85)] text-primary"
                          >
                            <span
                              className="inline-flex h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-muted"
                              aria-hidden="true"
                            />
                            <div className="text-sm font-medium text-secondary">
                              Loading chat…
                            </div>
                          </motion.div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    {messages.map((message, index) => {
                      const artifactPayload =
                        message.role === "assistant" ? parseArtifactMessage(message.content) : null;
                      const isArtifactMessage = Boolean(artifactPayload);
                      const isHiddenArtifact = artifactPayload
                        ? isHiddenArtifactId(artifactPayload.id)
                        : false;
                      const reasoningSummaryStatus =
                        message.role === "assistant" ? message.reasoningSummaryStatus : undefined;
                      const traceSegments = Array.isArray(message.traceSegments)
                        ? message.traceSegments
                        : [];
                      const hasTraceSegments = traceSegments.length > 0;
                      const reasoningSegments = Array.isArray(message.reasoningSegments)
                        ? message.reasoningSegments
                        : [];
                      const hasReasoningSegments = reasoningSegments.length > 0;
                      const hasReasoningSummaryText = Boolean(
                        message.reasoningSummary && message.reasoningSummary.trim()
                      );
                      const shouldShowReasoningSummary =
                        message.role === "assistant" &&
                        (hasReasoningSegments ||
                          hasReasoningSummaryText ||
                          reasoningSummaryStatus === "loading" ||
                          reasoningSummaryStatus === "error");
                      const reasoningFallback =
                        reasoningSummaryStatus === "error"
                          ? message.reasoningSummaryError?.trim() || "Reasoning unavailable."
                          : "Thinking...";
                      const reasoningSegmentsForRender =
                        hasReasoningSegments || !shouldShowReasoningSummary
                          ? reasoningSegments
                          : normalizeReasoningSegments(
                              undefined,
                              message.reasoningSummary ?? reasoningFallback,
                              message.id
                            );
                      const renderOrder = normalizeRenderOrder(message.renderOrder);
                      const hasStatus = Boolean(message.status?.events?.length);
                      if (isHiddenArtifact) return null;
                      const { payload: clarificationPayload, stripped: clarificationStrippedContent } =
                        message.role === "assistant" && !isArtifactMessage
                          ? extractClarificationFromMessage(message)
                          : { payload: null, stripped: message.content };
                      const { payload: takeoverPayload, stripped: strippedContent } =
                        message.role === "assistant" && !isArtifactMessage
                          ? extractTakeoverFromMessage({
                              content: clarificationStrippedContent,
                              traceSegments,
                            })
                          : { payload: null, stripped: clarificationStrippedContent };
                      const displayContent =
                        message.role === "user" ? strippedContent.trimEnd() : strippedContent;
                      const hasDisplayContent = Boolean(displayContent && displayContent.trim());
                      const clarificationArtifactId = clarificationPayload
                        ? `clarification-${message.id}`
                        : null;
                      const storedClarificationResponse = clarificationArtifactId
                        ? clarificationResponseMap.get(clarificationArtifactId)
                        : undefined;
                      const isClarificationLocked = Boolean(
                        storedClarificationResponse?.answeredAt
                      );
                      const clarificationResponseKey =
                        storedClarificationResponse?.answeredAt ?? "unanswered";
                      const showClarificationInline = Boolean(clarificationPayload) && !isLgUp;
                      const showClarificationLink = Boolean(clarificationPayload) && isLgUp;
                      const showTakeoverInline =
                        message.role === "assistant" &&
                        !isArtifactMessage &&
                        (Boolean(takeoverPayload) ||
                          looksLikeTakeoverRequest(message.content) ||
                          traceSegments.some((segment) => looksLikeTakeoverRequest(segment.text)));
                      const hasContentBlock =
                        hasDisplayContent ||
                        showClarificationInline ||
                        showClarificationLink ||
                        showTakeoverInline;
                      const fallbackRenderOrder: RenderBlock[] = [
                        ...reasoningSegmentsForRender.map<RenderBlock>((segment) => ({
                          kind: "reasoning",
                          id: segment.id,
                        })),
                        ...(hasStatus ? [{ kind: "status" } as RenderBlock] : []),
                        ...traceSegments.map<RenderBlock>((segment) => ({
                          kind: "trace",
                          id: segment.id,
                        })),
                        ...(hasContentBlock ? [{ kind: "content" } as RenderBlock] : []),
                        ...(message.files && message.files.length > 0
                          ? [{ kind: "files" } as RenderBlock]
                          : []),
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

                      const isEmptyAssistantShell =
                        message.role === "assistant" &&
                        !isArtifactMessage &&
                        !shouldShowReasoningSummary &&
                        !hasStatus &&
                        !hasContentBlock &&
                        !hasTraceSegments &&
                        !(message.files && message.files.length > 0);
                      if (isEmptyAssistantShell) return null;

                      const isUtilityAssistant =
                        message.role === "assistant" &&
                        !isArtifactMessage &&
                        !hasContentBlock &&
                        (hasStatus || shouldShowReasoningSummary || hasTraceSegments);
                      const nextMessage = messages[index + 1];
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

                      return (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          key={message.id}
                          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} ${rowSpacingClass} last:mb-0`}
                        >
                          <div
                            className={
                              message.role === "user"
                                ? "max-w-[85%] rounded-[24px] px-5 pt-4 pb-3.5 text-[15px] leading-relaxed bg-tertiary text-primary"
                                : isArtifactMessage
                                  ? "w-full max-w-[85%] bg-transparent px-0 py-0"
                                  : `max-w-[85%] ${
                                      isUtilityAssistant ? "w-full " : ""
                                    }rounded-[24px] px-5 py-3.5 text-[15px] leading-relaxed bg-transparent pl-0 text-zinc-800 dark:text-zinc-300`
                            }
                          >
                            {isArtifactMessage && artifactPayload ? (
                              <ChatArtifactCard
                                artifactId={artifactPayload.id}
                                onSelect={(artifactId) => {
                                  if (!isLgUp) {
                                    openPanelForArtifact(artifactId, { jumpToLatest: false });
                                    revealCanvasOnMobile();
                                    return;
                                  }
                                  const idx = findLatestFrameIndexForArtifact(artifactId);
                                  if (idx === null) {
                                    openPanelForArtifact(artifactId, { jumpToLatest: false });
                                    return;
                                  }
                                  setTimelinePlayback("paused");
                                  setCursorAndOpenFrame(idx);
                                }}
                              />
                            ) : (
                              <div className={`prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all ${isDark ? 'prose-invert' : ''} ${message.role === 'assistant' ? 'text-zinc-800 dark:text-zinc-300' : 'text-inherit'} ${message.role === 'user' ? 'prose-p:my-0 prose-ul:my-0 prose-ol:my-0' : ''}`}>
                                {resolvedRenderOrder.map((block) => {
                                  if (block.kind === "reasoning") {
                                    const segment = reasoningSegmentsForRender.find((s) => s.id === block.id);
                                    if (!segment) return null;
                                    const isOpen =
                                      segment.status === "streaming" || Boolean(segment.isOpen);
                                    const compactText = getReasoningCompactText(segment.text);
                                    const previewText = compactText || reasoningFallback;
                                    const segmentText = segment.text.trim()
                                      ? segment.text
                                      : reasoningFallback;
                                    return (
                                      <div key={`reasoning-${segment.id}`} className="not-prose mt-0.5 space-y-0.5">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (segment.status === "streaming") return;
                                            const nextOpen = !isOpen;
                                            setMessages((prev) =>
                                              prev.map((m) => {
                                                if (m.id !== message.id) return m;
                                                const baseSegments = Array.isArray(m.reasoningSegments)
                                                  ? m.reasoningSegments
                                                  : normalizeReasoningSegments(
                                                      undefined,
                                                      m.reasoningSummary ?? reasoningFallback,
                                                      m.id
                                                    );
                                                const nextSegments = baseSegments.map((item) => {
                                                  if (item.id !== segment.id) return item;
                                                  return { ...item, isOpen: nextOpen };
                                                });
                                                return { ...m, reasoningSegments: nextSegments };
                                              })
                                            );
                                          }}
                                          aria-expanded={isOpen}
                                          className={`flex w-full min-w-0 items-center gap-2 py-1 text-[10px] ${
                                            isDark ? "text-zinc-500" : "text-zinc-500"
                                          }`}
                                        >
                                          <span className="shrink-0 uppercase tracking-[0.2em]">
                                            Reasoning
                                          </span>
                                          {!isOpen ? (
                                            <span
                                              className={`min-w-0 flex-1 truncate text-[11px] normal-case ${
                                                isDark ? "text-zinc-300" : "text-zinc-600"
                                              }`}
                                            >
                                              {renderInlineBoldMarkdown(previewText)}
                                            </span>
                                          ) : (
                                            <span className="flex-1" />
                                          )}
                                          {segment.status === "streaming" ? (
                                            <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-current/40" />
                                          ) : null}
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
                                    return message.role === "assistant" && hasStatus && message.status ? (
                                      <div key="status" className="not-prose">
                                        <AgentStatusCard status={message.status} isDark={isDark} />
                                      </div>
                                    ) : null;
                                  }

                                  if (block.kind === "content") {
                                    if (!hasContentBlock) return null;
                                    return (
                                      <div key="content">
                                        {showTakeoverInline ? (
                                          <div className="not-prose mb-2">
                                            <TakeoverCard payload={takeoverPayload} />
                                          </div>
                                        ) : null}
                                        {message.role === "assistant" && hasDisplayContent && hasTraceSegments ? (
                                          <div className="not-prose mb-1 text-[10px] uppercase tracking-[0.2em] text-zinc-400">
                                            Answer
                                          </div>
                                        ) : null}
                                        {hasDisplayContent ? (
                                          <ReactMarkdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
                                              a(props) {
                                                const { node, href, className, children, ...rest } = props as React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }
                                                void node
                                                const url = typeof href === "string" ? href : ""
                                                const isStorageLink = Boolean(url && parseSupabaseStorageUrl(url))
                                                const isImageLink = Boolean(url && looksLikeImageUrl(url))
                                                const shouldButton = Boolean(url && (isStorageLink || isImageLink))

                                                if (url && shouldButton) {
                                                  const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId
                                                  return (
                                                    <button
                                                      type="button"
                                                      onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
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
                                                  )
                                                }

                                                return (
                                                  <a {...rest} href={url} target="_blank" rel="noopener noreferrer" className={className}>
                                                    {children}
                                                  </a>
                                                )
                                              },
                                              img(props) {
                                                const { node, src, alt, className } = props as React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }
                                                void node
                                                const url = typeof src === "string" ? src : ""
                                                if (!url) return null
                                                void alt
                                                const chatId = currentChatIdRef.current ?? currentChatId ?? routeChatId
                                                return (
                                                  <button
                                                    type="button"
                                                    onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
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
                                                )
                                              },
                                              pre(props) {
                                                const { children } = props
                                                const codeChild = React.Children.toArray(children).find((child) =>
                                                  React.isValidElement(child)
                                                )
                                                if (React.isValidElement(codeChild)) {
                                                  const codeProps = codeChild.props as {
                                                    className?: string
                                                    children?: React.ReactNode
                                                  }
                                                  const match = /language-(\w+)/.exec(codeProps.className || '')
                                                  const rawCode = Array.isArray(codeProps.children)
                                                    ? codeProps.children.join('')
                                                    : String(codeProps.children ?? '')
                                                  const codeString = rawCode.replace(/\n$/, '')
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
                                                    )
                                                  }
                                                  return (
                                                    <pre className={`not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs ${isDark ? "bg-white/5 border-white/10 text-zinc-200" : "bg-zinc-100 border-zinc-200 text-zinc-800"}`}>
                                                      <code className={codeProps.className}>{codeString}</code>
                                                    </pre>
                                                  )
                                                }
                                                return (
                                                  <pre className={`not-prose my-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs ${isDark ? "bg-white/5 border-white/10 text-zinc-200" : "bg-zinc-100 border-zinc-200 text-zinc-800"}`}>
                                                    {children}
                                                  </pre>
                                                )
                                              },
                                              code(props) {
                                                const p = props as unknown as MarkdownCodeProps
                                                const inline = p.inline !== false
                                                const { children, className, node: nodeProp, ...rest } = p
                                                void nodeProp
                                                return (
                                                  <code
                                                    className={
                                                      inline
                                                        ? `${className ?? ''} bg-zinc-100 dark:bg-white/10 px-1 py-0.5 rounded break-all`
                                                        : className ?? ''
                                                    }
                                                    {...rest}
                                                  >
                                                    {children}
                                                  </code>
                                                )
                                              }
                                            }}
                                          >
                                            {displayContent}
                                          </ReactMarkdown>
                                        ) : null}
                                        {showClarificationInline && clarificationPayload ? (
                                          <div className="not-prose mt-4">
                                            <ClarificationCard
                                              key={`${message.id}:${clarificationResponseKey}`}
                                              payload={clarificationPayload}
                                              disabled={isChatInteractionDisabled || isClarificationLocked}
                                              initialAnswers={storedClarificationResponse?.answers}
                                              initialCustomAnswers={storedClarificationResponse?.customAnswers}
                                              initialNotes={storedClarificationResponse?.notes}
                                              onRecordResponse={(state) => {
                                                if (!clarificationArtifactId) return;
                                                addArtifact({
                                                  id: clarificationArtifactId,
                                                  type: "clarification",
                                                  data: { ...clarificationPayload, response: state },
                                                });
                                              }}
                                              onSend={(response) => handleSend(response)}
                                            />
                                          </div>
                                        ) : null}
                                        {showClarificationLink && clarificationArtifactId ? (
                                          <div className="not-prose mt-4">
                                            <ChatArtifactCard
                                              artifactId={clarificationArtifactId}
                                              titleOverride={clarificationPayload?.title || "Clarification"}
                                              onSelect={(artifactId) => {
                                                openPanelForArtifact(artifactId, { jumpToLatest: false });
                                                revealCanvasOnMobile();
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
                                    const isOpen =
                                      segment.status === "streaming" || Boolean(segment.isOpen);
                                    const compactText = getTraceCompactText(traceText);
                                    const previewText = compactText || "Trace details";
                                    return (
                                      <div key={`trace-${segment.id}`} className="not-prose mt-0.5 space-y-0.5">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (segment.status === "streaming") return;
                                            const nextOpen = !isOpen;
                                            setMessages((prev) =>
                                              prev.map((m) => {
                                                if (m.id !== message.id || !m.traceSegments) return m;
                                                const nextSegments = m.traceSegments.map((item) => {
                                                  if (item.id !== segment.id) return item;
                                                  return { ...item, isOpen: nextOpen };
                                                });
                                                return { ...m, traceSegments: nextSegments };
                                              })
                                            );
                                          }}
                                          aria-expanded={isOpen}
                                          className={`flex w-full min-w-0 items-center gap-2 py-1 text-[10px] ${
                                            isDark ? "text-zinc-500" : "text-zinc-500"
                                          }`}
                                        >
                                          <span className="shrink-0 uppercase tracking-[0.2em]">
                                            Trace
                                          </span>
                                          {!isOpen ? (
                                            <span
                                              className={`min-w-0 flex-1 truncate text-[11px] normal-case ${
                                                isDark ? "text-zinc-300" : "text-zinc-600"
                                              }`}
                                            >
                                              {renderInlineBoldMarkdown(previewText)}
                                            </span>
                                          ) : (
                                            <span className="flex-1" />
                                          )}
                                          {segment.status === "streaming" ? (
                                            <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-current/40" />
                                          ) : null}
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
                                    return message.files && message.files.length > 0 ? (
                                      <div key="files" className="not-prose mt-3 flex flex-wrap gap-2">
                                        {message.files.map((file) => {
                                          const isError = file.uploadStatus === "error";
                                          const isDownloadable = Boolean(file.storagePath) && !isError;
                                          const baseClass =
                                            "inline-flex items-center gap-2 text-xs px-3 py-2 rounded-full border shadow-sm";
                                          const toneClass = isError
                                            ? "bg-red-50 text-red-600 border-red-200 dark:bg-red-500/10 dark:text-red-200 dark:border-red-500/30"
                                            : "bg-white dark:bg-white/5 border-zinc-200 dark:border-white/5";
                                          const content = (
                                            <>
                                              <FileText className="w-3.5 h-3.5 opacity-50" />
                                              <span className="truncate max-w-[160px]">{file.name}</span>
                                              {isError ? <span className="text-[10px]">Upload failed</span> : null}
                                            </>
                                          );
                                          return isDownloadable ? (
                                            <button
                                              key={file.id}
                                              type="button"
                                              onClick={() => handleFileDownload(file)}
                                              className={`${baseClass} ${toneClass} hover:bg-zinc-50 dark:hover:bg-white/10`}
                                            >
                                              {content}
                                            </button>
                                          ) : (
                                            <span key={file.id} className={`${baseClass} ${toneClass}`}>
                                              {content}
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
                        </motion.div>
                      );
                    })}
                    {isTyping && showThinkingIndicator && (
                      <div className="flex items-center gap-2 pl-4 py-2 opacity-50">
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">Thinking...</div>

                        <div className="flex space-x-1">
                          <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.32s]" />
                          <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.16s]" />
                          <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" />
                        </div>
                      </div>
                    )}
                    <div ref={setMessagesEndEl} />
                  </div>

                  {/* Input Area */}
                  <div className="px-4 sm:px-6 pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)] shrink-0">
                    <div className="rounded-[24px] sm:rounded-[32px] p-2.5 sm:p-3 transition-all duration-300 relative border border-default bg-elevated/85 dark:bg-tertiary/80 backdrop-blur-xl shadow-sm">
                      {visibleConnectionBannerMode ? (
                        <div
                          className="px-3 pt-2 pb-1 flex items-start justify-between gap-3"
                          role="status"
                          aria-live="polite"
                        >
                          <div className="flex items-start gap-2 min-w-0">
                            <span
                              className="inline-flex mt-0.5 h-3 w-3 animate-spin rounded-full border-2 border-zinc-400/70 dark:border-white/30 border-t-transparent"
                              aria-hidden="true"
                            />
                            <div className="min-w-0">
                              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                {visibleConnectionBannerMode === "reconnecting"
                                  ? "Reconnecting… (live updates paused)"
                                  : "Agent is running…"}
                              </div>
                              {shouldShowBannerActions ? (
                                <div className="mt-1 flex items-center gap-3">
                                  {canGoToAgentView ? (
                                    <button
                                      type="button"
                                      onClick={goToAgentNow}
                                      className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 underline underline-offset-2"
                                    >
                                      Go to agent view
                                    </button>
                                  ) : null}
                                  {canCheckAgentNow ? (
                                    <button
                                      type="button"
                                      onClick={checkAgentNow}
                                      className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 underline underline-offset-2"
                                    >
                                      Check now
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      {queuedSendCount > 0 &&
                        (() => {
                          const next = queuedSendsRef.current[0];
                          const previewRaw = typeof next?.content === "string" ? next.content : "";
                          const preview = previewRaw.replace(/\s+/g, " ").trim();
                          const previewText = preview.length > 90 ? `${preview.slice(0, 87)}…` : preview;
                          const nextFileCount = Array.isArray(next?.files) ? next.files.length : 0;
                          const showSendNowHint = !inputValue.trim() && attachedFiles.length === 0;

                          return (
                            <div className="px-3 pt-2 pb-1 flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                                  Queued: {queuedSendCount} message{queuedSendCount === 1 ? "" : "s"}
                                  {previewText ? ` — ${previewText}` : ""}
                                  {nextFileCount > 0 ? ` (${nextFileCount} file${nextFileCount === 1 ? "" : "s"})` : ""}
                                  {queuedSendCount > 1 ? ` (+${queuedSendCount - 1} more)` : ""}
                                </div>
                                {showSendNowHint ? (
                                  <div className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                    Press Enter again to send now
                                  </div>
                                ) : null}
                              </div>

                              <div className="flex items-center gap-3 shrink-0">
                                <button
                                  type="button"
                                  onClick={editNextQueuedSend}
                                  className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 underline underline-offset-2"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={clearQueuedSends}
                                  className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 underline underline-offset-2"
                                >
                                  Clear
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                      {attachedFiles.length > 0 && (
                        <div className="px-3 pt-2 pb-2 flex flex-wrap gap-2">
                          {attachedFiles.map((file) => (
                            <div key={file.id} className="flex items-center gap-2 text-xs bg-white dark:bg-white/5 px-2.5 py-1.5 rounded-full border border-zinc-100 dark:border-white/5 shadow-sm">
                              <span className="truncate max-w-[100px]">{file.name}</span>
                              {isUploadingFiles ? (
                                <span className="text-[10px] text-zinc-400">Uploading…</span>
                              ) : (
                                <button onClick={() => removeFile(file.id)} className="hover:text-red-400"><X className="w-3 h-3" /></button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex items-end gap-2.5 p-1.5">
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept=".csv,.json,.jsonl,.parquet,.xlsx"
                          onChange={handleFileSelect}
                          disabled={isChatInteractionDisabled}
                          className="hidden"
                        />
                        <div ref={chatAttachMenuRef} className="relative">
                          <button
                            onClick={() => openAttachMenu("chat")}
                            disabled={isChatInteractionDisabled}
                            className="h-11 w-11 inline-flex items-center justify-center rounded-full border border-default bg-tertiary/80 text-zinc-500 hover:bg-tertiary transition-colors dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
                            aria-haspopup="menu"
                            aria-expanded={attachMenuOpen === "chat"}
                          >
                            <Plus className="w-5 h-5" />
                          </button>
                          <ComposerAttachMenu
                            open={attachMenuOpen === "chat"}
                            isDark={isDark}
                            onUploadFiles={attachViaUpload}
                            onConnectGithub={attachViaGithubIntegration}
                            onConnectHuggingFace={attachViaHuggingFaceIntegration}
                          />
                        </div>
                        <textarea
                          ref={textareaRef}
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder={composerPlaceholder}
                          rows={1}
                          disabled={isChatInteractionDisabled}
                          className="flex-1 min-h-[44px] bg-transparent border-0 focus:ring-0 resize-none py-2.5 text-[16px] sm:text-[15px] max-h-32 placeholder:text-zinc-400 text-zinc-900 dark:text-zinc-100 disabled:opacity-60 disabled:cursor-not-allowed"
                        />
                        <button
                          onClick={() => handleSend()}
                          disabled={!canSend}
                          className={`h-11 w-11 inline-flex items-center justify-center rounded-full transition-all duration-200 shrink-0 ${canSend
                            ? 'bg-zinc-900 dark:bg-white text-white dark:text-black shadow-md hover:scale-105 active:scale-95'
                            : 'bg-zinc-200 dark:bg-white/5 text-zinc-400 dark:text-white/20'
                            }`}
                        >
                          <ArrowUp className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              </motion.div>

              {/* RIGHT PANEL: Canvas & Resize Handle */}
              <AnimatePresence>
                {isSplitView && (
                  <>
                    {/* Resize Handle */}
                    {!isDesktopTakeoverActive ? (
                      <div
                        className="relative w-2.5 h-full cursor-col-resize flex items-center justify-center transition-colors z-50 group shrink-0"
                        onMouseDown={startResizing}
                      >
                        <div className="h-20 w-1.5 rounded-full bg-zinc-200/70 dark:bg-white/10 group-hover:bg-zinc-300/80 dark:group-hover:bg-white/20 transition-colors" />
                      </div>
                    ) : null}

                    <motion.div
                      layout
                      initial={{ opacity: 0, width: 0 }}
                      animate={{
                        opacity: 1,
                        width: `${canvasWidth}%`
                      }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{
                        duration: isResizing ? 0 : 0.6,
                        ease: [0.19, 1, 0.22, 1]
                      }}
                      className="relative h-full py-4 pr-4 pl-2"
                    >
                      <motion.div
                        className={`h-full w-full rounded-[28px] overflow-hidden flex flex-col relative glass-panel macos-frame ${
                          isDark ? "glass-panel-strong" : ""
                        }`}
                        initial={{ opacity: 0, scale: 0.95, x: 20 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        transition={{ delay: 0.2, duration: 0.4 }}
                      >
                        {/* Window Controls (Mac-style) */}
                        <div className="h-14 flex items-center px-5 shrink-0 gap-3 relative glass-header macos-titlebar">
                          <div className="flex gap-2 mr-1 relative z-10">
                            {canCloseCanvas ? (
                              <button
                                onClick={closeCanvas}
                                className="w-3 h-3 rounded-full bg-red-400/90 hover:bg-red-500 transition-colors ring-1 ring-black/10 dark:ring-white/10"
                              />
                            ) : null}
                            <div className="w-3 h-3 rounded-full bg-amber-400/90 ring-1 ring-black/10 dark:ring-white/10" />
                            <div className="w-3 h-3 rounded-full bg-green-400/90 ring-1 ring-black/10 dark:ring-white/10" />
                          </div>
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className={`text-[13px] font-semibold tracking-tight ${isDark ? "text-white/90" : "text-zinc-800"}`}>
                              Tuna&apos;s Computer
                            </div>
                          </div>
                          <div className="flex-1" />
                          <button
                            type="button"
                            onClick={openFilesDrawer}
                            className={`relative z-10 p-2 rounded-full border transition-colors ${
                              isDark
                                ? "border-white/10 hover:bg-white/10 text-white/80"
                                : "border-zinc-200/70 hover:bg-zinc-50 text-zinc-700"
                            }`}
                            title="Files"
                          >
                            <FolderOpen className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Canvas Content */}
                        <div className="relative flex-1 overflow-y-auto bg-primary/70 p-2 sm:p-3">
                          {openPanels.length === 0 ? null : (
                            <div className="space-y-3">
                              {activePanel
                                ? renderPanelShell(activePanel, renderPanelContent(activePanel))
                                : null}
                            </div>
                          )}

                          {isCanvasLoading ? (
                            <div className="pointer-events-none absolute inset-x-3 top-3 rounded-full glass-subtle px-3 py-2 shadow-sm">
                              <div className="flex items-center justify-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                                <span>Updating canvas…</span>
                                <div className="flex space-x-1">
                                  <div className="w-1.5 h-1.5 bg-zinc-400/80 rounded-full animate-bounce [animation-delay:-0.32s]" />
                                  <div className="w-1.5 h-1.5 bg-zinc-400/80 rounded-full animate-bounce [animation-delay:-0.16s]" />
                                  <div className="w-1.5 h-1.5 bg-zinc-400/80 rounded-full animate-bounce" />
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="border-t border-black/5 dark:border-white/10">
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
                              setTimelinePlayback("paused");
                              setCursorAndOpenFrame(idx);
                            }}
                            onScrubCommit={(idx) => {
                              setTimelinePlayback("paused");
                              setCursorAndOpenFrame(idx);
                            }}
                            onStep={(delta) => stepTimeline(delta)}
                            onTogglePlay={toggleTimelinePlay}
                            onJumpToLive={jumpToLive}
                          />
                        </div>
                      </motion.div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>

              {/* MOBILE: Artifact fullscreen modal */}
              <AnimatePresence>
                {openPanels.length > 0 && !isLgUp && mobilePane === "canvas" && (
                  <motion.div
                    className="fixed inset-0 z-[90]"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <div
                      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                      onClick={closeCanvas}
                    />

                    <motion.div
                      initial={{ y: 24, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ y: 24, opacity: 0 }}
                      transition={{ type: "spring", stiffness: 260, damping: 30 }}
                      className="absolute inset-0 flex flex-col bg-secondary/90"
                    >
                      <div className="shrink-0 flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 relative glass-header">
                        <button
                          type="button"
                          aria-label="Back to chat"
                          onClick={closeCanvas}
                          className="p-2.5 rounded-full border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 hover:bg-white/90 dark:hover:bg-white/10 text-zinc-900 dark:text-white transition-colors"
                        >
                          <X className="w-5 h-5" />
                        </button>
                        <div className="flex-1" />
                        <button
                          type="button"
                          aria-label="Open files"
                          onClick={openFilesDrawer}
                          className="p-2.5 rounded-full border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 hover:bg-white/90 dark:hover:bg-white/10 text-zinc-900 dark:text-white transition-colors"
                        >
                          <FolderOpen className="w-5 h-5" />
                        </button>
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className={`text-[15px] font-semibold tracking-tight ${isDark ? "text-white/90" : "text-zinc-800"}`}>
                            Tuna&apos;s Computer
                          </div>
                        </div>
                      </div>

                      <div className="relative flex-1 min-h-0 overflow-y-auto bg-primary/70 p-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
                        {openPanels.length === 0 ? null : (
                          <div className="space-y-3">
                            {activePanel
                              ? renderPanelShell(activePanel, renderPanelContent(activePanel))
                              : null}
                          </div>
                        )}

                        {isCanvasLoading ? (
                          <div className="pointer-events-none absolute inset-x-3 top-3 rounded-full glass-subtle px-3 py-2 shadow-sm">
                            <div className="flex items-center justify-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                              <span>Updating canvas…</span>
                              <div className="flex space-x-1">
                                <div className="w-1.5 h-1.5 bg-zinc-400/80 rounded-full animate-bounce [animation-delay:-0.32s]" />
                                <div className="w-1.5 h-1.5 bg-zinc-400/80 rounded-full animate-bounce [animation-delay:-0.16s]" />
                                <div className="w-1.5 h-1.5 bg-zinc-400/80 rounded-full animate-bounce" />
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="shrink-0 border-t border-black/5 dark:border-white/10 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
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
                            setTimelinePlayback("paused");
                          setCursorAndOpenFrame(idx);
                          }}
                          onScrubCommit={(idx) => {
                            setTimelinePlayback("paused");
                          setCursorAndOpenFrame(idx);
                          }}
                          onStep={(delta) => stepTimeline(delta)}
                          onTogglePlay={toggleTimelinePlay}
                          onJumpToLive={jumpToLive}
                        />
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </AnimatePresence>
        </div>
      </main>
      <FilesDrawer
        open={isFilesDrawerOpen}
        onClose={closeFilesDrawer}
        onAttach={attachFromDrawer}
        isDark={isDark}
      />
      <CreditsModal
        open={isCreditsOpen}
        onClose={closeCredits}
        isDark={isDark}
        themePreference={themePreference}
        initialTab={creditsTab}
        initialProfileTab={creditsProfileTab}
        initialIntegrationProvider={creditsIntegrationProvider}
        onThemeChange={(next) => applyThemePreference(next)}
      />
      <ShareChatModal
        open={isShareOpen}
        onClose={() => setIsShareOpen(false)}
        chatId={currentChatId ?? ""}
        chatTitle={currentChatTitle}
        previewMessages={messages}
        isDark={isDark}
      />
      </div>
    </ArtifactScopeProvider>
  );
}

export default function Page() {
  return null;
}

