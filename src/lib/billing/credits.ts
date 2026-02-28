import type { LlmUsage } from '@/lib/azure-openai/service';

export type AggregatedUsage = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type BillingRate = {
  provider: string;
  model: string;
  credits_per_1m_input_tokens: number;
  credits_per_1m_output_tokens: number;
  credits_per_1m_cached_input_tokens?: number | null;
};

export type CreditsBreakdownItem = AggregatedUsage & {
  credits: number;
  rate?: BillingRate;
};

export type CreditsCalculation = {
  totalCredits: number;
  breakdown: CreditsBreakdownItem[];
  missingRates: Array<{ provider: string; model: string }>;
};

function clampNumber(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function aggregateUsage(usages: LlmUsage[]): AggregatedUsage[] {
  const map = new Map<string, AggregatedUsage>();

  for (const usage of usages) {
    const provider = usage.provider || 'azure_openai';
    const model = usage.model || 'unknown';
    const key = `${provider}::${model}`;
    const existing = map.get(key) ?? {
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };

    existing.inputTokens += clampNumber(usage.inputTokens);
    existing.outputTokens += clampNumber(usage.outputTokens);
    existing.cachedTokens += clampNumber(usage.cachedTokens);
    existing.reasoningTokens += clampNumber(usage.reasoningTokens);
    existing.totalTokens += clampNumber(usage.totalTokens);

    map.set(key, existing);
  }

  return Array.from(map.values());
}

function creditsForUsage(usage: AggregatedUsage, rate: BillingRate): number {
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const billableInput = Math.max(0, usage.inputTokens - cached);
  const cachedRate =
    typeof rate.credits_per_1m_cached_input_tokens === 'number'
      ? rate.credits_per_1m_cached_input_tokens
      : rate.credits_per_1m_input_tokens;

  const inputCredits =
    (billableInput * rate.credits_per_1m_input_tokens + cached * cachedRate) /
    1_000_000;
  const outputCredits =
    (usage.outputTokens * rate.credits_per_1m_output_tokens) / 1_000_000;

  return Math.ceil(inputCredits + outputCredits);
}

export function calculateCredits(
  aggregated: AggregatedUsage[],
  rates: BillingRate[]
): CreditsCalculation {
  const rateMap = new Map<string, BillingRate>();
  for (const rate of rates) {
    rateMap.set(`${rate.provider}::${rate.model}`, rate);
  }

  const breakdown: CreditsBreakdownItem[] = [];
  const missingRates: Array<{ provider: string; model: string }> = [];
  let totalCredits = 0;

  for (const usage of aggregated) {
    const rate = rateMap.get(`${usage.provider}::${usage.model}`);
    if (!rate) {
      missingRates.push({ provider: usage.provider, model: usage.model });
      breakdown.push({ ...usage, credits: 0 });
      continue;
    }
    const credits = creditsForUsage(usage, rate);
    totalCredits += credits;
    breakdown.push({ ...usage, credits, rate });
  }

  return { totalCredits, breakdown, missingRates };
}
