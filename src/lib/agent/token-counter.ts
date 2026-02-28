import type { Message } from '@/types';

export type TokenEstimateOptions = {
  /**
   * Approximate characters per token. 3 is conservative and better suited for
   * JSON/code-heavy agent conversations (tool schemas, tool call arguments, etc.).
   * Keep this configurable so we can calibrate per deployment/workload.
   */
  charsPerToken?: number;
  /**
   * Rough overhead per message (role, formatting, separators, metadata).
   */
  perMessageOverheadTokens?: number;
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function estimateTokensFromText(text: string, opts?: TokenEstimateOptions): number {
  const charsPerToken = opts?.charsPerToken && opts.charsPerToken > 0 ? opts.charsPerToken : 3;
  const normalized = typeof text === 'string' ? text : '';
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / charsPerToken));
}

export function estimateTokensForMessage(message: Message, opts?: TokenEstimateOptions): number {
  const perMessageOverhead =
    typeof opts?.perMessageOverheadTokens === 'number' && Number.isFinite(opts.perMessageOverheadTokens)
      ? Math.max(0, Math.floor(opts.perMessageOverheadTokens))
      : 16;

  const content = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  const name = typeof message.name === 'string' ? message.name : '';
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';

  // Tool call payloads can be large; include them in estimation.
  const toolCallsText = toolCalls ? safeStringify(toolCalls) : '';

  const parts = [
    message.role,
    content,
    toolCallsText,
    name,
    toolCallId,
  ].filter(Boolean).join('\n');

  return perMessageOverhead + estimateTokensFromText(parts, opts);
}

export function estimateTokensForMessages(messages: Message[], opts?: TokenEstimateOptions): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokensForMessage(m, opts);
  }
  return total;
}

