import 'server-only';

import { randomUUID } from 'crypto';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type Message as BedrockMessage,
  type SystemContentBlock,
  type Tool,
  type ToolResultContentBlock,
  type TokenUsage,
} from '@aws-sdk/client-bedrock-runtime';

import type { Message, ModelRecommendation, ProjectContext } from '@/types';
import type {
  FunctionCallResult,
  FunctionDefinition,
  LlmUsage,
  ReasoningEffort,
  StreamChatWithToolsEvent,
} from '@/lib/azure-openai/service';
import { gptService } from '@/lib/azure-openai/service';

type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  onUsage?: (usage: LlmUsage) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeToolInput(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = parseJson(raw);
    if (isRecord(parsed)) return parsed;
    if (parsed === null || parsed === undefined) return {};
    return { value: parsed };
  }
  if (raw === null || raw === undefined) return {};
  return { value: raw as unknown };
}

function toSafeToolName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || `tool_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeUsage(usage: TokenUsage | undefined, modelId: string): LlmUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;
  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined;
  const cacheRead = typeof usage.cacheReadInputTokens === 'number' ? usage.cacheReadInputTokens : undefined;
  const hasAny =
    typeof inputTokens === 'number' ||
    typeof outputTokens === 'number' ||
    typeof totalTokens === 'number' ||
    typeof cacheRead === 'number';
  if (!hasAny) return undefined;

  return {
    provider: 'aws_bedrock',
    model: modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: cacheRead,
    raw: usage,
  };
}

function withTimeout<T>(
  timeoutMs: number | undefined,
  run: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return run(undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.floor(timeoutMs));
  return run(controller.signal).finally(() => clearTimeout(timer));
}

type ToolMappings = {
  safeToOriginal: Map<string, string>;
  originalToSafe: Map<string, string>;
};

function buildToolConfig(functions: FunctionDefinition[]): { tools: Tool[]; mappings: ToolMappings } {
  const safeToOriginal = new Map<string, string>();
  const originalToSafe = new Map<string, string>();
  const tools: Tool[] = [];

  for (const fn of [...functions].sort((a, b) => a.name.localeCompare(b.name))) {
    const original = fn.name.trim();
    if (!original) continue;
    const baseSafe = toSafeToolName(original);
    let safe = baseSafe;
    let suffix = 2;
    while (safeToOriginal.has(safe) && safeToOriginal.get(safe) !== original) {
      safe = `${baseSafe}_${suffix++}`.slice(0, 64);
    }
    safeToOriginal.set(safe, original);
    originalToSafe.set(original, safe);
    tools.push({
      toolSpec: {
        name: safe,
        description: fn.description,
        inputSchema: {
          json: (isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }) as unknown as never,
        },
      },
    });
  }

  return {
    tools,
    mappings: { safeToOriginal, originalToSafe },
  };
}

function toToolResultContent(raw: string): { content: ToolResultContentBlock[]; status?: 'success' | 'error' } {
  const parsed = parseJson(raw);
  if (parsed !== null) {
    const status =
      isRecord(parsed) && parsed.ok === false
        ? 'error'
        : 'success';
    return {
      content: [{ json: parsed as unknown as never }],
      status,
    };
  }
  return {
    content: [{ text: raw }],
    status: undefined,
  };
}

function buildConversation(
  messages: Message[],
  mappings?: ToolMappings
): { system?: SystemContentBlock[]; conversation: BedrockMessage[] } {
  const systemLines: string[] = [];
  const conversation: BedrockMessage[] = [];
  // Bedrock tool protocol expects toolResult blocks for a prior assistant tool_use
  // turn to be supplied together in the next user message content.
  let pendingToolResults: NonNullable<BedrockMessage['content']> = [];

  const mapToolName = (name: string): string => {
    if (!mappings) return toSafeToolName(name);
    return mappings.originalToSafe.get(name) ?? toSafeToolName(name);
  };

  const dropDanglingAssistantToolUse = () => {
    const last = conversation[conversation.length - 1];
    if (!last || last.role !== 'assistant') return;
    const current = Array.isArray(last.content) ? last.content : [];
    const remaining = current.filter(block => !('toolUse' in block));
    if (remaining.length === current.length) return;
    if (remaining.length === 0) {
      conversation.pop();
      return;
    }
    conversation[conversation.length - 1] = {
      ...last,
      content: remaining,
    };
  };

  const flushPendingToolResults = (mode: 'emit' | 'drop') => {
    if (pendingToolResults.length === 0) return;
    if (mode === 'emit') {
      conversation.push({
        role: 'user',
        content: pendingToolResults,
      });
    } else {
      // If tool results are interrupted by a non-assistant turn, remove the
      // dangling assistant tool_use blocks from the tail so Bedrock history
      // stays replayable.
      dropDanglingAssistantToolUse();
    }
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === 'system') {
      const text = asNonEmptyString(message.content);
      if (text) systemLines.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const toolUseId = asNonEmptyString(message.tool_call_id) ?? randomUUID();
      const rawContent = typeof message.content === 'string' ? message.content : '';
      const result = toToolResultContent(rawContent);
      pendingToolResults.push({
        toolResult: {
          toolUseId,
          content: result.content,
          status: result.status,
        },
      });
      continue;
    }

    const content: BedrockMessage['content'] = [];
    const text = asNonEmptyString(message.content);
    if (text) content.push({ text });

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        if (!isRecord(rawToolCall)) continue;
        const toolCallId = asNonEmptyString(rawToolCall.id) ?? randomUUID();
        const fn = isRecord(rawToolCall.function) ? rawToolCall.function : null;
        const fnName = asNonEmptyString(fn?.name);
        if (!fnName) continue;
        const fnArgsRaw = fn?.arguments;
        const input = normalizeToolInput(fnArgsRaw);
        content.push({
          toolUse: {
            toolUseId: toolCallId,
            name: mapToolName(fnName),
            input: input as unknown as never,
          },
        });
      }
    }

    if (content.length === 0) {
      // Empty assistant/user messages can appear in persisted history.
      // If they occur after pending tool results, treat as interruption.
      if (pendingToolResults.length > 0) {
        flushPendingToolResults('drop');
      }
      continue;
    }

    if (pendingToolResults.length > 0) {
      // Bedrock requires tool results to be followed by assistant continuation.
      // If user intervenes before that, drop the incomplete exchange.
      flushPendingToolResults(message.role === 'assistant' ? 'emit' : 'drop');
    }

    conversation.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  // Flush tool results at end of history as well.
  flushPendingToolResults('emit');

  const enforceBedrockToolOrder = (raw: BedrockMessage[]): BedrockMessage[] => {
    const out: BedrockMessage[] = [];

    const hasToolResult = (m: BedrockMessage): boolean =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some(block => 'toolResult' in block);

    const stripAssistantToolUseTail = () => {
      const tail = out[out.length - 1];
      if (!tail || tail.role !== 'assistant' || !Array.isArray(tail.content)) return;
      const remaining = tail.content.filter(block => !('toolUse' in block));
      if (remaining.length === tail.content.length) return;
      if (remaining.length === 0) {
        out.pop();
        return;
      }
      out[out.length - 1] = { ...tail, content: remaining };
    };

    for (const current of raw) {
      const prev = out[out.length - 1];
      if (prev && hasToolResult(prev) && current.role !== 'assistant') {
        // Drop dangling tool_result turn and its paired assistant tool_use tail.
        out.pop();
        stripAssistantToolUseTail();
      }
      out.push(current);
    }
    return out;
  };

  const system = systemLines.length > 0
    ? [{ text: systemLines.join('\n\n') }]
    : undefined;

  return { system, conversation: enforceBedrockToolOrder(conversation) };
}

function extractTextFromResponseContent(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return '';
  const textParts: string[] = [];
  for (const block of content) {
    if (!('text' in block)) continue;
    const text = asNonEmptyString((block as { text?: unknown }).text);
    if (text) textParts.push(text);
  }
  return textParts.join('');
}

function asErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  const raw = String(err ?? '').trim();
  return raw || fallback;
}

export class BedrockLlmService {
  private client: BedrockRuntimeClient | null = null;

  private getRegion(): string {
    return (process.env.AWS_REGION || '').trim() || 'us-east-1';
  }

  private getModelId(): string {
    const modelId = (process.env.AWS_BEDROCK_MODEL_ID || '').trim();
    if (!modelId) {
      throw new Error('Missing AWS_BEDROCK_MODEL_ID for Bedrock runtime.');
    }
    return modelId;
  }

  private resolveLoginCacheCredentials(): {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration?: Date;
  } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      const cacheDir = path.join(
        process.env.HOME || process.env.USERPROFILE || '/root',
        '.aws', 'login', 'cache'
      );
      if (!fs.existsSync(cacheDir)) return null;
      const files = fs.readdirSync(cacheDir).filter((f: string) => f.endsWith('.json'));
      let best: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: Date } | null = null;
      let bestExpiry = 0;
      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf-8'));
          const token = raw?.accessToken ?? raw;
          if (typeof token?.accessKeyId !== 'string') continue;
          if (typeof token?.secretAccessKey !== 'string') continue;
          if (typeof token?.sessionToken !== 'string') continue;
          const expiry = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
          if (expiry > bestExpiry) {
            bestExpiry = expiry;
            best = {
              accessKeyId: token.accessKeyId,
              secretAccessKey: token.secretAccessKey,
              sessionToken: token.sessionToken,
              expiration: expiry ? new Date(expiry) : undefined,
            };
          }
        } catch { /* skip malformed cache entries */ }
      }
      if (best && bestExpiry > Date.now()) return best;
      return null;
    } catch {
      return null;
    }
  }

  private getClient(): BedrockRuntimeClient {
    if (!this.client) {
      const clientOpts: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
        region: this.getRegion(),
      };
      const hasStaticKeys =
        (process.env.AWS_ACCESS_KEY_ID || '').trim() &&
        (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
      if (hasStaticKeys) {
        clientOpts.credentials = {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!.trim(),
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!.trim(),
          ...(process.env.AWS_SESSION_TOKEN?.trim()
            ? { sessionToken: process.env.AWS_SESSION_TOKEN.trim() }
            : {}),
        };
      } else {
        const loginCreds = this.resolveLoginCacheCredentials();
        if (loginCreds) {
          clientOpts.credentials = loginCreds;
        }
      }
      this.client = new BedrockRuntimeClient(clientOpts);
    }
    return this.client;
  }

  /** Discard the cached client so the next call creates a fresh one
   *  (picks up rotated/refreshed credentials from the environment). */
  resetClient(): void {
    this.client = null;
  }

  private isExpiredTokenError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('expired') && (lower.includes('token') || lower.includes('credential'))) return true;
    if (lower.includes('could not load credentials')) return true;
    return false;
  }

  /** Wrap a Bedrock SDK call: on expired-token errors, reset the client
   *  and retry once with a fresh credential chain. */
  private async withCredentialRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (this.isExpiredTokenError(err)) {
        this.resetClient();
        try {
          return await fn();
        } catch (retryErr) {
          if (this.isExpiredTokenError(retryErr)) {
            throw new Error(
              'AWS credentials are missing or expired. ' +
              'Please refresh your session (e.g. run `aws login` or ' +
              '`aws configure export-credentials --format env-no-export`) ' +
              'and restart the application.'
            );
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  async chat(
    messages: Message[],
    context: ProjectContext,
    options?: ChatOptions
  ): Promise<string> {
    const modelId = this.getModelId();
    const { system, conversation } = buildConversation(messages);
    const response = await this.withCredentialRetry(() =>
      withTimeout(options?.timeoutMs, (signal) =>
        this.getClient().send(
          new ConverseCommand({
            modelId,
            system,
            messages: conversation,
            inferenceConfig: {
              maxTokens: options?.maxTokens ?? 4096,
              temperature: options?.temperature ?? 0.2,
            },
          }),
          { abortSignal: signal }
        )
      )
    );

    const usage = normalizeUsage(response.usage, modelId);
    if (usage) options?.onUsage?.(usage);
    const outputMessage = response.output?.message;
    return extractTextFromResponseContent(outputMessage?.content);
  }

  async functionCall(
    messages: Message[],
    functions: FunctionDefinition[],
    context: ProjectContext,
    options?: { onUsage?: (usage: LlmUsage) => void }
  ): Promise<FunctionCallResult> {
    const modelId = this.getModelId();
    const { tools, mappings } = buildToolConfig(functions);
    if (tools.length === 0) throw new Error('functionCall requires at least one function.');

    const { system, conversation } = buildConversation(messages, mappings);
    const toolChoice =
      tools.length === 1
        ? { tool: { name: tools[0]?.toolSpec?.name || '' } }
        : undefined;

    const response = await this.withCredentialRetry(() =>
      this.getClient().send(
        new ConverseCommand({
          modelId,
          system,
          messages: conversation,
          toolConfig: {
            tools,
            toolChoice,
          },
          inferenceConfig: {
            maxTokens: 4096,
            temperature: 0.2,
          },
        })
      )
    );

    const usage = normalizeUsage(response.usage, modelId);
    if (usage) options?.onUsage?.(usage);

    const outputMessage = response.output?.message;
    const content = outputMessage?.content ?? [];
    for (const block of content) {
      if (!('toolUse' in block) || !isRecord(block.toolUse)) continue;
      const toolUse = block.toolUse;
      const safeName = asNonEmptyString(toolUse.name);
      const name = safeName ? (mappings.safeToOriginal.get(safeName) ?? safeName) : null;
      if (!name) continue;
      const input = normalizeToolInput(toolUse.input);
      return { name, arguments: input };
    }

    throw new Error('No tool/function call in Bedrock response.');
  }

  async *streamChatWithTools(
    messages: Message[],
    tools: FunctionDefinition[],
    context: ProjectContext,
    options?: { temperature?: number; maxTokens?: number; reasoningEffort?: ReasoningEffort; timeoutMs?: number }
  ): AsyncGenerator<StreamChatWithToolsEvent> {
    const modelId = this.getModelId();
    const { tools: bedrockTools, mappings } = buildToolConfig(tools);
    const { system, conversation } = buildConversation(messages, mappings);

    const response = await this.withCredentialRetry(() =>
      withTimeout(options?.timeoutMs, (signal) =>
        this.getClient().send(
          new ConverseStreamCommand({
            modelId,
            system,
            messages: conversation,
            toolConfig:
              bedrockTools.length > 0
                ? {
                    tools: bedrockTools,
                  }
                : undefined,
            inferenceConfig: {
              maxTokens: options?.maxTokens ?? 4096,
              temperature: options?.temperature ?? 0.2,
            },
          }),
          { abortSignal: signal }
        )
      )
    );

    const stream = response.stream;
    if (!stream) {
      throw new Error('Bedrock streaming response did not include a stream.');
    }

    let usageEmitted = false;
    for await (const event of stream) {
      if (event.internalServerException) {
        throw new Error(asErrorMessage(event.internalServerException, 'Bedrock internal server error.'));
      }
      if (event.modelStreamErrorException) {
        throw new Error(asErrorMessage(event.modelStreamErrorException, 'Bedrock model stream error.'));
      }
      if (event.validationException) {
        throw new Error(asErrorMessage(event.validationException, 'Bedrock validation error.'));
      }
      if (event.throttlingException) {
        throw new Error(asErrorMessage(event.throttlingException, 'Bedrock throttling error.'));
      }
      if (event.serviceUnavailableException) {
        throw new Error(asErrorMessage(event.serviceUnavailableException, 'Bedrock service unavailable.'));
      }

      if (event.contentBlockStart?.start?.toolUse) {
        const start = event.contentBlockStart.start.toolUse;
        const safeName = asNonEmptyString(start.name);
        const name = safeName ? (mappings.safeToOriginal.get(safeName) ?? safeName) : '';
        const toolUseId = asNonEmptyString(start.toolUseId) ?? randomUUID();
        yield {
          toolCalls: [
            {
              index: event.contentBlockStart.contentBlockIndex ?? 0,
              id: toolUseId,
              type: 'function',
              function: {
                name,
                arguments: '',
              },
            },
          ],
        };
      }

      if (event.contentBlockDelta?.delta?.text) {
        yield { content: event.contentBlockDelta.delta.text };
      }

      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        yield {
          toolCalls: [
            {
              index: event.contentBlockDelta.contentBlockIndex ?? 0,
              type: 'function',
              function: {
                arguments: event.contentBlockDelta.delta.toolUse.input,
              },
            },
          ],
        };
      }

      if (event.messageStop?.stopReason) {
        yield { finishReason: String(event.messageStop.stopReason) };
      }

      if (event.metadata?.usage && !usageEmitted) {
        const usage = normalizeUsage(event.metadata.usage, modelId);
        if (usage) {
          usageEmitted = true;
          yield { usage };
        }
      }
    }
  }

  // Keep model recommendation behavior stable while Bedrock runtime is rolled out.
  async recommendModel(
    requirements: { budget: { min: number; max: number }; timeline: string; accuracyPriority: string; preferredFamily?: string },
    context: ProjectContext
  ): Promise<ModelRecommendation> {
    return gptService.recommendModel(requirements, context);
  }
}

export const bedrockService = new BedrockLlmService();
