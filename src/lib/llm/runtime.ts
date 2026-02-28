import 'server-only';

import type { Message, ModelRecommendation, ProjectContext } from '@/types';
import {
  gptService,
  type FunctionCallResult,
  type FunctionDefinition,
  type LlmUsage,
  type ReasoningEffort,
  type StreamChatWithToolsEvent,
} from '@/lib/azure-openai/service';
import { bedrockService } from '@/lib/aws-bedrock/service';
import { getConfiguredLlmProvider, type LlmProviderId } from './provider';

export type LlmRuntime = {
  chat(
    messages: Message[],
    context: ProjectContext,
    options?: {
      temperature?: number;
      maxTokens?: number;
      reasoningEffort?: ReasoningEffort;
      timeoutMs?: number;
      onUsage?: (usage: LlmUsage) => void;
    }
  ): Promise<string>;
  streamChatWithTools(
    messages: Message[],
    tools: FunctionDefinition[],
    context: ProjectContext,
    options?: { temperature?: number; maxTokens?: number; reasoningEffort?: ReasoningEffort; timeoutMs?: number }
  ): AsyncGenerator<StreamChatWithToolsEvent>;
  functionCall(
    messages: Message[],
    functions: FunctionDefinition[],
    context: ProjectContext,
    options?: { onUsage?: (usage: LlmUsage) => void }
  ): Promise<FunctionCallResult>;
  recommendModel(
    requirements: { budget: { min: number; max: number }; timeline: string; accuracyPriority: string },
    context: ProjectContext
  ): Promise<ModelRecommendation>;
};

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getLlmRuntime(provider?: LlmProviderId): LlmRuntime {
  const selected = provider ?? getConfiguredLlmProvider();
  if (selected === 'aws_bedrock') return bedrockService;
  return gptService;
}

export function getMissingLlmServerEnv(provider?: LlmProviderId): string[] {
  const selected = provider ?? getConfiguredLlmProvider();
  if (selected === 'aws_bedrock') {
    return ['AWS_REGION', 'AWS_BEDROCK_MODEL_ID'].filter((name) => {
      const raw = process.env[name];
      return !raw || !raw.trim();
    });
  }
  return ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT_NAME'].filter((name) => {
    const raw = process.env[name];
    return !raw || !raw.trim();
  });
}

export function hasInvalidLlmServerEnv(provider?: LlmProviderId): boolean {
  const selected = provider ?? getConfiguredLlmProvider();
  if (selected === 'aws_bedrock') return false;
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').trim();
  if (!endpoint) return false;
  return !isValidHttpUrl(endpoint);
}
