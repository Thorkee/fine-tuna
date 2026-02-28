import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import {
    buildTierAttemptTelemetry,
    buildSourceFallbackChain,
    datasetCandidateScore,
    evaluateDesktopEscalationGuard,
    getTierDomains,
    getTierOrder,
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
            'Discover datasets with explicit fallback order: Hugging Face first, then GitHub/Kaggle, then Exa/Firecrawl open-web discovery, then Desktop escalation for blockers. Returns per-tier fallback reasons and desktop-escalation eligibility telemetry.',
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
        const tierOrder: SourceTier[] = (() => {
            const base: SourceTier[] = getTierOrder(policy);
            if (!parsed.data.includeTier3) return base;
            if (base.includes('tier3')) return base;
            return [...base, 'tier3'];
        })();

        const candidateByUrl = new Map<string, {
            title: string;
            url: string;
            domain?: string;
            publishedDate?: string;
            score?: number;
            tier: SourceTier;
            totalScore: number;
            scoreBreakdown: ReturnType<typeof datasetCandidateScore>['breakdown'];
            notes: string;
        }>();

        const attempts: SourceTierAttemptTelemetry[] = [];
        for (const tier of tierOrder) {
            const includeDomains = tier === 'tier3' ? undefined : getTierDomains('dataset', tier, policy);
            const search = await exaSearch({
                apiKey,
                query: parsed.data.query,
                maxResults,
                includeDomains: includeDomains && includeDomains.length > 0 ? includeDomains : undefined,
            });
            if (!search.ok) {
                return { ok: false, error: { name: 'ExaError', message: search.message } };
            }

            let tierBestScore: number | null = null;
            let tierViableCandidates = 0;
            for (const row of search.rows) {
                const descriptiveText = `${row.highlights?.join('\n') ?? ''}\n${row.textSnippet ?? ''}`;
                const scored = datasetCandidateScore({
                    title: row.title,
                    url: row.url,
                    text: descriptiveText,
                    score: row.score,
                    publishedDate: row.publishedDate,
                    policy,
                });
                if (tierBestScore === null || scored.total > tierBestScore) {
                    tierBestScore = scored.total;
                }
                if (scored.total >= MIN_ACCEPTABLE_SCORE) {
                    tierViableCandidates += 1;
                }
                const existing = candidateByUrl.get(row.url);
                if (existing && existing.totalScore >= scored.total) continue;
                candidateByUrl.set(row.url, {
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

