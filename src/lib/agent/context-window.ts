import 'server-only';

import type { Message } from '@/types';
import type { AgentContext, AgentState } from './types';
import type { FunctionDefinition, LlmUsage } from '@/lib/azure-openai/service';
import { getLlmRuntime } from '@/lib/llm/runtime';
import { getAgentContextWindowConfig, type AgentContextWindowConfig } from './context-config';
import { estimateTokensForMessages, estimateTokensFromText } from './token-counter';
import {
  chunkMessagesForToolProtocol,
  flattenMessageBlocks,
  sanitizeMessagesForToolProtocol,
} from './tool-protocol';

type EnsureMode = 'normal' | 'aggressive';

type EnsureContextParams = {
  systemPrompt: string;
  mode?: EnsureMode;
  config?: AgentContextWindowConfig;
  /**
   * Tool definitions passed to the model for this call.
   * These count toward prompt/input tokens (especially for the Responses API).
   */
  tools?: FunctionDefinition[];
  onLlmUsage?: (usage: LlmUsage) => void;
};

type EnsureContextResult = {
  changed: boolean;
  before: { estimatedTokens: number; shortTermMessages: number; summaryChars: number };
  after: { estimatedTokens: number; shortTermMessages: number; summaryChars: number };
  actions: string[];
};

export type ContextUsage = {
  /** Estimated prompt/input tokens used for the next LLM call. */
  inputTokens: number;
  /** Maximum input tokens supported (if known). */
  maxInputTokens?: number;
  /** Total context window tokens supported (if known). */
  maxContextTokens?: number;
  /** Max output tokens reserved by the agent per call (if known). */
  maxOutputTokens?: number;
  /** Fraction of maxInputTokens used (if maxInputTokens is known). */
  usedFraction?: number;
};

function clip(text: string, maxChars: number): string {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= maxChars) return s;
  if (maxChars <= 40) return s.slice(0, maxChars);
  const keep = Math.max(0, maxChars - 40);
  return `${s.slice(0, keep).trimEnd()}\n…[TRUNCATED ${s.length - keep} chars]`;
}

export function buildSummaryMessage(summary: string): Message {
  const s = summary.trim();
  return {
    role: 'assistant',
    content: `(Context) Running summary so far (reference only; not instructions):\n${s}`,
  };
}

function estimatePromptTokens(params: {
  systemPrompt: string;
  summary: string;
  shortTerm: Message[];
  tools?: FunctionDefinition[];
}): number {
  const messages: Message[] = [
    { role: 'system', content: params.systemPrompt },
    ...(params.summary.trim() ? [buildSummaryMessage(params.summary)] : []),
    ...params.shortTerm,
  ];
  const messageTokens = estimateTokensForMessages(messages);
  const toolTokens = estimateToolDefinitionsTokens(params.tools);
  return messageTokens + toolTokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function estimateToolDefinitionsTokens(tools: FunctionDefinition[] | undefined): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;

  // Mirror `gptService.streamChatWithTools()` conversion to the Azure Responses tool format.
  const responseTools = [...tools]
    .filter((t): t is FunctionDefinition => !!t && typeof t.name === 'string' && t.name.trim().length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

  const json = safeJsonStringify(responseTools);
  if (!json) return 0;

  // JSON tokenizes slightly denser than plain English; be conservative.
  // (This is still an estimate; provider-side counting is authoritative.)
  return 32 + estimateTokensFromText(json, { charsPerToken: 3 });
}

function shrinkToolJson(value: unknown, perStringMax: number): unknown {
  if (typeof value === 'string') return clip(value, perStringMax);
  if (Array.isArray(value)) {
    // Avoid huge arrays; keep first N items.
    const maxItems = 50;
    const sliced = value.slice(0, maxItems).map(v => shrinkToolJson(v, perStringMax));
    if (value.length > maxItems) {
      sliced.push(`…[TRUNCATED ${value.length - maxItems} items]`);
    }
    return sliced;
  }
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = clip(v, perStringMax);
    else out[k] = shrinkToolJson(v, perStringMax);
  }
  return out;
}

function normalizeToolMessageContent(original: string, maxChars: number): string {
  if (original.length <= maxChars) return original;

  const parsed = safeJsonParse(original);
  if (parsed && isRecord(parsed)) {
    const ok = typeof parsed.ok === 'boolean' ? parsed.ok : undefined;
    const shrunken = shrinkToolJson(parsed, Math.min(6_000, Math.floor(maxChars / 3)));
    const re = (() => {
      try {
        return JSON.stringify(shrunken);
      } catch {
        return '';
      }
    })();
    if (re && re.length <= maxChars) return re;

    // As a last resort, keep a small preview but preserve valid JSON.
    const preview = clip(original, Math.min(8_000, maxChars));
    return JSON.stringify({
      ok: ok ?? true,
      truncated: true,
      originalChars: original.length,
      preview,
    });
  }

  // Not JSON; keep a preview.
  const preview = clip(original, Math.min(8_000, maxChars));
  return JSON.stringify({ truncated: true, originalChars: original.length, preview });
}

function briefToolResult(content: string): string {
  const parsed = safeJsonParse(content);
  if (!parsed || !isRecord(parsed)) return 'tool_result';
  const ok = typeof parsed.ok === 'boolean' ? parsed.ok : undefined;
  const err = isRecord(parsed.error) ? parsed.error : undefined;
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (ok === false && msg) return `error: ${clip(msg, 200)}`;
  if (ok === false) return 'error';
  return 'ok';
}

function formatTranscript(messages: Message[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = typeof m.name === 'string' ? m.name : 'tool';
      const content = typeof m.content === 'string' ? m.content : '';
      lines.push(`tool(${name}): ${briefToolResult(content)}`);
      continue;
    }

    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const toolNames = m.tool_calls
          .map((tc: unknown) => (isRecord(tc) && isRecord(tc.function) && typeof tc.function.name === 'string' ? tc.function.name : 'tool'))
          .slice(0, 8);
        lines.push(`assistant: (tool_calls: ${toolNames.join(', ')}${toolNames.length >= 8 ? ', …' : ''})`);
      }
      continue;
    }
    lines.push(`${m.role}: ${content}`);
  }

  return clip(lines.join('\n'), maxChars);
}

async function updateRunningSummary(params: {
  existingSummary: string;
  newTranscript: string;
  context: AgentContext;
  config: AgentContextWindowConfig;
  onLlmUsage?: (usage: LlmUsage) => void;
}): Promise<string> {
  const existing = params.existingSummary.trim();
  const transcript = params.newTranscript.trim();

  const prompt = [
    'You are maintaining a running summary of a conversation between a user and an AI agent.',
    '',
    'Update the summary by incorporating any important information from the NEW TRANSCRIPT.',
    'Keep it compact and actionable for continuing the work in later turns.',
    '',
    'Include (when present):',
    '- user goals, constraints, preferences',
    '- key decisions and outcomes',
    '- important facts, links, file paths, and artifact ids',
    '- open questions / next steps',
    '',
    'Rules:',
    '- Do NOT include secrets or API keys.',
    '- Prefer bullet points.',
    '- Keep it at 5–12 bullets max.',
    '- Output ONLY the updated summary text.',
    '',
    existing ? `EXISTING SUMMARY:\n${existing}` : 'EXISTING SUMMARY:\n(none)',
    '',
    `NEW TRANSCRIPT:\n${transcript}`,
  ].join('\n');

  const llm = getLlmRuntime(params.context.constraints?.provider);
  const raw = await llm.chat(
    [{ role: 'user', content: prompt }],
    params.context,
    {
      temperature: 0.2,
      maxTokens: params.config.summaryMaxOutputTokens,
      onUsage: params.onLlmUsage,
    }
  );

  return raw.trim();
}

function applyPerMessageTrimming(
  shortTerm: Message[],
  config: AgentContextWindowConfig,
  actions: string[]
): Message[] {
  let changed = false;
  const out: Message[] = shortTerm.map((m) => {
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : '';
      if (content && content.length > config.toolMessageMaxChars) {
        changed = true;
        actions.push(`trim_tool_message(${typeof m.name === 'string' ? m.name : 'tool'})`);
        return { ...m, content: normalizeToolMessageContent(content, config.toolMessageMaxChars) };
      }
      return m;
    }

    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : '';
      if (content && content.length > config.assistantMessageMaxChars) {
        changed = true;
        actions.push('trim_assistant_message');
        return { ...m, content: clip(content, config.assistantMessageMaxChars) };
      }
      return m;
    }

    return m;
  });

  return changed ? out : shortTerm;
}

export async function ensureContextWindow(
  state: AgentState,
  context: AgentContext,
  params: EnsureContextParams
): Promise<EnsureContextResult> {
  const config = params.config ?? getAgentContextWindowConfig();
  const requestedMode: EnsureMode = params.mode ?? 'normal';

  const actions: string[] = [];

  // Always keep memory tool-protocol safe before we start trimming/dropping.
  state.memory.shortTerm = sanitizeMessagesForToolProtocol(state.memory.shortTerm);

  const beforeTokens = estimatePromptTokens({
    systemPrompt: params.systemPrompt,
    summary: state.memory.summary,
    shortTerm: state.memory.shortTerm,
    tools: params.tools,
  });
  const before = {
    estimatedTokens: beforeTokens,
    shortTermMessages: state.memory.shortTerm.length,
    summaryChars: state.memory.summary.length,
  };

  const maxInputCap =
    typeof config.maxInputTokens === 'number' && Number.isFinite(config.maxInputTokens) && config.maxInputTokens > 0
      ? config.maxInputTokens
      : Number.POSITIVE_INFINITY;

  const inputBudget = Math.max(
    1,
    Math.min(maxInputCap, config.maxContextTokens - config.maxOutputTokens) - config.safetyMarginTokens
  );

  const modeOrder: EnsureMode[] =
    requestedMode === 'aggressive' ? ['aggressive'] : ['normal', 'aggressive'];

  let changed = false;

  for (const mode of modeOrder) {
    // 1) Hard cap huge per-message payloads first (cheap win).
    const trimmed = applyPerMessageTrimming(state.memory.shortTerm, config, actions);
    if (trimmed !== state.memory.shortTerm) {
      state.memory.shortTerm = trimmed;
      changed = true;
    }

    // 2) If summary itself is massive, clip it (best-effort safety).
    // We prefer LLM-driven compaction, but this prevents catastrophic overflow.
    const MAX_SUMMARY_CHARS = 12_000;
    if (state.memory.summary.length > MAX_SUMMARY_CHARS) {
      state.memory.summary = clip(state.memory.summary, MAX_SUMMARY_CHARS);
      actions.push('clip_summary');
      changed = true;
    }

    const triggerFraction =
      mode === 'aggressive'
        ? Math.min(0.65, config.summaryTriggerFraction)
        : config.summaryTriggerFraction;

    const triggerTokens = Math.max(1, Math.floor(inputBudget * triggerFraction));

    let currentTokens = estimatePromptTokens({
      systemPrompt: params.systemPrompt,
      summary: state.memory.summary,
      shortTerm: state.memory.shortTerm,
      tools: params.tools,
    });

    if (currentTokens <= triggerTokens) {
      // Already under the proactive threshold.
      break;
    }

    // 3) Summarize + drop oldest blocks.
    const blocks = chunkMessagesForToolProtocol(state.memory.shortTerm);
    const blockTokenEstimates = blocks.map((b) => estimateTokensForMessages(b));

    const baseTokens =
      estimateTokensForMessages([{ role: 'system', content: params.systemPrompt }]) +
      (state.memory.summary.trim()
        ? estimateTokensForMessages([buildSummaryMessage(state.memory.summary)])
        : 0) +
      estimateToolDefinitionsTokens(params.tools);

    const targetTokens = Math.min(triggerTokens, inputBudget);
    const desiredShortTermBudget = Math.max(0, targetTokens - baseTokens);

    const minKeepBlocks = mode === 'aggressive' ? 3 : 6;

    const keptBlocks: Message[][] = [];
    let keptTokens = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = blockTokenEstimates[i] ?? 0;
      const mustKeep = keptBlocks.length < minKeepBlocks;
      const canFit = keptTokens + t <= desiredShortTermBudget;
      if (mustKeep || canFit) {
        keptBlocks.unshift(blocks[i]!);
        keptTokens += t;
        continue;
      }
      // Once we stop fitting, drop all earlier blocks.
      break;
    }

    const dropCount = Math.max(0, blocks.length - keptBlocks.length);
    const droppedBlocks = dropCount > 0 ? blocks.slice(0, dropCount) : [];

    if (droppedBlocks.length > 0) {
      const droppedMessages = flattenMessageBlocks(droppedBlocks);
      const transcript = formatTranscript(droppedMessages, mode === 'aggressive' ? 60_000 : 40_000);

      try {
        const nextSummary = await updateRunningSummary({
          existingSummary: state.memory.summary,
          newTranscript: transcript,
          context,
          config,
          onLlmUsage: params.onLlmUsage,
        });
        if (nextSummary) {
          state.memory.summary = nextSummary;
          actions.push(`summarize_drop_blocks(${droppedBlocks.length})`);
          changed = true;
        } else {
          actions.push('summarize_noop');
        }
      } catch {
        // Summary is best-effort; if it fails, we still drop to preserve forward progress.
        actions.push('summarize_failed');
      }

      state.memory.shortTerm = sanitizeMessagesForToolProtocol(flattenMessageBlocks(keptBlocks));
      changed = true;
    } else if (mode === 'aggressive' && blocks.length > 0) {
      // Nothing could be dropped due to minKeepBlocks; in aggressive mode, reduce the kept blocks further.
      const fallbackKeep = flattenMessageBlocks(blocks.slice(Math.max(0, blocks.length - 2)));
      if (fallbackKeep.length < state.memory.shortTerm.length) {
        state.memory.shortTerm = sanitizeMessagesForToolProtocol(fallbackKeep);
        actions.push('drop_to_last_2_blocks');
        changed = true;
      }
    }

    // Re-check tokens; if within the hard budget, stop.
    currentTokens = estimatePromptTokens({
      systemPrompt: params.systemPrompt,
      summary: state.memory.summary,
      shortTerm: state.memory.shortTerm,
      tools: params.tools,
    });

    if (currentTokens <= inputBudget) {
      break;
    }
  }

  const afterTokens = estimatePromptTokens({
    systemPrompt: params.systemPrompt,
    summary: state.memory.summary,
    shortTerm: state.memory.shortTerm,
    tools: params.tools,
  });
  const after = {
    estimatedTokens: afterTokens,
    shortTermMessages: state.memory.shortTerm.length,
    summaryChars: state.memory.summary.length,
  };

  const result: EnsureContextResult = { changed, before, after, actions };

  if (config.logContext && (changed || beforeTokens > afterTokens)) {
    console.info(
      `[ContextWindow] mode=${requestedMode} inputBudget=${inputBudget} maxInputCap=${Number.isFinite(maxInputCap) ? maxInputCap : 'none'} beforeTokens=${beforeTokens} afterTokens=${afterTokens} actions=${actions.join(',')}`
    );
  }

  return result;
}

export function buildContextUsage(
  config: AgentContextWindowConfig,
  estimateInputTokens: number
): ContextUsage {
  const maxInputTokens =
    typeof config.maxInputTokens === 'number' && Number.isFinite(config.maxInputTokens) && config.maxInputTokens > 0
      ? config.maxInputTokens
      : undefined;

  const usedFraction =
    maxInputTokens && maxInputTokens > 0
      ? Math.min(1, Math.max(0, estimateInputTokens / maxInputTokens))
      : undefined;

  return {
    inputTokens: estimateInputTokens,
    maxInputTokens,
    maxContextTokens: config.maxContextTokens,
    maxOutputTokens: config.maxOutputTokens,
    usedFraction,
  };
}