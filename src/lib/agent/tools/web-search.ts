import 'server-only';

import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import {
    detectDiscoveryIntent,
    getTierDomains,
    getTierOrder,
    shouldEscalateTier,
    sourcePolicyFromConstraintConfig,
    type SourceDiscoveryIntent,
    type SourcePolicyStrictness,
    type SourceTier,
} from '../source-policy';
import { fetchExaContents, type WebFetchedPage } from './web-fetch';
import { uploadStorageObject } from '@/lib/supabase/storage';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const out = value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
        return out.length > 0 ? out : undefined;
    }
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return undefined;
}

function normalizeDomainFilters(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
}

const CONTENTS_ALLOWED_KEYS = new Set(['text', 'highlights']);

function normalizeContentsInput(value: unknown): unknown {
    if (!isRecord(value)) return value;

    const keys = Object.keys(value);
    if (keys.some(key => !CONTENTS_ALLOWED_KEYS.has(key))) {
        return value;
    }

    if ('text' in value && value.text !== undefined && !isRecord(value.text)) return value;
    if ('highlights' in value && value.highlights !== undefined && !isRecord(value.highlights)) return value;

    const text = isRecord(value.text) ? value.text : undefined;
    const highlights = isRecord(value.highlights) ? value.highlights : undefined;

    if (!text && !highlights) return undefined;

    if (text && highlights) {
        const hasTextOptions = Object.keys(text).length > 0;
        const hasHighlightOptions = Object.keys(highlights).length > 0;

        if (hasTextOptions && !hasHighlightOptions) return { text };
        if (hasHighlightOptions && !hasTextOptions) return { highlights };

        return { highlights };
    }

    return text ? { text } : { highlights };
}

function safeDomain(url: string): string | undefined {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return undefined;
    }
}

type NormalizedResult = {
    title: string;
    url: string;
    domain?: string;
    score?: number;
    publishedDate?: string;
    highlights?: string[];
    textSnippet?: string;
};

function safePathSegment(input: string): string {
    const s = (input || '').trim();
    if (!s) return 'unknown';
    return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

function canUseStoragePathSegment(value: string): boolean {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) return false;
    if (normalized.includes('\0')) return false;
    if (normalized.split('/').includes('..')) return false;
    return !normalized.startsWith('/');
}

function formatResearchNotesMd(input: {
    performedAt: string;
    query: string;
    searchResults: NormalizedResult[];
    fetchedPages: WebFetchedPage[];
}): string {
    const ts = input.performedAt;
    const lines: string[] = [];

    lines.push('', '', `## ${ts} — Web research`, '');
    lines.push(`**Query:** ${input.query}`, '');

    if (input.searchResults.length > 0) {
        lines.push('### Search results', '');
        for (const [i, r] of input.searchResults.entries()) {
            lines.push(`- [${i + 1}] ${r.title} — ${r.url}`);
        }
        lines.push('');
    }

    if (input.fetchedPages.length > 0) {
        lines.push('### Opened sources (highlights/summary)', '');
        for (const [i, p] of input.fetchedPages.entries()) {
            lines.push(`#### [${i + 1}] ${p.title ?? p.url}`, '');
            lines.push(p.url, '');

            if (typeof p.summary === 'string' && p.summary.trim()) {
                lines.push('**Summary:**', '');
                lines.push(p.summary.trim(), '');
            }

            if (Array.isArray(p.highlights) && p.highlights.length > 0) {
                lines.push('**Highlights:**', '');
                for (const h of p.highlights.slice(0, 8)) {
                    lines.push(`- ${h}`);
                }
                lines.push('');
            } else if (typeof p.textSnippet === 'string' && p.textSnippet.trim()) {
                lines.push('**Text snippet:**', '');
                lines.push(p.textSnippet.trim(), '');
            }

            if (p.status === 'error') {
                const tag = p.error?.tag ? ` (${p.error.tag})` : '';
                const code = typeof p.error?.httpStatusCode === 'number' ? ` HTTP ${p.error.httpStatusCode}` : '';
                lines.push(`_Fetch status: error${code}${tag}_`, '');
            }
        }
    }

    return lines.join('\n');
}

function pickResultsArray(data: unknown): unknown[] {
    if (!isRecord(data)) return [];
    const direct = data.results;
    if (Array.isArray(direct)) return direct;
    if (isRecord(direct) && Array.isArray(direct.results)) return direct.results;
    return [];
}

function normalizeResults(raw: unknown): NormalizedResult[] {
    const results = pickResultsArray(raw).slice(0, 15);

    return results
        .map((item) => {
            const r = isRecord(item) ? item : {};
            const url =
                typeof r.url === 'string'
                    ? r.url
                    : typeof r.link === 'string'
                        ? r.link
                        : '';
            if (!url) return null;

            const title =
                typeof r.title === 'string' && r.title.trim()
                    ? r.title.trim()
                    : url;

            const score = typeof r.score === 'number' ? r.score : undefined;

            const publishedDate =
                typeof r.publishedDate === 'string'
                    ? r.publishedDate
                    : typeof r.published_date === 'string'
                        ? r.published_date
                        : typeof r.published_at === 'string'
                            ? r.published_at
                            : undefined;

            const highlights =
                toStringArray(r.highlights) ??
                (isRecord(r.contents) ? toStringArray(r.contents.highlights) : undefined) ??
                (isRecord(r.content) ? toStringArray(r.content.highlights) : undefined);

            const text =
                typeof r.text === 'string'
                    ? r.text
                    : isRecord(r.contents) && typeof r.contents.text === 'string'
                        ? r.contents.text
                        : undefined;

            const textSnippet = text && text.trim()
                ? text.trim().slice(0, 800)
                : undefined;

            const clippedHighlights = highlights
                ?.slice(0, 6)
                .map(h => h.length > 500 ? `${h.slice(0, 500).trim()}…` : h);

            const out: NormalizedResult = { title, url };
            const domain = safeDomain(url);
            if (domain) out.domain = domain;
            if (typeof score === 'number') out.score = score;
            if (typeof publishedDate === 'string' && publishedDate.trim()) out.publishedDate = publishedDate.trim();
            if (Array.isArray(clippedHighlights) && clippedHighlights.length > 0) out.highlights = clippedHighlights;
            if (typeof textSnippet === 'string' && textSnippet.trim()) out.textSnippet = textSnippet.trim();
            return out;
        })
        .filter((v): v is NormalizedResult => Boolean(v));
}

// ============= Schemas =============

const contentsSchema = z.preprocess(
    normalizeContentsInput,
    z
        .object({
            text: z
                .object({
                    max_characters: z.number().int().min(1).max(50000).optional(),
                })
                .strict()
                .optional(),
            highlights: z
                .object({
                    num_sentences: z.number().int().min(1).max(10).optional(),
                    highlights_per_url: z.number().int().min(1).max(10).optional(),
                })
                .strict()
                .optional(),
        })
        .strict()
        .optional()
);

const webSearchArgsSchema = z
    .object({
        query: z.string().min(1).max(5000).optional(),
        queries: z.array(z.string().min(1).max(5000)).max(4).optional(),
        type: z.enum(['auto', 'fast']).optional(),
        num_results: z.number().int().min(1).max(15).optional(),
        browseIndices: z.array(z.number().int().min(1)).max(15).optional(),
        category: z.string().nullable().optional(),
        includeDomains: z.array(z.string().min(1)).optional(),
        excludeDomains: z.array(z.string().min(1)).optional(),
        maxAgeHours: z.number().int().optional(),
        contents: contentsSchema,
        // Agentic follow-up: after search, open sources + persist notes.
        browse: z.boolean().optional(),
        browseTopK: z.number().int().min(1).max(5).optional(),
        saveNotes: z.boolean().optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
        if (!val.query && (!val.queries || val.queries.length === 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Provide query or queries.',
                path: ['query'],
            });
        }
        const includeDomains = normalizeDomainFilters(val.includeDomains);
        const excludeDomains = normalizeDomainFilters(val.excludeDomains);
        if (includeDomains && excludeDomains) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'includeDomains and excludeDomains cannot be used together.',
                path: ['includeDomains'],
            });
        }
    });

// ============= Tool =============

export const webSearchTool: Tool = {
    category: 'data',
    definition: {
        name: 'web_search',
        description:
            'Search the live web using Exa (single query or parallel queries). Optionally opens top sources via Exa Contents and appends citations/notes to agent_notes/<projectId>/research.md. Server-side only.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                queries: { type: 'array', items: { type: 'string' }, description: 'Parallel search queries (up to 4)' },
                type: {
                    type: 'string',
                    enum: ['auto', 'fast'],
                    description: 'Search type: auto (balanced) or fast (lowest latency)',
                },
                num_results: { type: 'number', description: 'Number of results (1-15)' },
                category: {
                    type: 'string',
                    description: 'Optional Exa category filter (e.g. "news", "research paper"). Omit for no category.',
                },
                includeDomains: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional allowlist of domains to include (cannot be combined with excludeDomains)',
                },
                excludeDomains: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional blocklist of domains to exclude (cannot be combined with includeDomains)',
                },
                maxAgeHours: {
                    type: 'number',
                    description:
                        'Content freshness threshold in hours (omit for default). 0 = always livecrawl, -1 = cache only.',
                },
                contents: {
                    type: 'object',
                    description: 'Choose ONE: highlights (recommended) or text.',
                    properties: {
                        highlights: {
                            type: 'object',
                            properties: {
                                num_sentences: { type: 'number' },
                                highlights_per_url: { type: 'number' },
                            },
                        },
                        text: {
                            type: 'object',
                            properties: {
                                max_characters: { type: 'number' },
                            },
                        },
                    },
                },
                browse: {
                    type: 'boolean',
                    description:
                        'If true (default), after search the tool will open the top sources via Exa Contents and extract highlights/summary.',
                },
                browseTopK: { type: 'number', description: 'How many top results to open (1-5). Default: 3.' },
                browseIndices: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Optional 1-based indices of results to open instead of topK.',
                },
                saveNotes: {
                    type: 'boolean',
                    description:
                        'If true (default), append structured citations + extracted highlights into agent_notes/<projectId>/research.md (gitignored).',
                },
            },
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = webSearchArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }

        if (context.constraints?.allowWebSearch === false) {
            return { ok: false, error: { message: 'Web search is disabled for this request.', name: 'PolicyError' } };
        }

        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
            return {
                ok: false,
                error: { message: 'EXA_API_KEY is not configured on the server.', name: 'ConfigurationError' },
            };
        }

        const {
            query,
            queries,
            type = 'auto',
            num_results = 15,
            category,
            includeDomains,
            excludeDomains,
            maxAgeHours,
            contents,
            browse = true,
            browseTopK = 3,
            browseIndices,
            saveNotes = true,
        } = parsed.data;

        const includeDomainFilters = normalizeDomainFilters(includeDomains);
        const excludeDomainFilters = normalizeDomainFilters(excludeDomains);
        const sourcePolicy = sourcePolicyFromConstraintConfig(context.constraints?.sourcePolicy);

        const queryList = (queries && queries.length > 0 ? queries : query ? [query] : [])
            .map(q => q.trim())
            .filter(Boolean);
        if (queryList.length === 0) {
            return { ok: false, error: { message: 'Provide at least one non-empty query.', name: 'ValidationError' } };
        }
        const globalIntent = detectDiscoveryIntent(queryList);

        const runSingleSearch = async (searchQuery: string) => {
            const queryIntent = (() => {
                const localIntent = detectDiscoveryIntent(searchQuery);
                if (localIntent !== 'general') return localIntent;
                return globalIntent;
            })();
            const policyApplies = queryIntent !== 'general' && sourcePolicy.strictness !== 'off';
            const hasManualDomainFilters = Boolean(includeDomainFilters || excludeDomainFilters);
            const tierOrder: SourceTier[] = policyApplies && (sourcePolicy.strictness === 'strict' || !hasManualDomainFilters)
                ? getTierOrder(sourcePolicy)
                : ['tier3'];

            let normalized: NormalizedResult[] = [];
            let selectedTier: SourceTier = 'tier3';
            const searchAttempts: Array<{
                tier: SourceTier;
                includeDomains: string[] | null;
                excludeDomains: string[] | null;
                numResults: number;
            }> = [];

            for (const tier of tierOrder) {
                let tierIncludeDomains = includeDomainFilters;
                let tierExcludeDomains = excludeDomainFilters;

                if (policyApplies && (sourcePolicy.strictness === 'strict' || !hasManualDomainFilters)) {
                    if (tier === 'tier3') {
                        tierIncludeDomains = undefined;
                        tierExcludeDomains = undefined;
                    } else {
                        const domains = getTierDomains(queryIntent, tier, sourcePolicy);
                        tierIncludeDomains = domains.length > 0 ? domains : undefined;
                        tierExcludeDomains = undefined;
                    }
                }

                const body: Record<string, unknown> = {
                    query: searchQuery,
                    type,
                    num_results,
                    contents:
                        contents ??
                        ({
                            highlights: { num_sentences: 6, highlights_per_url: 6 },
                        } as const),
                };

                if (category !== undefined) body.category = category;
                if (tierIncludeDomains) body.includeDomains = tierIncludeDomains;
                if (tierExcludeDomains) body.excludeDomains = tierExcludeDomains;
                if (maxAgeHours !== undefined) body.maxAgeHours = maxAgeHours;

                const resp = await fetch('https://api.exa.ai/search', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                    },
                    body: JSON.stringify(body),
                });

                const rawText = await resp.text();
                let data: unknown = null;
                try {
                    data = rawText ? JSON.parse(rawText) : null;
                } catch {
                    data = { raw: rawText };
                }

                if (!resp.ok) {
                    const message = (() => {
                        if (isRecord(data)) {
                            const err = data.error;
                            if (isRecord(err) && typeof err.message === 'string') return err.message;
                            if (typeof data.message === 'string') return data.message;
                        }
                        return `Exa API error: ${resp.status} ${resp.statusText}`.trim();
                    })();
                    return { ok: false, error: { message, name: 'ExaError' }, data };
                }

                const candidateResults = normalizeResults(data);
                searchAttempts.push({
                    tier,
                    includeDomains: tierIncludeDomains ?? null,
                    excludeDomains: tierExcludeDomains ?? null,
                    numResults: candidateResults.length,
                });

                normalized = candidateResults;
                selectedTier = tier;
                if (!policyApplies) break;
                if (hasManualDomainFilters && sourcePolicy.strictness !== 'strict') break;
                if (tier === 'tier3') break;
                if (!shouldEscalateTier(candidateResults.length, sourcePolicy)) break;
            }

            const performedAt = new Date().toISOString();

            let fetchedPages: WebFetchedPage[] = [];
            let notesRelPath: string | null = null;
            let notesSaved = false;

            if (browse && normalized.length > 0) {
                const pickedUrls = (() => {
                    if (Array.isArray(browseIndices) && browseIndices.length > 0) {
                        const valid = browseIndices
                            .map(i => normalized[i - 1])
                            .filter(Boolean)
                            .map(r => r.url);
                        return Array.from(new Set(valid));
                    }
                    return Array.from(new Set(normalized.map(r => r.url))).slice(0, Math.min(browseTopK, normalized.length));
                })();
                try {
                    if (pickedUrls.length > 0) {
                        const contentsResp = await fetchExaContents({
                            urls: pickedUrls,
                            apiKey,
                            query: searchQuery,
                            timeoutMs: 12_000,
                            includeText: false,
                            includeHighlights: true,
                            includeSummary: true,
                            maxAgeHours,
                            livecrawl: 'fallback',
                        });
                        fetchedPages = contentsResp.pages;
                    }
                } catch {
                    // Non-fatal: search results are still useful even if content fetch fails.
                    fetchedPages = [];
                }
            }

            if (saveNotes && typeof context.projectId === 'string' && context.projectId.trim()) {
                try {
                    const safeProjectId = safePathSegment(context.projectId);
                    const rel = path.posix.join('agent_notes', safeProjectId, 'research.md');
                    const abs = process.env.VERCEL
                        ? path.join('/tmp', 'tuna', rel)
                        : path.resolve(process.cwd(), rel);

                    await fs.mkdir(path.dirname(abs), { recursive: true });

                    const noteMd = formatResearchNotesMd({
                        performedAt,
                        query: searchQuery,
                        searchResults: normalized,
                        fetchedPages,
                    });

                    await fs.appendFile(abs, noteMd, 'utf-8');

                    // Mirror notes into runtime outputs so they appear in Files/Runtime folders.
                    const chatId = String(context.projectId || '').trim();
                    if (canUseStoragePathSegment(chatId) && canUseStoragePathSegment(rel)) {
                        try {
                            const notesContent = await fs.readFile(abs);
                            const storagePath = `runner-outputs/${chatId}/runtime/${rel}`;
                            await uploadStorageObject('artifacts', storagePath, notesContent, {
                                contentType: 'text/markdown; charset=utf-8',
                            });
                        } catch {
                            // Keep local notes behavior intact even if storage mirroring fails.
                        }
                    }

                    // Only return a repo-relative path when the file is in the project tree.
                    notesRelPath = process.env.VERCEL ? null : rel;
                    notesSaved = true;
                } catch {
                    notesSaved = false;
                }
            }

            return {
                ok: true,
                query: searchQuery,
                performedAt,
                normalized,
                fetchedPages,
                notesSaved,
                notesRelPath,
                policy: {
                    intent: queryIntent,
                    strictness: sourcePolicy.strictness,
                    applied: policyApplies,
                    tierUsed: selectedTier,
                    attempts: searchAttempts,
                },
            };
        };

        const runs = await Promise.all(queryList.map(runSingleSearch));
        const firstError = runs.find(r => !r.ok);
        if (firstError && !firstError.ok) {
            return firstError;
        }

        const successfulRuns = runs.filter(
            (r): r is {
                ok: true;
                query: string;
                performedAt: string;
                normalized: NormalizedResult[];
                fetchedPages: WebFetchedPage[];
                notesSaved: boolean;
                notesRelPath: string | null;
                policy: {
                    intent: SourceDiscoveryIntent;
                    strictness: SourcePolicyStrictness;
                    applied: boolean;
                    tierUsed: SourceTier;
                    attempts: Array<{
                        tier: SourceTier;
                        includeDomains: string[] | null;
                        excludeDomains: string[] | null;
                        numResults: number;
                    }>;
                };
            } => r.ok
        );

        const primaryRun = successfulRuns[0];
        if (!primaryRun) {
            return { ok: false, error: { message: 'No successful search runs were produced.', name: 'ExaError' } };
        }

        const batches = successfulRuns.map(r => ({
            query: r.query,
            performedAt: r.performedAt,
            numResults: r.normalized.length,
            results: r.normalized,
            openedSources: {
                enabled: browse,
                topK: Math.min(browseTopK, r.normalized.length),
                pages: r.fetchedPages,
            },
            notes: {
                saved: r.notesSaved,
                path: r.notesRelPath,
            },
            policy: r.policy,
        }));

        const combinedResults = successfulRuns.flatMap(r => r.normalized);
        const performedAt = successfulRuns.length === 1 ? primaryRun.performedAt : new Date().toISOString();
        const primaryBatch = batches[0];

        const artifactContent =
            successfulRuns.length === 1
                ? {
                    kind: 'exa_web_research_v2',
                    provider: 'exa',
                    query: primaryRun.query,
                    performedAt,
                    type,
                    category: category ?? null,
                    numResults: combinedResults.length,
                    results: combinedResults,
                    openedSources: primaryBatch?.openedSources ?? { enabled: browse, topK: 0, pages: [] },
                    notes: primaryBatch?.notes ?? { saved: false, path: null },
                    policy: primaryBatch?.policy ?? {
                        intent: globalIntent,
                        strictness: sourcePolicy.strictness,
                        applied: false,
                        tierUsed: 'tier3' as SourceTier,
                        attempts: [],
                    },
                }
                : {
                    kind: 'exa_web_research_v2',
                    provider: 'exa',
                    queries: queryList,
                    performedAt,
                    type,
                    category: category ?? null,
                    numResults: combinedResults.length,
                    results: combinedResults,
                    batches,
                    policy: {
                        strictness: sourcePolicy.strictness,
                        applied: batches.some(b => Boolean(b.policy?.applied)),
                    },
                };

        const artifactId = `research-${randomUUID()}`;
        return {
            ok: true,
            data: artifactContent,
            evidence: {
                sources: combinedResults.map((r, i) => ({
                    index: i + 1,
                    title: r.title,
                    url: r.url,
                    domain: r.domain,
                })),
            },
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: artifactId,
                        type: 'markdown',
                        title: 'Web Search',
                        content: artifactContent,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: artifactId } },
            ],
        };
    },
};

