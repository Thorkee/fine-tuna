"use client";

import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Cpu, Database, ExternalLink, Sparkles } from "lucide-react";

import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";
import { useArtifactChatId } from "@/lib/artifact-scope";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import {
  fileNameFromUrl,
  looksLikeImageUrl,
  openUrlInNewTab,
  parseSupabaseStorageUrl,
} from "@/lib/client/storage-links";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function escapeTableCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return raw.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br />");
}

function formatMarkdownTable(headers: string[], rows: unknown[][]): string {
  if (headers.length === 0) return "";
  const headerLine = `| ${headers.map((h) => escapeTableCell(h)).join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => {
    const cells = headers.map((_, idx) => escapeTableCell(row[idx]));
    return `| ${cells.join(" | ")} |`;
  });
  return [headerLine, separatorLine, ...rowLines].join("\n");
}

function deepFindByKey(value: unknown, targetKey: string, maxDepth: number): unknown | undefined {
  if (!targetKey) return undefined;
  if (maxDepth < 0) return undefined;
  if (!value) return undefined;

  if (isRecord(value)) {
    if (targetKey in value) return value[targetKey];

    // Prefer common wrapper keys first.
    for (const wrapper of ["tables", "payload", "result", "output", "data"]) {
      const inner = (value as Record<string, unknown>)[wrapper];
      if (!inner) continue;
      const found = deepFindByKey(inner, targetKey, maxDepth - 1);
      if (found !== undefined) return found;
    }

    for (const v of Object.values(value)) {
      const found = deepFindByKey(v, targetKey, maxDepth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindByKey(item, targetKey, maxDepth - 1);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function toMarkdownTable(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(isRecord)) {
      const rows = value as Record<string, unknown>[];
      const headers = Object.keys(rows[0] ?? {});
      const body = rows.map((row) => headers.map((h) => row[h]));
      const rendered = formatMarkdownTable(headers, body);
      return rendered || null;
    }
    if (value.every(Array.isArray)) {
      const rows = value as unknown[][];
      const firstRow = rows[0] ?? [];
      const firstRowStrings = firstRow.every((cell) => typeof cell === "string");
      const headers = firstRowStrings
        ? (firstRow as string[])
        : firstRow.map((_, idx) => `col_${idx + 1}`);
      const body = firstRowStrings ? rows.slice(1) : rows;
      const rendered = formatMarkdownTable(headers, body);
      return rendered || null;
    }
    return null;
  }
  if (isRecord(value)) {
    // Allow embedding plain markdown blocks (not just tables)
    const markdownCandidate = (() => {
      const candidates = [value.markdown, value.content, value.text, value.body];
      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c.trim();
      }
      return null;
    })();
    if (markdownCandidate) return markdownCandidate;

    const columns = Array.isArray(value.columns) ? value.columns : null;
    const rows = Array.isArray(value.rows) ? value.rows : null;
    if (columns && rows) {
      const headers = columns.map((col) => String(col));
      const body = rows.map((row) => {
        if (Array.isArray(row)) return row;
        if (isRecord(row)) return headers.map((h) => (row as Record<string, unknown>)[h]);
        return [];
      });
      const rendered = formatMarkdownTable(headers, body);
      return rendered || null;
    }
    if (Array.isArray(value.data)) {
      return toMarkdownTable(value.data);
    }
  }
  return null;
}

function expandMarkdownTables(
  markdown: string,
  data: unknown,
  lookupArtifactData?: (id: string) => unknown
): string {
  return markdown.replace(
    /^\s*(?:[-*+]\s+)?([a-zA-Z0-9_-]+)\(markdown\)\s*$/gm,
    (match, key) => {
      const resolved =
        deepFindByKey(data, key, 4) ??
        lookupArtifactData?.(key);
      const rendered = toMarkdownTable(resolved);
      return rendered ?? match;
    }
  );
}

function extractMarkdown(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return null;

  const candidates = [
    data.markdown,
    data.content,
    data.text,
    data.body,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }

  return null;
}

function stripBoilerplate(markdown: string) {
  const junk = new Set([
    "type: markdown",
    "click to expand.",
    "artifact ready.",
    "details available.",
  ]);
  return markdown
    .split("\n")
    .filter((line) => !junk.has(line.trim().toLowerCase()))
    .join("\n")
    .trim();
}

type RankedCandidate = {
  rank?: number;
  title: string;
  url: string;
  domain?: string;
  tier?: string;
  totalScore?: number;
  publishedDate?: string | null;
  freshestBenchmarkDate?: string | null;
  sourceRelevance?: number | null;
  benchmarkSignalCount?: number;
  benchmarkDomainHits?: number;
  modelId?: string;
  usageHints?: unknown[];
};

type SourceCandidatesPayload = {
  kind: "dataset_candidates_v1" | "dataset_candidates_v2" | "model_candidates_v1" | "model_candidates_v2";
  query?: string;
  performedAt?: string;
  tierUsed?: string;
  policy?: Record<string, unknown>;
  attempts?: Array<Record<string, unknown>>;
  fallbackTelemetry?: Record<string, unknown>;
  candidates?: RankedCandidate[];
  recommended?: RankedCandidate | null;
};

function isRankedCandidate(value: unknown): value is RankedCandidate {
  if (!isRecord(value)) return false;
  return typeof value.title === "string" && typeof value.url === "string";
}

function isSourceCandidatesPayload(value: unknown): value is SourceCandidatesPayload {
  if (!isRecord(value)) return false;
  if (
    value.kind !== "dataset_candidates_v1" &&
    value.kind !== "dataset_candidates_v2" &&
    value.kind !== "model_candidates_v1" &&
    value.kind !== "model_candidates_v2"
  ) return false;
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates)) return false;
    if (!value.candidates.every(isRankedCandidate)) return false;
  }
  return true;
}

type HfHubSearchItem = {
  id: string;
  type?: "model" | "dataset" | "space";
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags?: string[];
  author?: string;
  pipelineTag?: string;
  sdk?: string;
  private?: boolean;
  gated?: boolean;
};

type HfHubSearchCanvasPayload = {
  kind: "hf_hub_search_canvas_v1";
  performedAt?: string;
  query?: string;
  type?: "model" | "dataset" | "space" | "all";
  limit?: number;
  results?: HfHubSearchItem[];
};

function isHfHubSearchItem(value: unknown): value is HfHubSearchItem {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  return true;
}

function isHfHubSearchCanvasPayload(value: unknown): value is HfHubSearchCanvasPayload {
  if (!isRecord(value)) return false;
  if (value.kind !== "hf_hub_search_canvas_v1") return false;
  if (value.results !== undefined) {
    if (!Array.isArray(value.results)) return false;
    if (!value.results.every(isHfHubSearchItem)) return false;
  }
  return true;
}

function buildHfHubItemUrl(id: string, type?: string): string {
  if (type === "dataset") return `https://huggingface.co/datasets/${id}`;
  if (type === "space") return `https://huggingface.co/spaces/${id}`;
  return `https://huggingface.co/${id}`;
}

function formatTypeLabel(value?: string): string {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "dataset") return "Dataset";
  if (normalized === "model") return "Model";
  if (normalized === "space") return "Space";
  if (normalized === "all") return "All";
  return "Mixed";
}

function formatNumeric(value: unknown, digits = 3): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toFixed(digits);
}

function formatCount(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(value);
  }
}

function formatDateLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

function getDomain(url: string, fallback?: string): string | null {
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function truncateText(input: string, max = 140): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const out = JSON.stringify(value);
    return out ?? String(value);
  } catch {
    return String(value);
  }
}

function safeParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type McpMarkdownPayload = {
  markdown: string;
  metadata?: Record<string, unknown>;
};

const MCP_METADATA_KEYS = [
  "title",
  "url",
  "sourceURL",
  "statusCode",
  "contentType",
  "language",
  "scrapeId",
  "cachedAt",
  "cacheState",
  "proxyUsed",
  "creditsUsed",
];

function pickMcpMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const key of MCP_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      trimmed[key] = metadata[key];
    }
  }
  return Object.keys(trimmed).length > 0 ? trimmed : metadata;
}

function formatMetadataMarkdown(metadata: Record<string, unknown>, includeSeparator: boolean): string {
  let json = "";
  try {
    json = JSON.stringify(pickMcpMetadata(metadata), null, 2);
  } catch {
    return "";
  }
  if (!json || json === "{}") return "";
  const separator = includeSeparator ? "\n\n---\n\n" : "";
  return `${separator}#### Metadata\n\n\`\`\`json\n${json}\n\`\`\``;
}

function extractMcpMarkdown(value: unknown, depth = 0): McpMarkdownPayload | null {
  if (!value || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractMcpMarkdown(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const directMarkdown = typeof value.markdown === "string" ? value.markdown.trim() : "";
  if (directMarkdown) {
    const metadata = isRecord(value.metadata) ? (value.metadata as Record<string, unknown>) : undefined;
    return { markdown: directMarkdown, metadata };
  }

  const content = Array.isArray(value.content) ? value.content : null;
  if (content) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text) continue;
      const parsed = safeParseJson(text);
      if (parsed && isRecord(parsed)) {
        const markdown = typeof parsed.markdown === "string" ? parsed.markdown.trim() : "";
        if (markdown) {
          const metadata = isRecord(parsed.metadata) ? (parsed.metadata as Record<string, unknown>) : undefined;
          return { markdown, metadata };
        }
      }
      const type = typeof item.type === "string" ? item.type : "";
      if (type === "markdown") return { markdown: text };
      if (type === "text") return { markdown: text };
    }
  }

  for (const key of ["result", "output", "data", "payload"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = extractMcpMarkdown((value as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function describeUsageHint(hint: unknown): { key: string; detail: string | null } | null {
  if (!isRecord(hint)) return null;
  const tool = typeof hint.tool === "string" ? hint.tool.trim() : "";
  if (!tool) return null;
  const field = typeof hint.field === "string" && hint.field.trim() ? `.${hint.field.trim()}` : "";
  const note = typeof hint.note === "string" && hint.note.trim() ? hint.note.trim() : null;
  const valueText =
    "value" in hint ? truncateText(safeStringify((hint as Record<string, unknown>).value), 120) : null;
  return {
    key: `${tool}${field}`,
    detail: note ?? valueText,
  };
}

export default function GenericArtifactRenderer(props: {
  artifactId: string;
  isDark?: boolean;
  dataOverride?: unknown;
  chatId?: string | null;
}) {
  const { artifactId, isDark = false, dataOverride, chatId: chatIdProp } = props;

  const { artifacts } = useProjectArtifacts();
  const artifact = useMemo(() => artifacts.find((a) => a.id === artifactId), [artifacts, artifactId]);
  const contextChatId = useArtifactChatId();
  const chatId = chatIdProp ?? contextChatId ?? "";

  const resolvedData = dataOverride !== undefined ? dataOverride : artifact?.data;
  const isLoading = dataOverride === undefined && (!artifact || resolvedData === undefined);
  if (isLoading) {
    return (
      <ArtifactLoadingState
        title={`Loading ${artifactId}...`}
        description="Waiting for the artifact output."
      />
    );
  }
  const sourceCandidates = isSourceCandidatesPayload(resolvedData) ? resolvedData : null;

  if (sourceCandidates) {
    const isDataset =
      sourceCandidates.kind === "dataset_candidates_v1" || sourceCandidates.kind === "dataset_candidates_v2";
    const Icon = isDataset ? Database : Cpu;
    const title = isDataset ? "Dataset Discovery" : "Model Discovery";
    const subtitle = isDataset
      ? "Ranked data sources by relevance, access, and freshness."
      : "Ranked open models by fit, benchmark evidence, and freshness.";
    const performedAtLabel = formatDateLabel(sourceCandidates.performedAt);
    const candidates = Array.isArray(sourceCandidates.candidates)
      ? sourceCandidates.candidates.filter(isRankedCandidate)
      : [];
    const recommended =
      sourceCandidates.recommended && isRankedCandidate(sourceCandidates.recommended)
        ? sourceCandidates.recommended
        : candidates[0] ?? null;
    const strictness =
      isRecord(sourceCandidates.policy) && typeof sourceCandidates.policy.strictness === "string"
        ? sourceCandidates.policy.strictness
        : null;
    const attempts = Array.isArray(sourceCandidates.attempts)
      ? sourceCandidates.attempts.filter(isRecord)
      : [];
    const desktopEscalationAllowed = (() => {
      const fallbackTelemetry = isRecord(sourceCandidates.fallbackTelemetry) ? sourceCandidates.fallbackTelemetry : null;
      const desktopEscalation = fallbackTelemetry && isRecord(fallbackTelemetry.desktopEscalation)
        ? fallbackTelemetry.desktopEscalation
        : null;
      return desktopEscalation && typeof desktopEscalation.allowed === "boolean"
        ? desktopEscalation.allowed
        : null;
    })();

    return (
      <div className="h-full overflow-y-auto p-3 sm:p-4 animate-fade-in-up">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg sm:text-xl font-semibold text-primary flex items-center gap-2">
              <Icon className="w-5 h-5 text-[hsl(var(--accent-blue))]" />
              {title}
            </h2>
            <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
              {sourceCandidates.query
                ? (
                    <>
                      Query: <span className="text-zinc-700 dark:text-zinc-200">&quot;{sourceCandidates.query}&quot;</span>
                    </>
                  )
                : subtitle}
            </p>
          </div>
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 sm:text-right">
            <div>{candidates.length} candidate{candidates.length === 1 ? "" : "s"}</div>
            {performedAtLabel ? <div>{performedAtLabel}</div> : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {sourceCandidates.tierUsed ? (
            <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
              Tier used: {sourceCandidates.tierUsed}
            </span>
          ) : null}
          {strictness ? (
            <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
              Policy: {strictness}
            </span>
          ) : null}
          {attempts.length > 0 ? (
            <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
              {attempts.length} tier attempt{attempts.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {desktopEscalationAllowed !== null ? (
            <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
              Desktop gate: {desktopEscalationAllowed ? "ready" : "blocked"}
            </span>
          ) : null}
        </div>

        {recommended ? (
          <div className="mt-4 rounded-xl border border-zinc-200/70 dark:border-white/10 bg-white dark:bg-white/5 p-3">
            <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              <Sparkles className="w-3.5 h-3.5" />
              Recommended
            </div>
            <a
              href={recommended.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
            >
              <span className="line-clamp-2">{recommended.title}</span>
              <ExternalLink className="w-3.5 h-3.5 opacity-60 shrink-0" />
            </a>
            <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {getDomain(recommended.url, recommended.domain) ?? "unknown source"}
              {recommended.tier ? ` · ${recommended.tier}` : ""}
              {formatNumeric(recommended.totalScore, 3) ? ` · score ${formatNumeric(recommended.totalScore, 3)}` : ""}
            </div>
          </div>
        ) : null}

        {candidates.length === 0 ? (
          <div className="mt-4 rounded-lg border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 p-3 text-sm text-zinc-500 dark:text-zinc-400">
            No ranked candidates found yet.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {candidates.map((candidate, idx) => {
              const scoreLabel = formatNumeric(candidate.totalScore, 3);
              const sourceRelevance = formatNumeric(candidate.sourceRelevance, 2);
              const benchmarkSignals =
                typeof candidate.benchmarkSignalCount === "number" && Number.isFinite(candidate.benchmarkSignalCount)
                  ? candidate.benchmarkSignalCount
                  : null;
              const benchmarkDomains =
                typeof candidate.benchmarkDomainHits === "number" && Number.isFinite(candidate.benchmarkDomainHits)
                  ? candidate.benchmarkDomainHits
                  : null;
              const timeLabel =
                formatDateLabel(candidate.freshestBenchmarkDate) ?? formatDateLabel(candidate.publishedDate);
              const usageHints = Array.isArray(candidate.usageHints)
                ? candidate.usageHints.map(describeUsageHint).filter((hint): hint is { key: string; detail: string | null } => Boolean(hint))
                : [];
              return (
                <div
                  key={`${candidate.url}-${idx}`}
                  className="rounded-lg border border-zinc-200/70 dark:border-white/10 bg-white/70 dark:bg-white/5 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-100 dark:bg-white/10 font-medium">
                          {candidate.rank ?? idx + 1}
                        </span>
                        <span>{getDomain(candidate.url, candidate.domain) ?? "unknown source"}</span>
                        {candidate.tier ? <span>· {candidate.tier}</span> : null}
                        {timeLabel ? <span>· {timeLabel}</span> : null}
                      </div>
                      <a
                        href={candidate.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
                      >
                        <span className="line-clamp-2">{candidate.title}</span>
                        <ExternalLink className="w-3.5 h-3.5 opacity-60 shrink-0" />
                      </a>
                      {candidate.modelId ? (
                        <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                          Model ID: <span className="font-mono">{candidate.modelId}</span>
                        </div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-zinc-500 dark:text-zinc-400">
                      {scoreLabel ? <div className="font-semibold text-zinc-700 dark:text-zinc-200">score {scoreLabel}</div> : null}
                      {sourceRelevance ? <div>source {sourceRelevance}</div> : null}
                      {benchmarkSignals !== null ? <div>signals {benchmarkSignals}</div> : null}
                      {benchmarkDomains !== null ? <div>bench {benchmarkDomains}</div> : null}
                    </div>
                  </div>
                  {usageHints.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {usageHints.slice(0, 3).map((hint, hintIdx) => (
                        <div
                          key={`${hint.key}-${hintIdx}`}
                          className="text-[11px] text-zinc-600 dark:text-zinc-300"
                        >
                          <span className="font-mono text-[10px]">{hint.key}</span>
                          {hint.detail ? <span> - {hint.detail}</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const hfHubSearch = isHfHubSearchCanvasPayload(resolvedData) ? resolvedData : null;
  if (hfHubSearch) {
    const typeLabel = typeof hfHubSearch.type === "string" ? hfHubSearch.type : undefined;
    const isDataset = typeLabel === "dataset";
    const isModel = typeLabel === "model";
    const isSpace = typeLabel === "space";
    const Icon = isDataset ? Database : isModel ? Cpu : Sparkles;
    const title = isDataset
      ? "Hugging Face Datasets"
      : isModel
        ? "Hugging Face Models"
        : isSpace
          ? "Hugging Face Spaces"
          : "Hugging Face Hub Results";
    const performedAtLabel = formatDateLabel(hfHubSearch.performedAt);
    const results = Array.isArray(hfHubSearch.results)
      ? hfHubSearch.results.filter(isHfHubSearchItem)
      : [];
    const showTypeColumn =
      typeLabel === "all" || results.some((item) => item.type && item.type !== typeLabel);

    return (
      <div className="h-full overflow-y-auto p-3 sm:p-4 animate-fade-in-up">
        <div className="card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg sm:text-xl font-semibold text-primary flex items-center gap-2">
                <Icon className="w-5 h-5 text-[hsl(var(--accent-blue))]" />
                {title}
              </h2>
              <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
                {hfHubSearch.query ? (
                  <>
                    Query: <span className="text-zinc-700 dark:text-zinc-200">&quot;{hfHubSearch.query}&quot;</span>
                  </>
                ) : (
                  "Browse Hugging Face Hub results."
                )}
              </p>
            </div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 sm:text-right">
              <div>{results.length} result{results.length === 1 ? "" : "s"}</div>
              {performedAtLabel ? <div>{performedAtLabel}</div> : null}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {typeLabel ? (
              <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
                Type: {formatTypeLabel(typeLabel)}
              </span>
            ) : null}
            {typeof hfHubSearch.limit === "number" ? (
              <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
                Limit: {hfHubSearch.limit}
              </span>
            ) : null}
            {results.length > 0 ? (
              <span className="px-2 py-0.5 rounded-full text-[11px] border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 text-zinc-600 dark:text-zinc-300">
                Showing {results.length}
              </span>
            ) : null}
          </div>

          {results.length === 0 ? (
            <div className="mt-4 rounded-lg border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5 p-3 text-sm text-zinc-500 dark:text-zinc-400">
              No Hub results found yet.
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[640px] w-full text-xs">
                <thead className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  <tr className="border-b border-zinc-200/70 dark:border-white/10">
                    <th className="py-2 text-left font-medium">Repository</th>
                    {showTypeColumn ? <th className="py-2 text-left font-medium">Type</th> : null}
                    <th className="py-2 text-right font-medium">Downloads</th>
                    <th className="py-2 text-right font-medium">Likes</th>
                    <th className="py-2 text-left font-medium">Last updated</th>
                    <th className="py-2 text-left font-medium">Tags</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-700 dark:text-zinc-200">
                  {results.map((item, idx) => {
                    const url = buildHfHubItemUrl(item.id, item.type ?? typeLabel);
                    const tags = Array.isArray(item.tags)
                      ? item.tags.filter(
                          (tag): tag is string => typeof tag === "string" && tag.trim().length > 0
                        )
                      : [];
                    const visibleTags = tags.slice(0, 5);
                    const extraTags = tags.length - visibleTags.length;
                    const updatedLabel = formatDateLabel(item.lastModified);
                    return (
                      <tr
                        key={`${item.id}-${idx}`}
                        className="border-b border-zinc-200/60 dark:border-white/10 hover:bg-zinc-50/70 dark:hover:bg-white/5"
                      >
                        <td className="py-3 pr-4 align-top">
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-2 font-medium text-primary hover:underline"
                          >
                            <span className="line-clamp-1">{item.id}</span>
                            <ExternalLink className="w-3.5 h-3.5 opacity-60 shrink-0" />
                          </a>
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                            {item.author ? <span>by {item.author}</span> : null}
                            {item.private ? (
                              <span className="px-1.5 py-0.5 rounded-full border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5">
                                private
                              </span>
                            ) : null}
                            {item.gated ? (
                              <span className="px-1.5 py-0.5 rounded-full border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5">
                                gated
                              </span>
                            ) : null}
                            {item.pipelineTag ? (
                              <span className="px-1.5 py-0.5 rounded-full border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5">
                                {item.pipelineTag}
                              </span>
                            ) : null}
                            {item.sdk ? (
                              <span className="px-1.5 py-0.5 rounded-full border border-zinc-200/70 dark:border-white/10 bg-zinc-50 dark:bg-white/5">
                                {item.sdk}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        {showTypeColumn ? (
                          <td className="py-3 pr-4 text-[11px] text-zinc-500 dark:text-zinc-400 align-top">
                            {formatTypeLabel(item.type ?? typeLabel)}
                          </td>
                        ) : null}
                        <td className="py-3 pr-4 text-right align-top">
                          {formatCount(item.downloads) ?? "—"}
                        </td>
                        <td className="py-3 pr-4 text-right align-top">
                          {formatCount(item.likes) ?? "—"}
                        </td>
                        <td className="py-3 pr-4 text-[11px] text-zinc-500 dark:text-zinc-400 align-top">
                          {updatedLabel ?? "—"}
                        </td>
                        <td className="py-3 align-top">
                          {visibleTags.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {visibleTags.map((tag) => (
                                <span
                                  key={tag}
                                  className="px-1.5 py-0.5 rounded-full border border-zinc-200/70 dark:border-white/10 bg-white/70 dark:bg-white/5 text-[10px] text-zinc-600 dark:text-zinc-300"
                                >
                                  {tag}
                                </span>
                              ))}
                              {extraTags > 0 ? (
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                  +{extraTags} more
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  const mcpPayload = extractMcpMarkdown(resolvedData);
  const baseMarkdown = mcpPayload?.markdown ?? extractMarkdown(resolvedData);
  const metadataBlock =
    mcpPayload?.metadata ? formatMetadataMarkdown(mcpPayload.metadata, Boolean(baseMarkdown && baseMarkdown.trim())) : "";
  const combinedMarkdown = [baseMarkdown, metadataBlock].filter(Boolean).join("");
  const cleanedMarkdown = combinedMarkdown ? stripBoilerplate(combinedMarkdown) : "";
  const expandedMarkdown = cleanedMarkdown
    ? expandMarkdownTables(cleanedMarkdown, resolvedData, (id) => artifacts.find((a) => a.id === id)?.data)
    : "";
  if (expandedMarkdown.trim()) {
    return (
      <div
        className={`prose prose-sm max-w-none break-words prose-p:break-words prose-li:break-words prose-blockquote:break-words prose-td:break-words prose-th:break-words prose-a:break-all p-4 dark:prose-invert ${
          isDark ? "prose-invert" : ""
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
                const label = fileNameFromUrl(url);
                return (
                  <button
                    type="button"
                    onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
                    className={[
                      "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                      isDark
                        ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                        : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                      className,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    title={url}
                  >
                    <span className="truncate">{label}</span>
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
                  onClick={() => void openUrlInNewTab(url, { chatId: chatId || undefined })}
                  className={[
                    "not-prose my-2 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                    isDark
                      ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                      : "border-zinc-200/70 bg-white text-zinc-700 hover:bg-zinc-50",
                    className,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={url}
                >
                  <span className="truncate">{fileNameFromUrl(url)}</span>
                  <span className="opacity-60 shrink-0">Open</span>
                </button>
              );
            },
          }}
        >
          {expandedMarkdown}
        </ReactMarkdown>
      </div>
    );
  }

  if (baseMarkdown?.trim()) {
    return (
      <div className="p-4">
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          <span className="font-mono">{artifact?.id ?? artifactId}</span>
          {artifact?.type ? <span className="ml-2">({artifact.type})</span> : null}
        </div>
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          Markdown content was empty (or filtered) and couldn&apos;t be rendered.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
        <span className="font-mono">{artifact?.id ?? artifactId}</span>
        {artifact?.type ? <span className="ml-2">({artifact.type})</span> : null}
      </div>
      <pre className="text-xs whitespace-pre-wrap break-words rounded-lg bg-zinc-50 dark:bg-white/5 border border-zinc-200/70 dark:border-white/10 p-3 text-zinc-800 dark:text-zinc-200">
        {JSON.stringify(resolvedData, null, 2)}
      </pre>
    </div>
  );
}

