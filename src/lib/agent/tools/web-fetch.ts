import 'server-only';

import { z } from 'zod';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import {
    classifyDomainTier,
    detectDiscoveryIntent,
    sourcePolicyFromConstraintConfig,
} from '../source-policy';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function safeDomain(url: string): string | undefined {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return undefined;
    }
}

function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max).trim()}…`;
}

export type WebFetchedPage = {
    url: string;
    title?: string;
    domain?: string;
    publishedDate?: string;
    author?: string;
    summary?: string;
    highlights?: string[];
    textSnippet?: string;
    status?: 'success' | 'error';
    error?: { tag?: string; httpStatusCode?: number };
};

type ExaContentsResponse = {
    requestId?: string;
    results?: unknown[];
    statuses?: unknown[];
};

type ExaStatus = {
    id: string;
    status: 'success' | 'error';
    error?: { tag?: string; httpStatusCode?: number };
};

function normalizeStatuses(raw: unknown): Map<string, ExaStatus> {
    const map = new Map<string, ExaStatus>();
    if (!Array.isArray(raw)) return map;
    for (const item of raw) {
        const s = isRecord(item) ? item : {};
        const id = typeof s.id === 'string' ? s.id : '';
        const status = s.status === 'success' || s.status === 'error' ? s.status : undefined;
        const err = isRecord(s.error) ? s.error : undefined;
        if (!id || !status) continue;
        map.set(id, {
            id,
            status,
            error: err
                ? {
                    tag: typeof err.tag === 'string' ? err.tag : undefined,
                    httpStatusCode: typeof err.httpStatusCode === 'number' ? err.httpStatusCode : undefined,
                }
                : undefined,
        });
    }
    return map;
}

function normalizeContentsResults(raw: unknown, statusById: Map<string, ExaStatus>, opts: { maxTextChars: number; maxSummaryChars: number }): WebFetchedPage[] {
    if (!Array.isArray(raw)) return [];
    const out: WebFetchedPage[] = [];

    for (const item of raw) {
        const r = isRecord(item) ? item : {};
        const url =
            typeof r.url === "string"
                ? r.url
                : typeof r.id === "string"
                    ? r.id
                    : '';
        if (!url) continue;

        const title = typeof r.title === 'string' ? r.title : undefined;
        const publishedDate = typeof r.publishedDate === 'string' ? r.publishedDate : undefined;
        const author = typeof r.author === 'string' ? r.author : undefined;
        const summary = typeof r.summary === 'string' ? clip(r.summary.trim(), opts.maxSummaryChars) : undefined;
        const highlights =
            Array.isArray(r.highlights)
                ? r.highlights.filter((h: unknown) => typeof h === 'string' && h.trim()).slice(0, 8).map(h => clip(h.trim(), 500))
                : undefined;
        const textSnippet =
            typeof r.text === 'string' && r.text.trim()
                ? clip(r.text.trim(), opts.maxTextChars)
                : undefined;

        const domain = safeDomain(url);
        const st = statusById.get(url);

        out.push({
            url,
            title,
            domain,
            publishedDate,
            author,
            summary,
            highlights,
            textSnippet,
            status: st?.status,
            error: st?.error,
        });
    }

    return out;
}

export async function fetchExaContents(params: {
    urls: string[];
    apiKey: string;
    query?: string;
    timeoutMs?: number;
    includeText?: boolean;
    includeHighlights?: boolean;
    includeSummary?: boolean;
    maxAgeHours?: number;
    livecrawl?: 'never' | 'fallback' | 'preferred' | 'always';
}): Promise<{ requestId?: string; pages: WebFetchedPage[]; raw: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, params.timeoutMs ?? 12_000));

    try {
        const body: Record<string, unknown> = {
            urls: params.urls,
        };

        if (params.livecrawl) {
            body.livecrawl = params.livecrawl;
        } else if (params.maxAgeHours !== undefined) {
            body.maxAgeHours = params.maxAgeHours;
        }

        if (params.includeText) body.text = true;

        if (params.includeHighlights) {
            // Exa expects an object for `highlights` (not a boolean).
            body.highlights = params.query
                ? { query: params.query, numSentences: 3, highlightsPerUrl: 5 }
                : { numSentences: 3, highlightsPerUrl: 5 };
        }

        if (params.includeSummary && params.query) {
            body.summary = { query: params.query };
        }

        const resp = await fetch('https://api.exa.ai/contents', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': params.apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
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
            const bodySnippet = (() => {
                try {
                    return clip(JSON.stringify(data), 4000);
                } catch {
                    return clip(String(data), 4000);
                }
            })();
            throw new Error(`${message} | body=${bodySnippet}`);
        }

        const parsed = (isRecord(data) ? data : {}) as ExaContentsResponse;
        const statusById = normalizeStatuses(parsed.statuses);
        const pages = normalizeContentsResults(parsed.results, statusById, { maxTextChars: 3500, maxSummaryChars: 1400 });

        return { requestId: parsed.requestId, pages, raw: data };
    } finally {
        clearTimeout(timeout);
    }
}

// ============= Schemas =============

const webFetchArgsSchema = z
    .object({
        urls: z.array(z.string().url()).min(1).max(10),
        query: z.string().min(1).max(5000).optional(),
        includeText: z.boolean().optional(),
        includeHighlights: z.boolean().optional(),
        includeSummary: z.boolean().optional(),
        maxAgeHours: z.number().int().optional(),
        livecrawl: z.enum(['never', 'fallback', 'preferred', 'always']).optional(),
        timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
    })
    .strict();

// ============= Tool =============

export const webFetchTool: Tool = {
    category: 'data',
    definition: {
        name: 'web_fetch',
        description:
            'Fetch page contents for specific URLs using Exa Contents. Returns summaries/highlights/text snippets. Server-side only.',
        parameters: {
            type: 'object',
            properties: {
                urls: { type: 'array', items: { type: 'string' }, description: 'List of URLs (1-10)' },
                query: { type: 'string', description: 'Optional query used to tailor highlights/summary' },
                includeText: { type: 'boolean', description: 'Include extracted page text (may be large)' },
                includeHighlights: { type: 'boolean', description: 'Include key excerpts (recommended)' },
                includeSummary: { type: 'boolean', description: 'Include a concise summary tailored to query (requires query)' },
                maxAgeHours: {
                    type: 'number',
                    description: 'Cache freshness threshold in hours (0=always livecrawl, -1=cache only). Do not combine with livecrawl.',
                },
                livecrawl: {
                    type: 'string',
                    enum: ['never', 'fallback', 'preferred', 'always'],
                    description: 'Livecrawl mode (mutually exclusive with maxAgeHours).',
                },
                timeoutMs: { type: 'number', description: 'Network timeout in milliseconds (1000-30000)' },
            },
            required: ['urls'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = webFetchArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }

        if (context.constraints?.allowWebSearch === false) {
            return { ok: false, error: { message: 'Web access is disabled for this request.', name: 'PolicyError' } };
        }

        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
            return { ok: false, error: { message: 'EXA_API_KEY is not configured on the server.', name: 'ConfigurationError' } };
        }

        const {
            urls,
            query,
            includeText = false,
            includeHighlights = true,
            includeSummary = true,
            maxAgeHours,
            livecrawl,
            timeoutMs,
        } = parsed.data;

        const sourcePolicy = sourcePolicyFromConstraintConfig(context.constraints?.sourcePolicy);
        const intent = detectDiscoveryIntent(`${query ?? ''} ${urls.join(' ')}`);
        let effectiveUrls = urls;
        let droppedUrls: Array<{ url: string; reason: string }> = [];
        if (intent !== 'general' && sourcePolicy.strictness !== 'off') {
            const classified = urls.map((url) => ({
                url,
                tier: classifyDomainTier(url, intent, sourcePolicy),
            }));
            const blocked = classified.filter((item) => item.tier === 'out_of_policy');
            if (blocked.length > 0 && sourcePolicy.strictness === 'strict') {
                return {
                    ok: false,
                    error: {
                        name: 'PolicyError',
                        message: `Source policy blocked ${blocked.length} URL(s) for ${intent} fetch in strict mode.`,
                    },
                    data: {
                        blockedUrls: blocked.map((item) => item.url),
                        strictness: sourcePolicy.strictness,
                        intent,
                    },
                };
            }

            if (blocked.length > 0) {
                const blockedSet = new Set(blocked.map((item) => item.url));
                effectiveUrls = urls.filter((url) => !blockedSet.has(url));
                droppedUrls = blocked.map((item) => ({ url: item.url, reason: 'out_of_policy' }));
            }

            if (effectiveUrls.length === 0) {
                return {
                    ok: false,
                    error: {
                        name: 'PolicyError',
                        message: `All requested URLs were excluded by source policy for ${intent} fetch.`,
                    },
                    data: {
                        droppedUrls,
                        strictness: sourcePolicy.strictness,
                        intent,
                    },
                };
            }
        }

        if (includeSummary && !query) {
            return { ok: false, error: { message: 'includeSummary=true requires a non-empty query.', name: 'ValidationError' } };
        }

        try {
            const { requestId, pages } = await fetchExaContents({
                urls: effectiveUrls,
                apiKey,
                query,
                timeoutMs,
                includeText,
                includeHighlights,
                includeSummary,
                maxAgeHours,
                livecrawl,
            });

            return {
                ok: true,
                data: {
                    kind: 'exa_web_fetch_v1',
                    provider: 'exa',
                    requestId,
                    performedAt: new Date().toISOString(),
                    query: query ?? null,
                    urls: effectiveUrls,
                    pages,
                    policy: {
                        intent,
                        strictness: sourcePolicy.strictness,
                        droppedUrls,
                    },
                },
                evidence: {
                    sources: pages.map((p, i) => ({
                        index: i + 1,
                        title: p.title ?? p.url,
                        url: p.url,
                        domain: p.domain,
                    })),
                },
            };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: { message, name: 'ExaError' } };
        }
    },
};

