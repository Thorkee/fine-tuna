import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import {
    benchmarkSignalCount,
    buildTierAttemptTelemetry,
    buildSourceFallbackChain,
    evaluateDesktopEscalationGuard,
    extractLikelyModelId,
    getTierDomains,
    getTierOrder,
    isBenchmarkDomain,
    modelCandidateScore,
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

type Candidate = {
    modelId: string;
    title: string;
    url: string;
    domain?: string;
    tier: SourceTier;
    score?: number;
    publishedDate?: string;
    notes: string;
    benchmarkSignalCount: number;
    benchmarkDomainHits: number;
    freshestBenchmarkDate?: string;
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

function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
}

function pickResultsArray(data: unknown): unknown[] {
    if (!isRecord(data)) return [];
    const direct = data.results;
    if (Array.isArray(direct)) return direct;
    if (isRecord(direct) && Array.isArray(direct.results)) return direct.results;
    return [];
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
            const textSnippet = typeof row.text === 'string' && row.text.trim()
                ? row.text.trim().slice(0, 1500)
                : undefined;
            const out: SearchRow = { title, url, score, publishedDate, highlights, textSnippet };
            const domain = safeDomain(url);
            if (domain) out.domain = domain;
            return out;
        })
        .filter((row): row is SearchRow => Boolean(row));
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

function looksLikeRepoId(value: string): boolean {
    return /^[^/\s]+\/[^/\s]+$/.test(value.trim());
}

function buildModelUsageHints(modelId: string, url: string): Array<Record<string, unknown>> {
    const hints: Array<Record<string, unknown>> = [];
    const safeModelId = modelId.trim();
    const host = safeDomain(url) ?? '';
    if (looksLikeRepoId(safeModelId) && host.endsWith('huggingface.co')) {
        hints.push({
            tool: 'training_submit',
            field: 'hfModels',
            value: { repo: safeModelId },
            note: 'Use this model via Hugging Face prefetch in training_submit.',
        });
    }
    const githubRepo = parseGithubRepoFromUrl(url);
    if (githubRepo) {
        hints.push({
            tool: 'training_submit',
            field: 'github',
            value: { repo: githubRepo },
            note: 'Prefetch this GitHub repo for custom model code/assets in training_submit.',
        });
    }
    return hints;
}

async function exaSearch(params: {
    apiKey: string;
    query: string;
    includeDomains?: string[];
    maxResults: number;
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

function updateFreshestDate(existing: string | undefined, candidate: string | undefined): string | undefined {
    if (!candidate) return existing;
    if (!existing) return candidate;
    const existingTs = Date.parse(existing);
    const candidateTs = Date.parse(candidate);
    if (!Number.isFinite(existingTs)) return candidate;
    if (!Number.isFinite(candidateTs)) return existing;
    return candidateTs > existingTs ? candidate : existing;
}

function modelKey(row: SearchRow): string {
    const id = extractLikelyModelId(row.url);
    if (id) return id.toLowerCase();
    return row.title.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

const modelSearchArgsSchema = z.object({
    query: z.string().min(1).max(5000),
    maxResults: z.number().int().min(1).max(15).optional(),
    benchmarkTopN: z.number().int().min(1).max(8).optional(),
    includeTier3: z.boolean().optional(),
}).strict();

export const modelSearchTool: Tool = {
    category: 'ml',
    definition: {
        name: 'model_search',
        description:
            'Find and rank open-source models with explicit fallback order: Hugging Face first, then GitHub/Kaggle, then Exa/Firecrawl open-web discovery, then Desktop escalation for blockers. Returns scored candidates, fallback reasons, and benchmark evidence.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Model selection objective (task, constraints, latency/cost/quality goals).' },
                maxResults: { type: 'number', description: 'Maximum candidates to return (1-15, default 10).' },
                benchmarkTopN: { type: 'number', description: 'How many leading candidates to enrich with benchmark searches (1-8, default 5).' },
                includeTier3: { type: 'boolean', description: 'Force open-web fallback tier when enabled.' },
            },
            required: ['query'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = modelSearchArgsSchema.safeParse(args);
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
        const benchmarkTopN = parsed.data.benchmarkTopN ?? 5;
        const policy = sourcePolicyFromConstraintConfig(context.constraints?.sourcePolicy);
        const MIN_ACCEPTABLE_SCORE = 0.58;
        const tierOrder: SourceTier[] = (() => {
            const base: SourceTier[] = getTierOrder(policy);
            if (!parsed.data.includeTier3) return base;
            if (base.includes('tier3')) return base;
            return [...base, 'tier3'];
        })();

        const attempts: SourceTierAttemptTelemetry[] = [];
        const candidates = new Map<string, Candidate>();

        for (const tier of tierOrder) {
            const includeDomains = tier === 'tier3' ? undefined : getTierDomains('model', tier, policy);
            const search = await exaSearch({
                apiKey,
                query: parsed.data.query,
                includeDomains: includeDomains && includeDomains.length > 0 ? includeDomains : undefined,
                maxResults,
            });
            if (!search.ok) {
                return { ok: false, error: { name: 'ExaError', message: search.message } };
            }

            let tierBestScore: number | null = null;
            let tierViableCandidates = 0;
            for (const row of search.rows) {
                const key = modelKey(row);
                const text = `${row.highlights?.join('\n') ?? ''}\n${row.textSnippet ?? ''}`;
                const benchmarkSignals = benchmarkSignalCount(`${row.title}\n${text}`);
                const benchmarkDomainHits = row.domain && isBenchmarkDomain(row.domain, policy) ? 1 : 0;
                const relevance = typeof row.score === 'number' ? Math.max(0, Math.min(1, row.score)) : 0;
                if (tierBestScore === null || relevance > tierBestScore) {
                    tierBestScore = relevance;
                }
                if (relevance >= MIN_ACCEPTABLE_SCORE) {
                    tierViableCandidates += 1;
                }
                const previous = candidates.get(key);
                if (previous && (previous.score ?? 0) >= (row.score ?? 0)) continue;
                candidates.set(key, {
                    modelId: extractLikelyModelId(row.url) ?? row.title,
                    title: row.title,
                    url: row.url,
                    domain: row.domain,
                    tier,
                    score: row.score,
                    publishedDate: row.publishedDate,
                    notes: text.slice(0, 1200),
                    benchmarkSignalCount: benchmarkSignals,
                    benchmarkDomainHits,
                    freshestBenchmarkDate: row.publishedDate,
                });
            }

            const attempt = buildTierAttemptTelemetry({
                tier,
                includeDomains: includeDomains && includeDomains.length > 0 ? includeDomains : null,
                numResults: search.rows.length,
                minResultsRequired: Math.max(1, policy.minResultsPerTier),
                viableCandidates: tierViableCandidates,
                bestScore: tierBestScore,
                minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                canEscalate: tier !== 'tier3',
            });
            attempts.push(attempt);
            if (!attempt.escalated) break;
        }

        const preliminary = Array.from(candidates.values())
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, Math.max(1, benchmarkTopN));

        await Promise.all(preliminary.map(async (candidate) => {
            const benchmarkQuery = `${candidate.modelId} benchmark leaderboard LMArena MMLU GPQA`;
            const bench = await exaSearch({
                apiKey,
                query: benchmarkQuery,
                includeDomains: policy.benchmarkDomains,
                maxResults: 6,
            });
            if (!bench.ok) return;
            let domainHits = 0;
            let signalHits = 0;
            let freshest = candidate.freshestBenchmarkDate;
            for (const row of bench.rows) {
                if (row.domain && isBenchmarkDomain(row.domain, policy)) domainHits += 1;
                signalHits += benchmarkSignalCount(`${row.title}\n${row.highlights?.join('\n') ?? ''}\n${row.textSnippet ?? ''}`);
                freshest = updateFreshestDate(freshest, row.publishedDate);
            }
            const key = modelKey({ title: candidate.title, url: candidate.url });
            const next = candidates.get(key);
            if (!next) return;
            next.benchmarkDomainHits += domainHits;
            next.benchmarkSignalCount += signalHits;
            next.freshestBenchmarkDate = freshest;
            candidates.set(key, next);
        }));

        const ranked = Array.from(candidates.values())
            .map((candidate) => {
                const scored = modelCandidateScore({
                    title: candidate.title,
                    url: candidate.url,
                    text: candidate.notes,
                    score: candidate.score,
                    publishedDate: candidate.freshestBenchmarkDate ?? candidate.publishedDate,
                    benchmarkSignalCount: candidate.benchmarkSignalCount,
                    benchmarkDomainHits: candidate.benchmarkDomainHits,
                    policy,
                });
                return {
                    modelId: candidate.modelId,
                    title: candidate.title,
                    url: candidate.url,
                    domain: candidate.domain,
                    tier: candidate.tier,
                    benchmarkSignalCount: candidate.benchmarkSignalCount,
                    benchmarkDomainHits: candidate.benchmarkDomainHits,
                    freshestBenchmarkDate: candidate.freshestBenchmarkDate ?? null,
                    searchScore: candidate.score ?? null,
                    totalScore: scored.total,
                    scoreBreakdown: scored.breakdown,
                    usageHints: buildModelUsageHints(candidate.modelId, candidate.url),
                };
            })
            .sort((a, b) => b.totalScore - a.totalScore)
            .slice(0, maxResults)
            .map((item, idx) => ({ rank: idx + 1, ...item }));

        const recommended = ranked[0] ?? null;
        const tierUsed = attempts[attempts.length - 1]?.tier ?? 'tier1';
        const desktopEscalation = evaluateDesktopEscalationGuard({
            strictness: policy.strictness,
            intent: 'model',
            attempts,
            requireOpenWebTier: policy.fallbackToOpenWeb,
        });
        const artifactContent = {
            kind: 'model_candidates_v2',
            performedAt: new Date().toISOString(),
            query: parsed.data.query,
            tierUsed,
            policy: {
                strictness: policy.strictness,
                benchmarkMaxAgeDays: policy.benchmarkMaxAgeDays,
                benchmarkDomains: policy.benchmarkDomains,
                fallbackToGovSources: policy.fallbackToGovSources,
                fallbackToOpenWeb: policy.fallbackToOpenWeb,
            },
            fallbackChain: buildSourceFallbackChain('model', policy),
            attempts,
            fallbackTelemetry: {
                minAcceptableScore: MIN_ACCEPTABLE_SCORE,
                desktopEscalation,
            },
            candidates: ranked,
            recommended,
        };
        const artifactId = `model-search-${randomUUID()}`;

        return {
            ok: true,
            data: artifactContent,
            evidence: {
                sources: ranked.map((item) => ({
                    rank: item.rank,
                    title: item.title,
                    url: item.url,
                    score: item.totalScore,
                    benchmarkDomainHits: item.benchmarkDomainHits,
                })),
            },
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: artifactId,
                        type: 'model_card',
                        title: 'Model Candidates',
                        content: artifactContent,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: artifactId, type: 'model_card' } },
            ],
        };
    },
};

