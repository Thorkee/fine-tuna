"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, ExternalLink, ScanSearch } from "lucide-react";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";

type ArtifactVariant = "canvas" | "inline";

export default function ResearchArtifact(
    props: { variant?: ArtifactVariant; dataOverride?: unknown; artifactId?: string } = {}
) {
    const variant: ArtifactVariant = props.variant ?? "canvas";
    const dataOverride = props.dataOverride;
    const artifactId = props.artifactId ?? "research";
    const { artifacts } = useProjectArtifacts();
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

    type SearchResult = {
        title: string;
        url: string;
        domain?: string;
        score?: number;
        publishedDate?: string;
        highlights?: string[];
        textSnippet?: string;
    };

    type WebSearchData = {
        kind: string;
        provider?: string;
        query?: string;
        queries?: string[];
        performedAt?: string;
        type?: string;
        category?: string | null;
        numResults?: number;
        results?: SearchResult[];
        batches?: {
            query: string;
            performedAt?: string;
            numResults?: number;
            results?: SearchResult[];
        }[];
    };

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
        const results = (v as Record<string, unknown>).results;
        if (results === undefined) return true;
        if (!Array.isArray(results)) return false;
        return results.every(isSearchResult);
    }

    const data = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === artifactId);
        return a?.data as unknown;
    }, [artifacts, artifactId, dataOverride]);

    const parsed = isWebSearchData(data) ? data : null;
    const results = parsed?.results || [];
    const isLoading = dataOverride === undefined && data === undefined;

    const meta = useMemo(() => {
        if (!parsed) return null;
        const performedAt = parsed.performedAt ? new Date(parsed.performedAt) : null;
        const performedAtLabel = performedAt && !Number.isNaN(performedAt.getTime())
            ? performedAt.toLocaleString()
            : undefined;
        return {
            query: parsed.query,
            queries: Array.isArray(parsed.queries) ? parsed.queries : undefined,
            provider: parsed.provider,
            type: parsed.type,
            category: parsed.category ?? undefined,
            performedAtLabel,
        };
    }, [parsed]);

    const handleCopy = async (idx: number, title: string, url: string) => {
        const citation = `[${idx + 1}] ${title} — ${url}`;
        try {
            await navigator.clipboard.writeText(citation);
            setCopiedIndex(idx);
            window.setTimeout(() => setCopiedIndex(null), 1200);
        } catch {
            // ignore
        }
    };

    const renderEmphasis = (text: string) => {
        // Search highlights sometimes include <em>...</em>. Render only that tag safely.
        const nodes: ReactNode[] = [];
        let rest = text;
        let k = 0;
        while (true) {
            const start = rest.indexOf("<em>");
            const end = rest.indexOf("</em>");
            if (start === -1 || end === -1 || end < start) {
                if (rest) nodes.push(rest);
                break;
            }
            const before = rest.slice(0, start);
            const inside = rest.slice(start + 4, end);
            if (before) nodes.push(before);
            if (inside) {
                nodes.push(
                    <mark
                        key={k}
                        className="rounded px-1 py-0.5 bg-[hsl(var(--accent-blue)/0.18)] text-primary"
                    >
                        {inside}
                    </mark>
                );
                k += 1;
            }
            rest = rest.slice(end + 5);
        }
        return nodes;
    };

    const getDomain = (url: string, fallback?: string) => {
        if (fallback) return fallback;
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch {
            return undefined;
        }
    };

    const formatDate = (value?: string) => {
        if (!value) return undefined;
        const parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) return undefined;
        return parsedDate.toLocaleDateString();
    };

    if (variant === "inline") {
        const sourcesCount =
            typeof parsed?.numResults === "number"
                ? parsed.numResults
                : results.length;

        return (
            <div className="p-4">
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {meta?.query ? (
                        <>
                            Query: <span className="text-zinc-800 dark:text-zinc-200">{meta.query}</span>
                        </>
                    ) : meta?.queries && meta.queries.length > 0 ? (
                        <>
                            Queries: <span className="text-zinc-800 dark:text-zinc-200">{meta.queries.length}</span>
                        </>
                    ) : (
                        "Web search"
                    )}
                    {meta?.performedAtLabel ? <span> · {meta.performedAtLabel}</span> : null}
                    {sourcesCount > 0 ? <span> · {sourcesCount} sources</span> : null}
                </div>

                {results.length === 0 ? (
                    isLoading ? (
                        <ArtifactLoadingState
                            variant="inline"
                            title="Collecting sources..."
                            className="mt-3 text-sm text-zinc-500 dark:text-zinc-400"
                        />
                    ) : (
                        <div className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                            No web search results yet.
                        </div>
                    )
                ) : (
                    <div className="relative mt-4 pl-5">
                        <div className="absolute left-2 top-1 bottom-1 w-px bg-zinc-200 dark:bg-white/10" />
                        <div className="space-y-3">
                            {results.map((r, idx) => {
                                const domain = getDomain(r.url, r.domain);
                                const snippet = Array.isArray(r.highlights) && r.highlights.length > 0
                                    ? r.highlights[0]
                                    : r.textSnippet;
                                return (
                                    <div key={`${r.url}-${idx}`} className="relative">
                                        <div className="absolute left-[7px] top-[6px] w-2 h-2 rounded-full bg-zinc-300 dark:bg-white/30" />
                                        <div className="ml-4">
                                            <a
                                                href={r.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="block text-sm text-zinc-900 dark:text-zinc-100 hover:underline truncate"
                                            >
                                                {r.title}
                                            </a>
                                            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 truncate">
                                                {domain ? `${domain} · ` : null}
                                                {r.url}
                                            </div>
                                            {snippet ? (
                                                <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">
                                                    {renderEmphasis(snippet)}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col p-3 sm:p-4 animate-fade-in-up">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                    <h2 className="text-lg sm:text-xl font-semibold mb-1 text-primary flex items-center gap-2">
                        <ScanSearch className="w-5 h-5 text-[hsl(var(--accent-blue))]" />
                        Web Search
                    </h2>
                    <p className="text-[12px] text-muted">
                        {meta?.query ? (
                            <>
                                Results for <span className="font-medium text-primary">“{meta.query}”</span>
                                {meta.performedAtLabel ? <span className="text-muted"> · {meta.performedAtLabel}</span> : null}
                            </>
                        ) : meta?.queries && meta.queries.length > 0 ? (
                            <>
                                Results for <span className="font-medium text-primary">{meta.queries.length} queries</span>
                                {meta.performedAtLabel ? <span className="text-muted"> · {meta.performedAtLabel}</span> : null}
                            </>
                        ) : (
                            "Search the web and collect sources."
                        )}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full border border-zinc-200/60 dark:border-white/10 bg-white/50 dark:bg-white/5 text-[11px] text-muted">
                        {typeof parsed?.numResults === "number" ? parsed.numResults : results.length} sources
                    </span>
                </div>
            </div>

            {results.length === 0 ? (
                <div className="card p-4">
                    {isLoading ? (
                        <ArtifactLoadingState
                            variant="inline"
                            title="Collecting sources..."
                            className="text-[12px] text-muted"
                        />
                    ) : (
                        <p className="text-[12px] text-muted">
                            No web search results yet. Ask the agent to “search the web for …” and this panel will populate with sources.
                        </p>
                    )}
                </div>
            ) : (
                <div className="card p-4">
                    <div className="space-y-3">
                        {results.map((r, idx) => {
                            const isCopied = copiedIndex === idx;
                            const domain = getDomain(r.url, r.domain);
                            const publishedLabel = formatDate(r.publishedDate);
                            const snippet = Array.isArray(r.highlights) && r.highlights.length > 0
                                ? r.highlights[0]
                                : r.textSnippet;
                            return (
                                <div
                                    key={`${r.url}-${idx}`}
                                    className="rounded-lg border border-zinc-200/60 dark:border-white/10 bg-white/50 dark:bg-white/5 p-3 sm:p-4"
                                >
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-100 dark:bg-white/10 text-zinc-500 dark:text-zinc-300 font-medium">
                                                        {idx + 1}
                                                    </span>
                                                    {domain ? <span>{domain}</span> : null}
                                                    {publishedLabel ? <span>· {publishedLabel}</span> : null}
                                                </div>
                                                <a
                                                    href={r.url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="mt-2 text-[13px] font-semibold text-primary hover:underline inline-flex items-center gap-2"
                                                >
                                                    <span className="line-clamp-2">{r.title}</span>
                                                    <ExternalLink className="w-3.5 h-3.5 opacity-60 shrink-0" />
                                                </a>
                                                <div className="mt-1 text-[10px] text-muted truncate" title={r.url}>
                                                    {r.url}
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <a
                                                    href={r.url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full border border-zinc-200 dark:border-white/10 text-[11px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
                                                >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                    Open
                                                </a>
                                                <button
                                                    onClick={() => handleCopy(idx, r.title, r.url)}
                                                    className="shrink-0 inline-flex items-center gap-2 px-2 py-1 rounded-full border border-zinc-200 dark:border-white/10 text-[11px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
                                                    title="Copy citation"
                                                >
                                                    {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                    {isCopied ? "Copied" : "Copy"}
                                                </button>
                                            </div>
                                        </div>

                                        {snippet ? (
                                            <div className="text-[12px] text-secondary leading-relaxed">
                                                {renderEmphasis(snippet)}
                                            </div>
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

export function CurationArtifact(props: { dataOverride?: unknown } = {}) {
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();
    const resolvedData = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === "curation");
        return a?.data as unknown;
    }, [artifacts, dataOverride]);

    const hasRenderableData = Boolean(
        resolvedData !== undefined &&
        resolvedData !== null &&
        !(typeof resolvedData === "string" && !resolvedData.trim())
    );

    const [activeStage, setActiveStage] = useState(0);

    useEffect(() => {
        if (hasRenderableData) return;
        const reset = window.setTimeout(() => setActiveStage(0), 0);
        const timer = window.setInterval(() => {
            setActiveStage((s) => Math.min(s + 1, 4));
        }, 1000);
        return () => {
            window.clearTimeout(reset);
            window.clearInterval(timer);
        };
    }, [hasRenderableData]);

    if (hasRenderableData) {
        return (
            <div className="h-full overflow-y-auto animate-fade-in-up">
                <GenericArtifactRenderer artifactId="curation" dataOverride={resolvedData} />
            </div>
        );
    }

    const stages = ["Raw Data", "Cleaning", "Schema Mapping", "Ready"];

    return (
        <div className="h-full flex flex-col items-center justify-center p-3 sm:p-4 animate-fade-in-up">
            <div className="w-full max-w-2xl">
                <h2 className="text-lg sm:text-xl font-semibold mb-2 text-primary text-center">Data Curation</h2>
                    <p className="text-[12px] text-muted mb-4 text-center">Preprocessing, cleaning, and structuring collected data</p>

                <div className="card p-5">
                    <div className="flex items-center justify-between relative mb-6">
                        {/* Connecting Line */}
                        <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-tertiary -z-10 -translate-y-1/2 rounded-full" />
                        <div
                            className="absolute top-1/2 left-0 h-0.5 bg-[hsl(var(--accent-violet))] -z-10 -translate-y-1/2 rounded-full transition-all duration-1000 ease-out"
                            style={{ width: `${(activeStage / 3) * 100}%` }}
                        />

                        {stages.map((stage, i) => (
                            <div key={stage} className="flex flex-col items-center gap-3 relative">
                                <div className={`
                                    w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-500 z-10 bg-[var(--background)]
                                    ${i <= activeStage
                                        ? "border-[hsl(var(--accent-violet))] text-[hsl(var(--accent-violet))]"
                                        : "border-tertiary text-muted"
                                    }
                                `}>
                                    {i < activeStage ? (
                                        <Check className="w-4 h-4" />
                                    ) : (
                                        <span className="text-[12px] font-semibold">{i + 1}</span>
                                    )}
                                </div>
                                <span className={`text-[12px] font-medium transition-colors duration-300 ${i <= activeStage ? "text-primary" : "text-muted"}`}>
                                    {stage}
                                </span>
                            </div>
                        ))}
                    </div>

                    <div className="text-center">
                        <div className="h-12 flex items-center justify-center">
                            {activeStage < 3 ? (
                                <p className="text-secondary animate-pulse px-3 py-1.5 rounded-lg bg-secondary/50 inline-block text-[12px]">
                                    Processing: {stages[activeStage]}...
                                </p>
                            ) : (
                                <div className="animate-scale-bounce">
                                    <p className="text-[hsl(var(--accent-green))] font-semibold text-[13px] flex items-center gap-2">
                                        <Check className="w-4 h-4" />
                                        Data curation complete!
                                    </p>
                                    <p className="text-[11px] text-muted mt-1.5">5,300 records processed and ready for training</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
