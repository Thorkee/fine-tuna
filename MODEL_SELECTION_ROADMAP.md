# Model Selection Roadmap

This roadmap defines how agents select open-source models with deterministic source policy and fresh benchmark evidence.

## Objectives

- Prefer trustworthy OSS model sources first.
- Use fresh benchmark evidence (for example LMArena + other leaderboards) instead of stale one-off picks.
- Keep fallback behavior explicit when preferred sources do not satisfy task constraints.

## Decision Rubric

Every candidate model is ranked with a weighted score:

- **Task relevance (32%)**: how well the model appears to match the requested task.
- **Benchmark coverage (26%)**: benchmark evidence density across trusted benchmark domains.
- **Freshness (18%)**: recency of benchmark/publication evidence against `TUNA_AGENT_MODEL_BENCHMARK_MAX_AGE_DAYS`.
- **Deployability (16%)**: practical availability for OSS usage (model hub availability, integration friction).
- **Openness (8%)**: open weights/license signals.

If policy strictness is `strict`, final selection must come from the preferred ranked pool; otherwise a policy override is applied.

## Source Tiers

- **Tier 1 (preferred)**: Hugging Face model hubs.
- **Tier 2 (fallback)**: GitHub/Kaggle plus secondary research sources (for example papers/leaderboards with weaker deployability guarantees).
- **Tier 3 (last resort)**: Exa/Firecrawl-backed open web discovery when prior tiers do not produce enough viable candidates.
- **Escalation**: Desktop/browser automation only for blocker cases (auth or JS-heavy flows not handled by crawler/search tools).

## Benchmark Freshness Guidance

- Use LMArena and additional benchmark hubs as first-class evidence sources.
- Degrade benchmark confidence when evidence is older than `TUNA_AGENT_MODEL_BENCHMARK_MAX_AGE_DAYS`.
- Re-query benchmark evidence for top candidates during recommendation time before final choice.

## Implementation Phases

## Phase 1 - Policy baseline

**Goal:** Centralize source-policy settings and benchmark freshness controls.

**Files**
- `src/lib/agent/source-policy.ts`
- `src/lib/agent/types.ts`
- `src/lib/agent/coordinator.ts`

**Validation**
- Source policy settings load from server env.
- Defaults are applied even when old state lacks policy fields.

## Phase 2 - Deterministic tool gates

**Goal:** Enforce source policy in web research tools and runtime guardrails.

**Files**
- `src/lib/agent/tools/web-search.ts`
- `src/lib/agent/tools/web-fetch.ts`
- `src/lib/agent/tool-runner.ts`

**Validation**
- Strict mode blocks off-policy fetch/search domain overrides.
- Tier escalation occurs only when candidate volume is insufficient.

## Phase 3 - Dedicated model search

**Goal:** Add model-focused discovery with benchmark-aware ranking.

**Files**
- `src/lib/agent/tools/model-search.ts`

**Validation**
- Ranked candidates include benchmark coverage + freshness signals.
- Artifacts include explicit policy metadata and tier attempts.

## Phase 4 - Recommendation flow integration

**Goal:** Use ranked benchmark evidence in final recommendation and checkpoints.

**Files**
- `src/lib/azure-openai/service.ts`
- `src/lib/pipeline/orchestrator.ts`
- `src/types/index.ts`

**Validation**
- Recommendation output contains candidate ranking metadata.
- Pipeline checkpoint alternatives reflect ranked evidence.

## Operational Cadence

- Revisit benchmark domains quarterly or when model ecosystem shifts.
- Keep `TUNA_AGENT_PREFERRED_BASE_MODELS` updated as the default shortlist.
- Monitor fallback frequency; high tier2/tier3 usage indicates tier1 source updates are needed.

