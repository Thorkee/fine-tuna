export const TRACE_PROMOTE_ON_DONE_HEADER = "x-tuna-trace-promote-on-done";

export type TraceRoutingPolicy = {
  promoteTraceOnDoneWhenAnswerEmpty: boolean;
  injectStrictDirective: boolean;
};

type TraceRoutingProvider = "aws_bedrock" | "azure_openai" | "openai" | string | null | undefined;

function normalizeProvider(provider: TraceRoutingProvider): string {
  if (typeof provider !== "string") return "";
  return provider.trim().toLowerCase();
}

function normalizeModelId(modelId: string | null | undefined): string {
  if (typeof modelId !== "string") return "";
  return modelId.trim().toLowerCase();
}

export function resolveTraceRoutingPolicy(args: {
  provider: TraceRoutingProvider;
  modelId?: string | null | undefined;
}): TraceRoutingPolicy {
  const provider = normalizeProvider(args.provider);
  const modelId = normalizeModelId(args.modelId);
  const isBedrockMistral = provider === "aws_bedrock" && modelId.includes("mistral");

  return {
    promoteTraceOnDoneWhenAnswerEmpty: true,
    injectStrictDirective: isBedrockMistral,
  };
}
