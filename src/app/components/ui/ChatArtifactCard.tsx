"use client";

import { useMemo } from "react";
import {
  BarChart3,
  Cpu,
  Database,
  FileText,
  HelpCircle,
  LayoutGrid,
  ListChecks,
  Monitor,
  Plug,
  ScanSearch,
  Share2,
  Sparkles,
  Table,
  Terminal,
} from "lucide-react";

import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { isDeliverableArtifactId } from "@/lib/agent/artifact-mapping";

type SearchResult = { title: string; url: string };
type WebSearchData = { kind: string; query?: string; queries?: string[]; performedAt?: string; numResults?: number; results?: SearchResult[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isSearchResult(v: unknown): v is SearchResult {
  if (!isRecord(v)) return false;
  return typeof v.title === "string" && typeof v.url === "string";
}

function isWebSearchData(v: unknown): v is WebSearchData {
  if (!isRecord(v)) return false;
  if (typeof v.kind !== "string") return false;
  if (v.results === undefined) return true;
  if (!Array.isArray(v.results)) return false;
  return v.results.every(isSearchResult);
}

function getPresentation(artifactId: string): {
  title: string;
  Icon: typeof ListChecks;
} {
  const isResearch = artifactId === "research" || artifactId.startsWith("research-");
  if (artifactId.startsWith("clarification-")) {
    return { title: "Clarification", Icon: HelpCircle };
  }
  switch (artifactId) {
    case "plan":
      return { title: "Plan", Icon: ListChecks };
    case "research":
      return { title: "Web Search", Icon: ScanSearch };
    case "curation":
      return { title: "Data Curation", Icon: Database };
    case "analysis":
      return { title: "Data Analysis", Icon: BarChart3 };
    case "intent":
      return { title: "Intent", Icon: Sparkles };
    case "providers":
      return { title: "Compare Providers", Icon: LayoutGrid };
    case "training":
      return { title: "Training", Icon: Cpu };
    case "export":
      return { title: "Export", Icon: Share2 };
    case "connectors":
      return { title: "Connectors", Icon: Plug };
    case "sandbox":
      return { title: "Python Sandbox", Icon: Terminal };
    case "desktop":
      return { title: "Desktop", Icon: Monitor };
    case "document":
      return { title: "Document", Icon: FileText };
    case "spreadsheet":
      return { title: "Spreadsheet", Icon: Table };
    default:
      if (isResearch) return { title: "Web Search", Icon: ScanSearch };
      return { title: artifactId, Icon: LayoutGrid };
  }
}

type ChatArtifactCardVariant = "standalone" | "grouped";

export default function ChatArtifactCard(props: {
  artifactId: string;
  variant?: ChatArtifactCardVariant;
  titleOverride?: string;
  onSelect?: (artifactId: string) => void;
}) {
  const { artifactId, variant = "standalone", titleOverride, onSelect } = props;
  const { title, Icon } = useMemo(() => getPresentation(artifactId), [artifactId]);
  const displayTitle = titleOverride ?? title;
  const isDeliverable = isDeliverableArtifactId(artifactId);

  const { setActiveArtifact, artifacts } = useProjectArtifacts();
  const artifact = useMemo(() => artifacts.find(a => a.id === artifactId), [artifacts, artifactId]);

  const preview = useMemo(() => {
    if (!artifact) return "";

    const isResearch = artifactId === "research" || artifactId.startsWith("research-");
    if (isResearch && isWebSearchData(artifact.data)) {
      const query = artifact.data.query?.trim();
      if (query) return query;
      const queries = Array.isArray(artifact.data.queries) ? artifact.data.queries.filter(Boolean) : [];
      return queries.length === 1 ? queries[0] : "";
    }

    return "";
  }, [artifact, artifactId]);

  return (
    <div className={`not-prose ${variant === "grouped" ? "my-0 h-full" : "my-0"}`}>
      <button
        type="button"
        onClick={() => (onSelect ? onSelect(artifactId) : setActiveArtifact(artifactId))}
        className="w-full text-left rounded-lg glass-card px-3 py-2 hover:shadow-sm transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/20 dark:focus-visible:ring-white/15 focus-visible:ring-inset"
      >
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 w-3 h-3 shrink-0 text-zinc-500 dark:text-zinc-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0 text-[11px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {displayTitle}
              </div>
              {isDeliverable ? (
                <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300">
                  Deliverable
                </span>
              ) : null}
            </div>
            {preview ? (
              <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400 truncate">
                {preview}
              </div>
            ) : null}
          </div>
        </div>
      </button>
    </div>
  );
}

