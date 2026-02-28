import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
    buildSourcePolicySettings,
    buildTierAttemptTelemetry,
    evaluateDesktopEscalationGuard,
    getTierDomains,
} from '../source-policy';

describe('source policy defaults', () => {
    it('enforces HF-first domains for dataset and model tier1', () => {
        const policy = buildSourcePolicySettings();

        const datasetTier1 = getTierDomains('dataset', 'tier1', policy);
        const datasetTier2 = getTierDomains('dataset', 'tier2', policy);
        const modelTier1 = getTierDomains('model', 'tier1', policy);
        const modelTier2 = getTierDomains('model', 'tier2', policy);

        expect(datasetTier1).toContain('huggingface.co');
        expect(datasetTier1).not.toContain('github.com');
        expect(datasetTier1).not.toContain('kaggle.com');
        expect(datasetTier2).toContain('github.com');
        expect(datasetTier2).toContain('kaggle.com');

        expect(modelTier1).toContain('huggingface.co');
        expect(modelTier1).not.toContain('github.com');
        expect(modelTier2).toContain('github.com');
        expect(modelTier2).toContain('kaggle.com');
    });
});

describe('tier fallback telemetry', () => {
    it('captures fallback reasons and escalation when tier is weak', () => {
        const attempt = buildTierAttemptTelemetry({
            tier: 'tier1',
            includeDomains: ['huggingface.co'],
            numResults: 1,
            minResultsRequired: 3,
            viableCandidates: 0,
            bestScore: 0.22,
            minAcceptableScore: 0.55,
            canEscalate: true,
        });

        expect(attempt.channel).toBe('huggingface');
        expect(attempt.escalated).toBe(true);
        expect(attempt.fallbackReasons).toContain('insufficient_results');
        expect(attempt.fallbackReasons).toContain('insufficient_viable_candidates');
        expect(attempt.fallbackReasons).toContain('insufficient_quality');
    });

    it('does not escalate when tier quality is sufficient', () => {
        const attempt = buildTierAttemptTelemetry({
            tier: 'tier2',
            includeDomains: ['github.com', 'kaggle.com'],
            numResults: 5,
            minResultsRequired: 3,
            viableCandidates: 4,
            bestScore: 0.82,
            minAcceptableScore: 0.55,
            canEscalate: true,
        });

        expect(attempt.escalated).toBe(false);
        expect(attempt.fallbackReasons).toHaveLength(0);
    });
});

describe('desktop escalation guard', () => {
    it('blocks desktop escalation when prior-tier evidence is missing', () => {
        const guard = evaluateDesktopEscalationGuard({
            strictness: 'strict',
            intent: 'dataset',
            attempts: [],
            requireOpenWebTier: true,
        });

        expect(guard.allowed).toBe(false);
        expect(guard.unmetRequirements).toContain('no_prior_source_attempts');
    });

    it('allows desktop escalation when tier failures are recorded', () => {
        const guard = evaluateDesktopEscalationGuard({
            strictness: 'prefer',
            intent: 'model',
            requireOpenWebTier: true,
            attempts: [
                { tier: 'tier1', fallbackReasons: ['insufficient_results'], escalated: true },
                { tier: 'tier2', fallbackReasons: ['insufficient_quality'], escalated: true },
                { tier: 'tier3', fallbackReasons: ['tier_exhausted'], escalated: false },
            ],
        });

        expect(guard.allowed).toBe(true);
        expect(guard.reason).toBe('evidence_present');
    });
});
