import 'server-only';

export type AgentContextWindowConfig = {
  /**
   * Maximum total context tokens supported by the deployment.
   * This is deployment-dependent on Azure and should be configurable.
   */
  maxContextTokens: number;
  /**
   * Optional hard cap on input tokens (prompt tokens) enforced by the provider/model.
   * Some deployments publish separate limits like:
   * - total context window (input + output)
   * - max input tokens
   * - max output tokens
   *
   * If set, the context manager will never build prompts above this cap (minus safety margin),
   * even if `maxContextTokens - maxOutputTokens` would allow more.
   */
  maxInputTokens?: number;
  /**
   * Tokens reserved for the model output (per LLM call).
   * Keeping this modest increases how much input we can include.
   */
  maxOutputTokens: number;
  /**
   * Extra buffer to reduce the chance of off-by-some token overflows.
   */
  safetyMarginTokens: number;
  /**
   * Max output tokens for summary updates.
   */
  summaryMaxOutputTokens: number;
  /**
   * When estimated input usage exceeds this fraction of the input budget,
   * we proactively summarize/trim.
   */
  summaryTriggerFraction: number;
  /**
   * Enable debug logging for context management decisions.
   */
  logContext: boolean;
  /**
   * Hard cap on tool message content size in characters (post-JSON-stringify).
   */
  toolMessageMaxChars: number;
  /**
   * Hard cap on assistant message content size in characters.
   */
  assistantMessageMaxChars: number;
  /**
   * Hard cap on the running summary size in characters.
   * Prevents a runaway summary from consuming too much of the context budget.
   */
  summaryMaxChars: number;
};

function readFirstEnv(...varNames: string[]): string | undefined {
  for (const varName of varNames) {
    const raw = process.env[varName];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return undefined;
}

function parsePositiveIntEnv(...varNames: string[]): number | undefined {
  const raw = readFirstEnv(...varNames);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseBooleanEnv(...varNames: string[]): boolean | undefined {
  const raw = readFirstEnv(...varNames);
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseNumberEnv(...varNames: string[]): number | undefined {
  const raw = readFirstEnv(...varNames);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function getAgentContextWindowConfig(): AgentContextWindowConfig {
  const maxContextTokens =
    parsePositiveIntEnv('TUNA_AGENT_MAX_CONTEXT_TOKENS') ??
    // Mistral Large 3 on Bedrock: 262K. Use a conservative default that
    // won't overshoot any common deployment.
    262_144;

  const maxInputTokens =
    parsePositiveIntEnv('TUNA_AGENT_MAX_INPUT_TOKENS') ??
    undefined;

  const maxOutputTokens =
    parsePositiveIntEnv('TUNA_AGENT_MAX_OUTPUT_TOKENS') ??
    8_192;

  const safetyMarginTokens =
    parsePositiveIntEnv('TUNA_AGENT_CONTEXT_SAFETY_MARGIN_TOKENS') ??
    8_192;

  const summaryMaxOutputTokens =
    parsePositiveIntEnv('TUNA_AGENT_SUMMARY_MAX_OUTPUT_TOKENS') ??
    4_096;

  const summaryTriggerFractionRaw =
    parseNumberEnv('TUNA_AGENT_SUMMARY_TRIGGER_FRACTION') ??
    0.7;
  const summaryTriggerFraction =
    summaryTriggerFractionRaw > 0 && summaryTriggerFractionRaw <= 1
      ? summaryTriggerFractionRaw
      : 0.7;

  const logContext =
    parseBooleanEnv('TUNA_AGENT_LOG_CONTEXT') ??
    false;

  const toolMessageMaxChars =
    parsePositiveIntEnv('TUNA_AGENT_TOOL_MESSAGE_MAX_CHARS') ??
    24_000;

  const assistantMessageMaxChars =
    parsePositiveIntEnv('TUNA_AGENT_ASSISTANT_MESSAGE_MAX_CHARS') ??
    32_000;

  const summaryMaxChars =
    parsePositiveIntEnv('TUNA_AGENT_SUMMARY_MAX_CHARS') ??
    12_000;

  return {
    maxContextTokens,
    maxInputTokens,
    maxOutputTokens,
    safetyMarginTokens,
    summaryMaxOutputTokens,
    summaryTriggerFraction,
    logContext,
    toolMessageMaxChars,
    assistantMessageMaxChars,
    summaryMaxChars,
  };
}

