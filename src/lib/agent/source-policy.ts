import 'server-only';

export type SourcePolicyStrictness = 'off' | 'prefer' | 'strict';
export type SourceDiscoveryIntent = 'dataset' | 'model' | 'general';
export type SourceTier = 'tier1' | 'tier2' | 'tier3';
export type SourceDiscoveryChannel = 'huggingface' | 'github_kaggle' | 'exa_firecrawl' | 'desktop_escalation';

export type SourceFallbackStep = {
    step: number;
    channel: SourceDiscoveryChannel;
    objective: string;
    recommendedTools: string[];
    escalateWhen: string;
};

export type SourceFallbackReason =
    | 'insufficient_results'
    | 'insufficient_viable_candidates'
    | 'insufficient_quality'
    | 'tier_exhausted'
    | 'api_error';

export type SourceTierAttemptTelemetry = {
    tier: SourceTier;
    channel: SourceDiscoveryChannel;
    includeDomains: string[] | null;
    numResults: number;
    minResultsRequired: number;
    viableCandidates: number;
    bestScore: number | null;
    fallbackReasons: SourceFallbackReason[];
    escalated: boolean;
};

export type DesktopEscalationGuard = {
    allowed: boolean;
    reason: 'not_required' | 'missing_evidence' | 'evidence_present';
    unmetRequirements: string[];
};

export interface SourcePolicySettings {
    strictness: SourcePolicyStrictness;
    fallbackToGovSources: boolean;
    fallbackToOpenWeb: boolean;
    benchmarkMaxAgeDays: number;
    minResultsPerTier: number;
    preferredBaseModels: string[];
    datasetTier1Domains: string[];
    datasetTier2Domains: string[];
    modelTier1Domains: string[];
    modelTier2Domains: string[];
    benchmarkDomains: string[];
}

export interface SourcePolicyOverrides {
    strictness?: SourcePolicyStrictness;
    fallbackToGovSources?: boolean;
    fallbackToOpenWeb?: boolean;
    benchmarkMaxAgeDays?: number;
    minResultsPerTier?: number;
    preferredBaseModels?: string[];
    datasetTier1Domains?: string[];
    datasetTier2Domains?: string[];
    modelTier1Domains?: string[];
    modelTier2Domains?: string[];
    benchmarkDomains?: string[];
}

const DEFAULT_PREFERRED_BASE_MODELS = [
    'mistralai/Magistral-Small-2509',
    'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
    'mistralai/Devstral-Small-2505',
    'mistralai/Mistral-Small-3.1-24B-Instruct-2503',
    'mistralai/Mistral-Nemo-Instruct-2407',
    'mistralai/Mistral-Large-Instruct-2407',
    'mistralai/Mixtral-8x22B-Instruct-v0.1',
    'mistralai/Mixtral-8x7B-Instruct-v0.1',
];

const DEFAULT_DATASET_TIER1_DOMAINS = [
    'huggingface.co',
    'datasets-server.huggingface.co',
];

const DEFAULT_DATASET_TIER2_DOMAINS = [
    'kaggle.com',
    'github.com',
    'raw.githubusercontent.com',
    'data.gov',
    'catalog.data.gov',
    'data.gov.uk',
    'data.europa.eu',
    'opendata.cityofnewyork.us',
    'open.canada.ca',
    'data.worldbank.org',
    'data.un.org',
];

const DEFAULT_MODEL_TIER1_DOMAINS = [
    'huggingface.co',
];

const DEFAULT_MODEL_TIER2_DOMAINS = [
    'github.com',
    'raw.githubusercontent.com',
    'kaggle.com',
    'ollama.com',
    'paperswithcode.com',
    'arxiv.org',
    'openreview.net',
];

const DEFAULT_BENCHMARK_DOMAINS = [
    'lmarena.ai',
    'huggingface.co',
    'paperswithcode.com',
    'artificialanalysis.ai',
];

function readFirstEnv(...names: string[]): string {
    for (const name of names) {
        const raw = (process.env[name] || '').trim();
        if (raw) return raw;
    }
    return '';
}

function parseBooleanEnv(fallback: boolean, ...names: string[]): boolean {
    const raw = readFirstEnv(...names).toLowerCase();
    if (!raw) return fallback;
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return fallback;
}

function parsePositiveIntEnv(fallback: number, ...names: string[]): number {
    const raw = readFirstEnv(...names);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function toStrictness(raw: string | undefined, fallback: SourcePolicyStrictness): SourcePolicyStrictness {
    if (!raw) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'prefer' || normalized === 'strict') return normalized;
    return fallback;
}

function normalizeDomain(input: string): string {
    return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const cleaned = value.trim();
        if (!cleaned || seen.has(cleaned)) continue;
        seen.add(cleaned);
        out.push(cleaned);
    }
    return out;
}

function uniqueDomains(values: string[]): string[] {
    const normalized = values.map(v => normalizeDomain(v)).filter(Boolean);
    return uniqueStrings(normalized);
}

function parseCsvEnv(...names: string[]): string[] {
    const raw = readFirstEnv(...names);
    if (!raw) return [];
    return raw
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function parseDomainCsvEnv(...names: string[]): string[] {
    return uniqueDomains(parseCsvEnv(...names));
}

function parseStringCsvEnv(...names: string[]): string[] {
    return uniqueStrings(parseCsvEnv(...names));
}

function pickStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean);
    return out.length > 0 ? out : undefined;
}

function toHostname(urlOrDomain: string): string {
    const input = String(urlOrDomain || '').trim();
    if (!input) return '';
    try {
        return normalizeDomain(new URL(input).hostname);
    } catch {
        return normalizeDomain(input);
    }
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
    if (!hostname || !domain) return false;
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function listIncludesDomain(domains: string[], hostname: string): boolean {
    return domains.some(domain => hostMatchesDomain(hostname, domain));
}

export function buildSourcePolicySettings(overrides?: SourcePolicyOverrides): SourcePolicySettings {
    const envStrictness = toStrictness(
        readFirstEnv('TUNA_AGENT_SOURCE_POLICY_STRICTNESS') || undefined,
        'prefer'
    );
    const strictness = overrides?.strictness ?? envStrictness;

    const fallbackToGovSources = overrides?.fallbackToGovSources
        ?? parseBooleanEnv(true, 'TUNA_AGENT_SOURCE_POLICY_FALLBACK_GOV');
    const fallbackToOpenWeb = overrides?.fallbackToOpenWeb
        ?? parseBooleanEnv(true, 'TUNA_AGENT_SOURCE_POLICY_FALLBACK_OPEN_WEB');
    const benchmarkMaxAgeDays = overrides?.benchmarkMaxAgeDays
        ?? parsePositiveIntEnv(60, 'TUNA_AGENT_MODEL_BENCHMARK_MAX_AGE_DAYS');
    const minResultsPerTier = overrides?.minResultsPerTier
        ?? parsePositiveIntEnv(3, 'TUNA_AGENT_SOURCE_POLICY_MIN_RESULTS_PER_TIER');

    const datasetTier1Domains = uniqueDomains([
        ...DEFAULT_DATASET_TIER1_DOMAINS,
        ...parseDomainCsvEnv('TUNA_AGENT_DATASET_TIER1_DOMAINS'),
        ...(overrides?.datasetTier1Domains ?? []),
    ]);

    const datasetTier2Domains = uniqueDomains([
        ...DEFAULT_DATASET_TIER2_DOMAINS,
        ...parseDomainCsvEnv('TUNA_AGENT_DATASET_TIER2_DOMAINS'),
        ...(overrides?.datasetTier2Domains ?? []),
    ]);

    const modelTier1Domains = uniqueDomains([
        ...DEFAULT_MODEL_TIER1_DOMAINS,
        ...parseDomainCsvEnv('TUNA_AGENT_MODEL_TIER1_DOMAINS'),
        ...(overrides?.modelTier1Domains ?? []),
    ]);

    const modelTier2Domains = uniqueDomains([
        ...DEFAULT_MODEL_TIER2_DOMAINS,
        ...parseDomainCsvEnv('TUNA_AGENT_MODEL_TIER2_DOMAINS'),
        ...(overrides?.modelTier2Domains ?? []),
    ]);

    const benchmarkDomains = uniqueDomains([
        ...DEFAULT_BENCHMARK_DOMAINS,
        ...parseDomainCsvEnv('TUNA_AGENT_BENCHMARK_DOMAINS'),
        ...(overrides?.benchmarkDomains ?? []),
    ]);

    const preferredBaseModels = uniqueStrings([
        ...DEFAULT_PREFERRED_BASE_MODELS,
        ...parseStringCsvEnv('TUNA_AGENT_PREFERRED_BASE_MODELS'),
        ...(overrides?.preferredBaseModels ?? []),
    ]);

    return {
        strictness,
        fallbackToGovSources,
        fallbackToOpenWeb,
        benchmarkMaxAgeDays,
        minResultsPerTier,
        preferredBaseModels,
        datasetTier1Domains,
        datasetTier2Domains,
        modelTier1Domains,
        modelTier2Domains,
        benchmarkDomains,
    };
}

export function sourcePolicyFromConstraintConfig(config: unknown): SourcePolicySettings {
    const raw = (typeof config === 'object' && config !== null)
        ? (config as Record<string, unknown>)
        : {};
    const strictnessRaw = typeof raw.strictness === 'string' ? raw.strictness : undefined;
    const strictness = toStrictness(strictnessRaw, 'prefer');
    const fallbackToGovSources = typeof raw.fallbackToGovSources === 'boolean' ? raw.fallbackToGovSources : undefined;
    const fallbackToOpenWeb = typeof raw.fallbackToOpenWeb === 'boolean' ? raw.fallbackToOpenWeb : undefined;
    const benchmarkMaxAgeDays = typeof raw.benchmarkMaxAgeDays === 'number' && Number.isFinite(raw.benchmarkMaxAgeDays)
        ? Math.max(1, Math.floor(raw.benchmarkMaxAgeDays))
        : undefined;
    const minResultsPerTier = typeof raw.minResultsPerTier === 'number' && Number.isFinite(raw.minResultsPerTier)
        ? Math.max(1, Math.floor(raw.minResultsPerTier))
        : undefined;

    return buildSourcePolicySettings({
        strictness,
        fallbackToGovSources,
        fallbackToOpenWeb,
        benchmarkMaxAgeDays,
        minResultsPerTier,
        preferredBaseModels: pickStringArray(raw.preferredBaseModels),
        datasetTier1Domains: pickStringArray(raw.datasetTier1Domains),
        datasetTier2Domains: pickStringArray(raw.datasetTier2Domains),
        modelTier1Domains: pickStringArray(raw.modelTier1Domains),
        modelTier2Domains: pickStringArray(raw.modelTier2Domains),
        benchmarkDomains: pickStringArray(raw.benchmarkDomains),
    });
}

export function detectDiscoveryIntent(input: string | string[]): SourceDiscoveryIntent {
    const text = Array.isArray(input) ? input.join(' ') : input;
    const normalized = String(text || '').toLowerCase();

    const datasetSignals = [
        'dataset',
        'data set',
        'data source',
        'csv',
        'parquet',
        'jsonl',
        'kaggle',
        'open data',
        'tabular',
        'training data',
        'scrape data',
    ];
    const modelSignals = [
        'model',
        'checkpoint',
        'weights',
        'llm',
        'benchmark',
        'leaderboard',
        'lmarena',
        'mmlu',
        'gpqa',
        'instruction-tuned',
        'fine-tune',
        'finetune',
    ];

    const datasetHits = datasetSignals.filter(s => normalized.includes(s)).length;
    const modelHits = modelSignals.filter(s => normalized.includes(s)).length;

    if (datasetHits > modelHits && datasetHits > 0) return 'dataset';
    if (modelHits > datasetHits && modelHits > 0) return 'model';
    if (datasetHits > 0 && modelHits === 0) return 'dataset';
    if (modelHits > 0 && datasetHits === 0) return 'model';
    return 'general';
}

export function getTierDomains(
    intent: SourceDiscoveryIntent,
    tier: SourceTier,
    policy: SourcePolicySettings
): string[] {
    if (tier === 'tier3') return [];
    if (intent === 'dataset') {
        return tier === 'tier1' ? policy.datasetTier1Domains : policy.datasetTier2Domains;
    }
    if (intent === 'model') {
        return tier === 'tier1' ? policy.modelTier1Domains : policy.modelTier2Domains;
    }
    return [];
}

export function getTierOrder(policy: SourcePolicySettings): SourceTier[] {
    const out: SourceTier[] = ['tier1'];
    if (policy.fallbackToGovSources) out.push('tier2');
    if (policy.fallbackToOpenWeb) out.push('tier3');
    return out;
}

export function buildSourceFallbackChain(intent: SourceDiscoveryIntent, policy: SourcePolicySettings): SourceFallbackStep[] {
    const subject = intent === 'dataset' ? 'dataset' : intent === 'model' ? 'model' : 'asset';
    return [
        {
            step: 1,
            channel: 'huggingface',
            objective: `Start with Hugging Face ${subject} discovery and direct repo-backed candidates.`,
            recommendedTools: ['hf_hub_search', 'hf_dataset_explore', 'hf_dataset_query', 'hf_get_documentation'],
            escalateWhen: `Escalate when no viable Hugging Face candidates satisfy constraints or minimum results (${Math.max(1, policy.minResultsPerTier)}) are not met.`,
        },
        {
            step: 2,
            channel: 'github_kaggle',
            objective: 'Expand to GitHub repositories and Kaggle datasets/competitions as secondary trusted sources.',
            recommendedTools: ['dataset_search', 'model_search', 'kaggle_dataset_download', 'github_repo_checkout'],
            escalateWhen: 'Escalate when secondary candidates are missing, inaccessible, or licensing/quality signals are insufficient.',
        },
        {
            step: 3,
            channel: 'exa_firecrawl',
            objective: 'Use broader retrieval and crawling to discover long-tail sources (Exa first, Firecrawl via MCP when needed).',
            recommendedTools: ['dataset_search', 'model_search', 'web_search', 'web_fetch', 'mcp.firecrawl-mcp.*'],
            escalateWhen: policy.fallbackToOpenWeb
                ? 'Escalate when content is JS-heavy/paywalled/incomplete or open-web evidence remains too thin.'
                : 'Tier3 open-web fallback is disabled by policy; stop before broad web expansion.',
        },
        {
            step: 4,
            channel: 'desktop_escalation',
            objective: 'Escalate to interactive browser/Desktop workflows for blockers that require rendered or manual interaction.',
            recommendedTools: ['sandbox_browser', 'desktop_start', 'desktop_action', 'desktop_screenshot', 'desktop_stream_start'],
            escalateWhen: 'Use only when prior steps fail due to authentication challenges, anti-bot gates, or dynamic pages.',
        },
    ];
}

export function classifyDomainTier(
    domainOrUrl: string,
    intent: SourceDiscoveryIntent,
    policy: SourcePolicySettings
): SourceTier | 'unknown' | 'out_of_policy' {
    const hostname = toHostname(domainOrUrl);
    if (!hostname) return 'unknown';

    const tier1 = getTierDomains(intent, 'tier1', policy);
    if (listIncludesDomain(tier1, hostname)) return 'tier1';

    const tier2 = getTierDomains(intent, 'tier2', policy);
    if (listIncludesDomain(tier2, hostname)) return 'tier2';

    if (policy.fallbackToOpenWeb) return 'tier3';
    return 'out_of_policy';
}

export function isDomainAllowed(
    domainOrUrl: string,
    intent: SourceDiscoveryIntent,
    policy: SourcePolicySettings
): boolean {
    const tier = classifyDomainTier(domainOrUrl, intent, policy);
    return tier !== 'out_of_policy';
}

export function shouldEscalateTier(resultsCount: number, policy: SourcePolicySettings): boolean {
    return resultsCount < Math.max(1, policy.minResultsPerTier);
}

export function getChannelForTier(tier: SourceTier): SourceDiscoveryChannel {
    if (tier === 'tier1') return 'huggingface';
    if (tier === 'tier2') return 'github_kaggle';
    return 'exa_firecrawl';
}

export function buildTierAttemptTelemetry(input: {
    tier: SourceTier;
    includeDomains: string[] | null;
    numResults: number;
    minResultsRequired: number;
    viableCandidates: number;
    bestScore: number | null;
    minAcceptableScore: number;
    canEscalate: boolean;
}): SourceTierAttemptTelemetry {
    const minResultsRequired = Math.max(1, Math.floor(input.minResultsRequired));
    const minAcceptableScore = Math.max(0, Math.min(1, input.minAcceptableScore));
    const fallbackReasons: SourceFallbackReason[] = [];

    if (input.numResults < minResultsRequired) {
        fallbackReasons.push('insufficient_results');
    }
    if (input.viableCandidates < minResultsRequired) {
        fallbackReasons.push('insufficient_viable_candidates');
    }
    if (input.bestScore === null || input.bestScore < minAcceptableScore) {
        fallbackReasons.push('insufficient_quality');
    }
    if (input.tier === 'tier3' && fallbackReasons.length > 0) {
        fallbackReasons.push('tier_exhausted');
    }

    return {
        tier: input.tier,
        channel: getChannelForTier(input.tier),
        includeDomains: input.includeDomains,
        numResults: Math.max(0, Math.floor(input.numResults)),
        minResultsRequired,
        viableCandidates: Math.max(0, Math.floor(input.viableCandidates)),
        bestScore: input.bestScore === null ? null : Math.max(0, Math.min(1, input.bestScore)),
        fallbackReasons,
        escalated: input.canEscalate && fallbackReasons.length > 0,
    };
}

export function evaluateDesktopEscalationGuard(input: {
    strictness: SourcePolicyStrictness;
    intent: SourceDiscoveryIntent;
    attempts: Array<{
        tier: SourceTier;
        fallbackReasons?: SourceFallbackReason[];
        escalated?: boolean;
    }>;
    requireOpenWebTier: boolean;
}): DesktopEscalationGuard {
    if (input.strictness === 'off' || input.intent === 'general') {
        return { allowed: true, reason: 'not_required', unmetRequirements: [] };
    }

    const unmetRequirements: string[] = [];
    if (input.attempts.length === 0) {
        unmetRequirements.push('no_prior_source_attempts');
    }

    const hasTier1 = input.attempts.some(attempt => attempt.tier === 'tier1');
    if (!hasTier1) {
        unmetRequirements.push('missing_huggingface_tier_attempt');
    }

    const hasFailureEvidence = input.attempts.some(
        attempt => (attempt.fallbackReasons?.length ?? 0) > 0 || attempt.escalated === true
    );
    if (!hasFailureEvidence) {
        unmetRequirements.push('missing_prior_tier_failure_evidence');
    }

    if (input.requireOpenWebTier) {
        const hasTier3Attempt = input.attempts.some(attempt => attempt.tier === 'tier3');
        if (!hasTier3Attempt) {
            unmetRequirements.push('missing_tier3_open_web_attempt');
        }
    }

    if (unmetRequirements.length > 0) {
        return { allowed: false, reason: 'missing_evidence', unmetRequirements };
    }
    return { allowed: true, reason: 'evidence_present', unmetRequirements: [] };
}

export type CandidateScoreBreakdown = {
    relevance: number;
    availability: number;
    license: number;
    freshness: number;
    benchmarkCoverage?: number;
    deployability?: number;
    openness?: number;
    penalty: number;
};

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function normalizedRelevance(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0.35;
    if (value <= 0) return 0.1;
    if (value >= 1) return 1;
    return value;
}

function lexicalSignalScore(text: string, signals: string[]): number {
    const normalized = text.toLowerCase();
    const hits = signals.filter(signal => normalized.includes(signal.toLowerCase())).length;
    if (hits <= 0) return 0.35;
    return clamp01(0.35 + (hits * 0.15));
}

function baseAvailabilityScore(domain: string): number {
    const d = toHostname(domain);
    if (!d) return 0.45;
    if (hostMatchesDomain(d, 'huggingface.co')) return 0.95;
    if (hostMatchesDomain(d, 'github.com') || hostMatchesDomain(d, 'raw.githubusercontent.com')) return 0.88;
    if (hostMatchesDomain(d, 'kaggle.com')) return 0.72;
    if (hostMatchesDomain(d, 'data.gov') || hostMatchesDomain(d, 'data.gov.uk') || hostMatchesDomain(d, 'data.europa.eu')) return 0.84;
    return 0.62;
}

export function freshnessScore(publishedDate: string | undefined, maxAgeDays: number): number {
    if (!publishedDate) return 0.5;
    const ts = Date.parse(publishedDate);
    if (!Number.isFinite(ts)) return 0.5;
    const ageMs = Date.now() - ts;
    if (ageMs <= 0) return 1;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) return 1;
    if (ageDays >= maxAgeDays) return 0.2;
    return clamp01(1 - (ageDays / maxAgeDays) * 0.8);
}

export function datasetCandidateScore(input: {
    title: string;
    url: string;
    text?: string;
    score?: number;
    publishedDate?: string;
    policy: SourcePolicySettings;
}): { total: number; breakdown: CandidateScoreBreakdown } {
    const text = `${input.title}\n${input.text ?? ''}`;
    const relevance = normalizedRelevance(input.score);
    const availability = baseAvailabilityScore(input.url);
    const license = lexicalSignalScore(text, ['license', 'apache', 'mit', 'cc-by', 'creative commons', 'open data']);
    const freshness = freshnessScore(input.publishedDate, Math.max(14, input.policy.benchmarkMaxAgeDays));
    const frictionSignals = lexicalSignalScore(text, ['sign in', 'recaptcha', 'private dataset', 'permission denied']);
    const penalty = clamp01(Math.max(0, frictionSignals - 0.55));
    const total = clamp01((relevance * 0.42) + (availability * 0.2) + (license * 0.18) + (freshness * 0.2) - (penalty * 0.25));
    return {
        total,
        breakdown: { relevance, availability, license, freshness, penalty },
    };
}

export function modelCandidateScore(input: {
    title: string;
    url: string;
    text?: string;
    score?: number;
    publishedDate?: string;
    benchmarkSignalCount?: number;
    benchmarkDomainHits?: number;
    policy: SourcePolicySettings;
}): { total: number; breakdown: CandidateScoreBreakdown } {
    const text = `${input.title}\n${input.text ?? ''}`.toLowerCase();
    const relevance = normalizedRelevance(input.score);
    const availability = baseAvailabilityScore(input.url);
    const license = lexicalSignalScore(text, ['open-source', 'open source', 'apache', 'mit', 'license']);
    const freshness = freshnessScore(input.publishedDate, input.policy.benchmarkMaxAgeDays);
    const benchmarkSignalCount = Math.max(0, input.benchmarkSignalCount ?? 0);
    const benchmarkDomainHits = Math.max(0, input.benchmarkDomainHits ?? 0);
    const benchmarkCoverage = clamp01((benchmarkSignalCount * 0.12) + (benchmarkDomainHits * 0.22));
    const deployability = clamp01((availability * 0.65) + (license * 0.35));
    const openness = lexicalSignalScore(text, ['open', 'oss', 'open-source', 'weights', 'hf']);
    const penalty = clamp01(lexicalSignalScore(text, ['closed', 'proprietary', 'api-only']) - 0.65);

    const total = clamp01(
        (relevance * 0.32)
        + (benchmarkCoverage * 0.26)
        + (freshness * 0.18)
        + (deployability * 0.16)
        + (openness * 0.08)
        - (penalty * 0.2)
    );

    return {
        total,
        breakdown: {
            relevance,
            availability,
            license,
            freshness,
            benchmarkCoverage,
            deployability,
            openness,
            penalty,
        },
    };
}

export function isBenchmarkDomain(urlOrDomain: string, policy: SourcePolicySettings): boolean {
    const host = toHostname(urlOrDomain);
    if (!host) return false;
    return policy.benchmarkDomains.some(d => hostMatchesDomain(host, d));
}

export function benchmarkSignalCount(text: string): number {
    const normalized = text.toLowerCase();
    const signals = ['lmarena', 'arena', 'leaderboard', 'mmlu', 'gpqa', 'hellaswag', 'mt-bench', 'benchmark'];
    return signals.reduce((acc, signal) => (normalized.includes(signal) ? acc + 1 : acc), 0);
}

export function extractLikelyModelId(url: string): string | undefined {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        const parts = u.pathname.split('/').filter(Boolean);
        if (host.endsWith('huggingface.co') && parts.length >= 2) {
            if (parts[0] === 'models' && parts.length >= 3) return `${parts[1]}/${parts[2]}`;
            if (parts[0] === 'datasets') return undefined;
            return `${parts[0]}/${parts[1]}`;
        }
        if (host.endsWith('github.com') && parts.length >= 2) {
            return `${parts[0]}/${parts[1]}`;
        }
    } catch {
        // No-op
    }
    return undefined;
}

export type ParallelSearchStrategy = {
    parallelTiers: SourceTier[];
    conditionalTier: SourceTier | null;
    skipTiers: SourceTier[];
    hfDirectSearch: boolean;
};

const TIER2_SIGNALS = [
    'kaggle.com', 'kaggle competition', 'kaggle dataset',
    'github.com', 'github repo', 'github repository',
    'government data', 'census', 'data.gov', 'open data portal',
    'data.gov.uk', 'data.europa.eu', 'world bank', 'data.un.org',
];

const TIER3_SIGNALS = [
    'arxiv', 'research paper', 'crawl', 'scrape', 'web scraping',
    'blog post', 'medium.com', 'stackoverflow',
];

export function inferBestStartingTier(query: string): SourceTier {
    const normalized = String(query || '').toLowerCase();
    if (!normalized) return 'tier1';

    const tier2Hits = TIER2_SIGNALS.filter(s => normalized.includes(s)).length;
    const tier3Hits = TIER3_SIGNALS.filter(s => normalized.includes(s)).length;

    if (tier3Hits > tier2Hits && tier3Hits > 0) return 'tier3';
    if (tier2Hits > 0) return 'tier2';
    return 'tier1';
}

export function buildParallelSearchStrategy(
    query: string,
    intent: SourceDiscoveryIntent,
    policy: SourcePolicySettings,
): ParallelSearchStrategy {
    const allowedTiers = getTierOrder(policy);
    const bestTier = inferBestStartingTier(query);

    if (bestTier === 'tier3' && allowedTiers.includes('tier3')) {
        return {
            parallelTiers: allowedTiers,
            conditionalTier: null,
            skipTiers: [],
            hfDirectSearch: false,
        };
    }

    if (bestTier === 'tier2') {
        const parallel: SourceTier[] = [];
        if (allowedTiers.includes('tier2')) parallel.push('tier2');
        if (allowedTiers.includes('tier1')) parallel.push('tier1');
        return {
            parallelTiers: parallel.length > 0 ? parallel : ['tier1'],
            conditionalTier: allowedTiers.includes('tier3') ? 'tier3' : null,
            skipTiers: [],
            hfDirectSearch: false,
        };
    }

    const parallel: SourceTier[] = ['tier1'];
    if (allowedTiers.includes('tier2')) parallel.push('tier2');
    return {
        parallelTiers: parallel,
        conditionalTier: allowedTiers.includes('tier3') ? 'tier3' : null,
        skipTiers: [],
        hfDirectSearch: intent === 'dataset',
    };
}

