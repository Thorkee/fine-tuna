import 'server-only';

import type { AgentConstraints } from '@/lib/agent/types';

export type LlmProviderId = AgentConstraints['provider'];

const DEFAULT_PROVIDER: LlmProviderId = 'aws_bedrock';

function normalizeProvider(raw: string): LlmProviderId | null {
    const value = raw.trim().toLowerCase();
    if (!value) return null;
    if (value === 'aws_bedrock' || value === 'bedrock') return 'aws_bedrock';
    if (value === 'azure_openai' || value === 'azure') return 'azure_openai';
    if (value === 'openai') return 'openai';
    return null;
}

export function getConfiguredLlmProvider(): LlmProviderId {
    const candidates = [process.env.TUNA_LLM_PROVIDER];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const normalized = normalizeProvider(candidate);
        if (normalized) return normalized;
    }
    return DEFAULT_PROVIDER;
}

