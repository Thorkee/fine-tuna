# Dataset Source Policy

This policy defines how agents discover datasets while balancing relevance, availability, licensing, and safety.

## Policy Goals

- Prefer high-trust dataset sources first.
- Avoid dead-end allowlists by using controlled fallback.
- Keep all source decisions auditable (tier attempts, fallback reasons, candidate scores).

## Tiered Source Strategy

- **Tier 1 (preferred):** Hugging Face datasets only.
- **Tier 2 (trusted fallback):** GitHub repositories, Kaggle datasets, and optional public open-data domains.
- **Tier 3 (open-web/crawl fallback):** broader web discovery and crawl workflows when prior tiers fail.

Tier behavior is controlled by:

- `TUNA_AGENT_SOURCE_POLICY_STRICTNESS` (`off | prefer | strict`)
- `TUNA_AGENT_SOURCE_POLICY_FALLBACK_GOV`
- `TUNA_AGENT_SOURCE_POLICY_FALLBACK_OPEN_WEB`
- `TUNA_AGENT_SOURCE_POLICY_MIN_RESULTS_PER_TIER`

## Candidate Ranking Criteria

Dataset candidates are scored using:

- **Relevance:** semantic match to the query/problem.
- **Availability:** likelihood the source is directly accessible/downloadable.
- **License signal:** explicit license/open-data wording.
- **Freshness:** recency signal from publication metadata.
- **Access friction penalty:** private/login/captcha/private-hosting indicators.

## Fallback Rules

- Explicit chain for operational use: **Hugging Face -> GitHub/Kaggle -> Exa/Firecrawl crawl -> Desktop escalation**.
- Escalate from tier1 to tier2/tier3 only when candidate count or quality is insufficient.
- When fallback occurs, record why prior tier failed (for example too few results, low scores, unavailable links).
- In strict mode, manual domain overrides that violate policy are blocked.
- Desktop/browser escalation is allowed only after prior-tier failure evidence is present in runtime telemetry.

## Crawl Guardrails

- Crawl only when user intent requires data that cannot be sourced from preferred tiers.
- Respect legal/robots/site terms and avoid abusive scraping behavior.
- Never request or expose secrets/tokens in crawl instructions.
- Prefer official APIs/export links over brittle scraping when possible.

## Tooling Contract

- Use Hugging Face tools (`hf_hub_search`, `hf_dataset_explore`, `hf_dataset_query`) first when possible.
- Use `dataset_search` for broad candidate ranking and fallback evidence.
- Use `web_search`/`web_fetch` for follow-up validation and Exa/Firecrawl fallback expansion.
- Use `sandbox_browser`/`desktop_*` only when crawl/web paths are blocked by rendering or auth constraints.
- Return explicit candidate evidence (`url`, `tier`, `scoreBreakdown`) to downstream steps.

## Expected Output Shape (high level)

- Query + timestamp
- Source policy snapshot
- Tier attempts with result counts
- Tier attempts with fallback reasons (`insufficient_results`, `insufficient_viable_candidates`, `insufficient_quality`, `tier_exhausted`)
- Ranked candidates with score breakdown
- Recommended candidate + rationale

