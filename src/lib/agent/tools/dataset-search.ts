import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import {
    buildParallelSearchStrategy,
    buildTierAttemptTelemetry,
    buildSourceFallbackChain,
    datasetCandidateScore,
    evaluateDesktopEscalationGuard,
    getTierDomains,
    sourcePolicyFromConstraintConfig,
    type SourceTier,
    type SourceTierAttemptTelemetry,
} from '../source-policy';

type SearchRow = {
    title: string;
    url: string;
    domain?: string;
    score?: number;
    publishedDate?: string;
    highlights?: string[];
    textSnippet?: string;
};

type TierSearchResult = {
    tier: SourceTier | 'hf_direct';
    rows: SearchRow[];
    error?: string;
};

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

function normalizeUrlKey(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.search = '';
        parsed.hash = '';
        return parsed.href.replace(/\/+$/, '');
    } catch {
        return url;
    }
}

function pickResultsArray(data: unknown): unknown[] {
    if (!isRecord(data)) return [];
    const direct = data.results;
    if (Array.isArray(direct)) return direct;
    if (isRecord(direct) && Array.isArray(direct.results)) return direct.results;
    return [];
}

function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeRows(data: unknown, maxResults: number): SearchRow[] {
    return pickResultsArray(data)
        .slice(0, Math.max(1, maxResults))
        .map((item): SearchRow | null => {
            const row = isRecord(item) ? item : {};
            const url = typeof row.url === 'string' ? row.url : (typeof row.link === 'string' ? row.link : '');
            if (!url) return null;
            const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : url;
            const score = typeof row.score === 'number' ? row.score : undefined;
            const publishedDate = typeof row.publishedDate === 'string'
                ? row.publishedDate
                : (typeof row.published_date === 'string' ? row.published_date : undefined);
            const highlights = toStringArray(row.highlights);
            const text = typeof row.text === 'string' && row.text.trim() ? row.text.trim().slice(0, 1200) : undefined;
            const out: SearchRow = { title, url, score, publishedDate, highlights, textSnippet: text };
            const domain = safeDomain(url);
            if (domain) out.domain = domain;
            return out;
        })
        .filter((row): row is SearchRow => Boolean(row));
}

function parseHfDatasetRepoFromUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        if (!host.endsWith('huggingface.co')) return undefined;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return undefined;
        if (parts[0] === 'datasets' && parts.length >= 3) return `${parts[1]}/${parts[2]}`;
        if (parts[0] === 'datasets') return undefined;
        return `${parts[0]}/${parts[1]}`;
    } catch {
        return undefined;
    }
}

function parseGithubRepoFromUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        if (!host.endsWith('github.com')) return undefined;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return undefined;
        return `${parts[0]}/${parts[1]}`;
    } catch {
        return undefined;
    }
}

function parseKaggleDatasetSlugFromUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '');
        if (!host.endsWith('kaggle.com')) return undefined;
        const parts = parsed.pathname.split('/').filter(Boolean);
        const datasetsIdx = parts.findIndex((segment) => segment === 'datasets');
        if (datasetsIdx < 0 || parts.length <= datasetsIdx + 2) return undefined;
        const owner = parts[datasetsIdx + 1];
        const dataset = parts[datasetsIdx + 2];
        if (!owner || !dataset) return undefined;
        return `${owner}/${dataset}`;
    } catch {
        return undefined;
    }
}

function buildDatasetUsageHints(url: string): Array<Record<string, unknown>> {
    const hints: Array<Record<string, unknown>> = [];
    const hfRepo = parseHfDatasetRepoFromUrl(url);
    if (hfRepo) {
        hints.push({
            tool: 'training_submit',
            field: 'hfDatasets',
            value: { repo: hfRepo },
            note: 'Use this dataset via Hugging Face prefetch in training_submit.',
        });
    }
    const githubRepo = parseGithubRepoFromUrl(url);
    if (githubRepo) {
        hints.push({
            tool: 'training_submit',
            field: 'github',
            value: { repo: githubRepo },
            note: 'Use repository data/code via GitHub prefetch in training_submit.',
        });
    }
    const kaggleDataset = parseKaggleDatasetSlugFromUrl(url);
    if (kaggleDataset) {
        hints.push({
            tool: 'training_submit',
            field: 'kaggleDatasets',
            value: { dataset: kaggleDataset },
            note: 'Directly prefetch this Kaggle dataset in training_submit.',
        });
        hints.push({
            tool: 'kaggle_dataset_download',
            value: { dataset: kaggleDataset },
            note: 'Download into a sandbox session for interactive exploration first.',
        });
    }
    return hints;
}

async function exaSearch(params: {
    apiKey: string;
    query: string;
    maxResults: number;
    includeDomains?: string[];
}): Promise<{ ok: true; rows: SearchRow[] } | { ok: false; message: string }> {
    const body: Record<string, unknown> = {
        query: params.query,
        type: 'auto',
        num_results: Math.max(1, Math.min(15, params.maxResults)),
        contents: {
            highlights: { num_sentences: 6, highlights_per_url: 6 },
        },
    };
    if (params.includeDomains && params.includeDomains.length > 0) {
        body.includeDomains = params.includeDomains;
    }

    const resp = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': params.apiKey,
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
        return { ok: false, message };
    }

    return { ok: true, rows: normalizeRows(data, params.maxResults) };
}

async function searchHfDatasetsDirectly(
    query: string,
    maxResults: number,
): Promise<TierSearchResult> {
    const limit = Math.max(1, Math.min(15, maxResults));
    const params = new URLSearchParams({ search: query, limit: String(limit), sort: 'downloads', direction: '-1' });
    const url = `https://huggingface.co/api/datasets?${params}`;
    const hfToken = (process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || '').trim();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hfToken) headers.Authorization = `Bearer ${hfToken}`;

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) {
        return { tier: 'hf_direct', rows: [], error: `HF Hub API ${resp.status}` };
    }
    const data: unknown = await resp.json();
    if (!Array.isArray(data)) return { tier: 'hf_direct', rows: [] };

    const rows: SearchRow[] = data.slice(0, limit).map((item: unknown): SearchRow | null => {
        if (!isRecord(item)) return null;
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id) return null;
        const repoUrl = `https://huggingface.co/datasets/${id}`;
        const title = id;
        const publishedDate = typeof item.lastModified === 'string' ? item.lastModified : undefined;
        const description = typeof item.description === 'string' ? item.description.slice(0, 800) : undefined;
        return {
            title,
            url: repoUrl,
            domain: 'huggingface.co',
            publishedDate,
            textSnippet: description,
            score: 0.75,
        };
    }).filter((row): row is SearchRow => Boolean(row));

    return { tier: 'hf_direct', rows };
}

async function exaSearchForTier(params: {
    tier: SourceTier;
    apiKey: string;
    query: string;
    maxResults: number;
    includeDomains: string[] | undefined;
}): Promise<TierSearchResult> {
    const result = await exaSearch({
        apiKey: params.apiKey,
        query: params.query,
        maxResults: params.maxResults,
        includeDomains: params.includeDomains,
    });
    if (!result.ok) {
        return { tier: params.tier, rows: [], error: result.message };
    }
    return { tier: params.tier, rows: result.rows };
}

const datasetSearchArgsSchema = z.object({
    query: z.string().min(1).max(5000),
    maxResults: z.number().int().min(1).max(15).optional(),
    includeTier3: z.boolean().optional(),
}).strict();

export const datasetSearchTool: Tool = {
    category: 'data',
    definition: {
        name: 'dataset_search',
        description:
            'Discover datasets using parallel multi-tier search: Hugging Face Hub API + Exa tier1 (HF) + Exa tier2 (GitHub/Kaggle) fire concurrently, with conditional open-web fallback. Returns per-tier fallback reasons and desktop-escalation eligibility telemetry.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Dataset search query (domain, schema, geography, timeframe, constraints).' },
                maxResults: { type: 'number', description: 'Maximum search results per tier (1-15, default 10).' },
                includeTier3: { type: 'boolean', description: 'Force open-web fallback tier even when policy would normally stop at tier2.' },
            },
            required: ['query'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = datasetSearchArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }

        if (context.constraints?.allowWebSearch === false) {
            return { ok: false, error: { name: 'PolicyError', message: 'Web search is disabled for this request.' } };
        }

        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
            return { ok: false, error: { name: 'ConfigurationError', message: 'EXA_API_KEY is not configured on the server.' } };
        }

        const maxResults = parsed.data.maxResults ?? 10;
        const policy = sourcePolicyFromConstraintConfig(context.constraints?.sourcePolicy);
        const MIN_ACCEPTABLE_SCORE = 0.55;
        const strategy = buildParallelSearchStrategy(parsed.data.query, 'dataset', policy);

        if (parsed.data.includeTier3 && strategy.conditionalTier !== 'tier3' && !strategy.parallelTiers.includes('tier3')) {
            strategy.parallelTiers.push('tier3');
            strategy.conditionalTier = null;
        }

        type ScoredCandidate = {
            title: string;
            url: string;
            domain?: string;
            publishedDate?: string;
            score?: number;
            tier: SourceTier;
            totalScore: number;
            scoreBreakdown: ReturnType<typeof datasetCandidateScore>['breakdown'];
            notes: string;
        };

        const candidateByUrl = new Map<string, ScoredCandidate>();
        const attempts: SourceTierAttemptTelemetry[] = [];

        function ingestRows(rows: SearchRow[], tier: SourceTier): { bestScore: number | null; viableCount: number } {
            let bestScore: number | null = null;
            let viableCount = 0;
            for (const row of rows) {
                const descriptiveText = `${row.highlights?.join('\n') ?? ''}\n${row.textSnippet ?? ''}`;
                const scored = datasetCandidateScore({
                    title: row.title,
                    url: row.url,
                    text: descriptiveText,
                    score: row.score,
                    publishedDate: row.publishedDate,
                    policy,
                });
                if (bestScore === null || scored.total > bestScore) {
                    bestScore = scored.total;
                }
                if (scored.total >= MIN_ACCEPTABLE_SCORE) {
                    viableCount += 1;
                }
                const urlKey = normalizeUrlKey(row.url);
                const existing = candidateByUrl.get(urlKey);
                if (existing && existing.totalScore >= scored.total) continue;
                candidateByUrl.set(urlKey, {
                    title: row.title,
                    url: row.url,
                    domain: row.domain,
                    publishedDate: row.publishedDate,
                    score: row.score,
                    tier,
                    totalScore: scored.total,
                    scoreBreakdown: scored.breakdown,
                    notes: descriptiveText.slice(0, 1000),
                });
            }
            return { bestScore, viableCount };
        }

        // Phase 1: fire parallel searches
        const parallelPromises: Promise<TierSearchResult>[] = [];

        if (strategy.hfDirectSearch) {
            parallelPromises.push(
                searchHfDatasetsDirectly(parsed.data.query, maxResults)
                    .catch((err): TierSearchResult => ({ tier: 'hf_direct', rows: [], error: String(err) })),
            );
        }

        for (const tier of strategy.parallelTiers) {
            const includeDomains = tier === 'tier3' ? undefined : getTierDomains('dataset', tier, policy);
            parallelPromises.push(
                exaSearchForTier({
                    tier,
                    apiKey,
                    query: parsed.data.query,
                    maxResults,
                    includeDomains: includeDomains && includeDomains.length > 0 ? includeDomains : undefined,
                }).catch((err): TierSearchResult => ({ tier, rows: [], error: String(err) })),
            );
        }

        const settled = await Promise.allSettled(parallelPromises);
        const tierResults: TierSearchResult[] = settled.map(s =>
            s.status === 'fulfilled' ? s.value : { tier: 'tier1' as SourceTier, rows: [], error: String(s.reason) },
        );

        // Ingest HF-direct results into tier1 bucket
        for (const result of tierResults) {
            if (result.tier === 'hf_direct') {
                ingestRows(result.rows, 'tier1');
            }
        }

        // Ingest Exa tier results and build telemetry
        for (const tier of strategy.parallelTiers) {
            const result = tierResults.find(r => r.tier === tier);
            if (!result || result.error) {
                attempts.push(buildTierAttemptTelemetry({
                    tier,
                    includeDomains: null,
                    numResults: 0,
                    minResultsRequired: Math.max(1, policy.minResultsPerTier),
                    viableCandidates: 0,
                    bestScore: null,
                    minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                    canEscalate: tier !== 'tier3',
                }));
                continue;
            }
            const { bestScore, viableCount } = ingestRows(result.rows, tier);
            const includeDomains = tier === 'tier3' ? undefined : getTierDomains('dataset', tier, policy);
            attempts.push(buildTierAttemptTelemetry({
                tier,
                includeDomains: includeDomains && includeDomains.length > 0 ? includeDomains : null,
                numResults: result.rows.length,
                minResultsRequired: Math.max(1, policy.minResultsPerTier),
                viableCandidates: viableCount,
                bestScore,
                minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                canEscalate: tier !== 'tier3',
            }));
        }

        // Phase 2: conditional tier3 if parallel phase was insufficient
        const totalViable = Array.from(candidateByUrl.values()).filter(c => c.totalScore >= MIN_ACCEPTABLE_SCORE).length;
        if (strategy.conditionalTier && totalViable < Math.max(1, policy.minResultsPerTier)) {
            const tier3Search = await exaSearchForTier({
                tier: strategy.conditionalTier,
                apiKey,
                query: parsed.data.query,
                maxResults,
                includeDomains: undefined,
            }).catch((err): TierSearchResult => ({ tier: strategy.conditionalTier!, rows: [], error: String(err) }));

            if (tier3Search.error) {
                attempts.push(buildTierAttemptTelemetry({
                    tier: strategy.conditionalTier,
                    includeDomains: null,
                    numResults: 0,
                    minResultsRequired: Math.max(1, policy.minResultsPerTier),
                    viableCandidates: 0,
                    bestScore: null,
                    minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                    canEscalate: false,
                }));
            } else {
                const { bestScore, viableCount } = ingestRows(tier3Search.rows, strategy.conditionalTier);
                attempts.push(buildTierAttemptTelemetry({
                    tier: strategy.conditionalTier,
                    includeDomains: null,
                    numResults: tier3Search.rows.length,
                    minResultsRequired: Math.max(1, policy.minResultsPerTier),
                    viableCandidates: viableCount,
                    bestScore,
                    minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                    canEscalate: false,
                }));
            }
        }

        if (candidateByUrl.size === 0 && tierResults.every(r => !!r.error)) {
            const messages = tierResults.map(r => r.error).filter(Boolean);
            return { ok: false, error: { name: 'SearchError', message: `All search tiers failed: ${messages.join('; ')}` } };
        }

        const ranked = Array.from(candidateByUrl.values())
            .sort((a, b) => b.totalScore - a.totalScore)
            .slice(0, maxResults)
            .map((candidate, idx) => ({
                rank: idx + 1,
                title: candidate.title,
                url: candidate.url,
                domain: candidate.domain,
                tier: candidate.tier,
                totalScore: candidate.totalScore,
                scoreBreakdown: candidate.scoreBreakdown,
                publishedDate: candidate.publishedDate ?? null,
                sourceRelevance: candidate.score ?? null,
                usageHints: buildDatasetUsageHints(candidate.url),
            }));

        const recommended = ranked[0] ?? null;
        const tierUsed = attempts[attempts.length - 1]?.tier ?? 'tier1';
        const desktopEscalation = evaluateDesktopEscalationGuard({
            strictness: policy.strictness,
            intent: 'dataset',
            attempts,
            requireOpenWebTier: policy.fallbackToOpenWeb,
        });
        const artifactContent = {
            kind: 'dataset_candidates_v2',
            performedAt: new Date().toISOString(),
            query: parsed.data.query,
            tierUsed,
            searchStrategy: {
                parallelTiers: strategy.parallelTiers,
                conditionalTier: strategy.conditionalTier,
                hfDirectSearch: strategy.hfDirectSearch,
            },
            policy: {
                strictness: policy.strictness,
                fallbackToGovSources: policy.fallbackToGovSources,
                fallbackToOpenWeb: policy.fallbackToOpenWeb,
                minResultsPerTier: policy.minResultsPerTier,
            },
            fallbackChain: buildSourceFallbackChain('dataset', policy),
            attempts,
            fallbackTelemetry: {
                minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                desktopEscalation,
            },
            candidates: ranked,
            recommended,
        };
        const artifactId = `dataset-search-${randomUUID()}`;

        return {
            ok: true,
            data: artifactContent,
            evidence: {
                sources: ranked.map((item) => ({
                    rank: item.rank,
                    title: item.title,
                    url: item.url,
                    score: item.totalScore,
                    tier: item.tier,
                })),
            },
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: artifactId,
                        type: 'dataset',
                        title: 'Dataset Candidates',
                        content: artifactContent,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: artifactId, type: 'dataset' } },
            ],
        };
    },
};
