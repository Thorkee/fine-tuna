import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { AgentCoordinator } from "@/lib/agent/coordinator";
import { createClient } from "@/lib/supabase/server";
import { ProjectContext, type ProjectMode } from "@/types";
import type { ReasoningEffort } from "@/lib/agent/types";
import { buildMessageRow } from "@/lib/agent/message-row";
import { createStreamParser, type StreamMessageLike } from "@/lib/agent/stream-parser";
import type { LlmUsage } from "@/lib/azure-openai/service";
import { aggregateUsage, calculateCredits, type BillingRate } from "@/lib/billing/credits";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendQueuedTaskStartedEmail } from "@/lib/notifications/email";
import { buildSourcePolicySettings } from "@/lib/agent/source-policy";
import { getMcpServerConfigs } from "@/lib/mcp/config";
import { getDefaultMcpEnabledServers } from "@/lib/mcp/defaults";
import { applyFirecrawlTokenToMcpServers } from "@/lib/mcp/firecrawl";
import { listUserMcpServers } from "@/lib/mcp/user-servers";
import type { McpRuntimeServerConfig } from "@/lib/mcp/runtime";
import { parseProfileContext, resolvePreferredMode } from "@/lib/profile/profile-context";
import { getConfiguredLlmProvider } from "@/lib/llm/provider";
import { getMissingLlmServerEnv, hasInvalidLlmServerEnv } from "@/lib/llm/runtime";
import { resolveTraceRoutingPolicy, TRACE_PROMOTE_ON_DONE_HEADER } from "@/lib/llm/trace-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamErrorCode =
  | "CONFIGURATION_ERROR"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "STREAM_ERROR"
  | "INSUFFICIENT_CREDITS";

type StreamErrorPayload = {
  code: StreamErrorCode;
  message: string;
};

type StreamBillingSummary = {
  totalCredits: number;
  breakdown: ReturnType<typeof calculateCredits>["breakdown"];
  missingRates: ReturnType<typeof calculateCredits>["missingRates"];
  usage: ReturnType<typeof aggregateUsage>;
  budgetExceeded?: boolean;
  budgetCredits?: number;
  chargeCredits?: number;
  requestedChargeCredits?: number;
  insufficientCredits?: boolean;
};

function parsePositiveIntEnv(...varNames: string[]): number | undefined {
  for (const varName of varNames) {
    const raw = process.env[varName];
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n;
  }
  return undefined;
}

function normalizeServerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readMcpExplicitFlag(rawMcp: Record<string, unknown> | null): boolean {
  if (!rawMcp) return false;
  return rawMcp.explicit === true;
}

function readMcpEnabledServers(
  prefs: Record<string, unknown>,
  availableServerIds?: string[]
): { enabledServers: string[]; hasExplicitConfig: boolean } {
  const rawMcp = typeof prefs.mcp === "object" && prefs.mcp !== null
    ? (prefs.mcp as Record<string, unknown>)
    : null;
  const hasAvailableList = Array.isArray(availableServerIds);
  const available = new Set(normalizeServerIds(availableServerIds));
  const explicit = readMcpExplicitFlag(rawMcp);
  const hasExplicitConfig = explicit;
  const enabled = explicit
    ? normalizeServerIds(rawMcp?.enabled_servers)
    : getDefaultMcpEnabledServers(availableServerIds);
  const filtered = hasAvailableList ? enabled.filter((id) => available.has(id)) : enabled;
  return { enabledServers: filtered, hasExplicitConfig };
}

const REQUIRED_BASE_SERVER_ENV: Array<{ name: string; value?: string }> = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", value: process.env.NEXT_PUBLIC_SUPABASE_URL },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
];

function getMissingServerEnv(provider: ReturnType<typeof getConfiguredLlmProvider>): string[] {
  const missingBase = REQUIRED_BASE_SERVER_ENV
    .filter((entry) => !entry.value || !entry.value.trim())
    .map((entry) => entry.name);
  const missingLlm = getMissingLlmServerEnv(provider);
  return [...missingBase, ...missingLlm];
}

function hasInvalidProviderEnv(provider: ReturnType<typeof getConfiguredLlmProvider>): boolean {
  return hasInvalidLlmServerEnv(provider);
}

function buildConfigErrorPayload(): StreamErrorPayload {
  return {
    code: "CONFIGURATION_ERROR",
    message:
      "Service is unavailable due to a server configuration issue. If you're the admin, verify server environment variables.",
  };
}

function buildInsufficientCreditsPayload(): StreamErrorPayload {
  return {
    code: "INSUFFICIENT_CREDITS",
    message:
      "You are out of credits. Please purchase more credits or upgrade your plan to continue.",
  };
}

function parseCreditBalance(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function parseCreditSummaryTotal(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const total = parseCreditBalance(record.total_credits);
  if (typeof total === "number") return total;
  const base = parseCreditBalance(record.credits_balance);
  const daily = parseCreditBalance(record.daily_credits_balance);
  if (typeof base === "number" && typeof daily === "number") return base + daily;
  return null;
}

function buildSafeErrorPayload(error: unknown): StreamErrorPayload {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const lower = raw.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      code: "UPSTREAM_TIMEOUT",
      message: "The AI service timed out. Please retry in a moment.",
    };
  }

  if (lower.includes("openai") || lower.includes("azure") || lower.includes("bedrock") || lower.includes("aws")) {
    return {
      code: "UPSTREAM_ERROR",
      message: "The AI service is unavailable. Please retry shortly.",
    };
  }

  if (lower.includes("supabase") || lower.includes("invalid url")) {
    return buildConfigErrorPayload();
  }

  return {
    code: "STREAM_ERROR",
    message: "Unexpected server error. Please retry.",
  };
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const configuredProvider = getConfiguredLlmProvider();
  const traceRoutingPolicy = resolveTraceRoutingPolicy({
    provider: configuredProvider,
    modelId: process.env.AWS_BEDROCK_MODEL_ID,
  });
  const payload = await req.json().catch(() => ({}));
  const message = typeof payload.message === "string" ? payload.message : "";
  const history = Array.isArray(payload.history) ? payload.history : [];
  const filesRaw = payload.files;
  const chatId = typeof payload.chatId === "string" ? payload.chatId : undefined;
      const assistantMessageIdRaw =
        typeof payload.assistantMessageId === "string" ? payload.assistantMessageId : "";
      const assistantMessageCreatedAtRaw =
        typeof payload.assistantMessageCreatedAt === "string"
          ? payload.assistantMessageCreatedAt
          : undefined;
  const reasoningEffortRaw =
    typeof payload.reasoningEffort === "string" ? payload.reasoningEffort : undefined;
  const reasoningEffort: ReasoningEffort | undefined =
    reasoningEffortRaw === "none" ||
    reasoningEffortRaw === "minimal" ||
    reasoningEffortRaw === "low" ||
    reasoningEffortRaw === "medium" ||
    reasoningEffortRaw === "high" ||
    reasoningEffortRaw === "xhigh"
      ? (reasoningEffortRaw as ReasoningEffort)
      : undefined;

  const inputFiles = Array.isArray(filesRaw)
    ? filesRaw
        .filter((f: unknown) => f && typeof f === "object")
        .map((f: Record<string, unknown>) => ({
          id: typeof f.id === "string" ? f.id : randomUUID(),
          name: typeof f.name === "string" ? f.name : "file",
          size: typeof f.size === "number" ? f.size : 0,
          mimeType: typeof f.mimeType === "string" ? f.mimeType : undefined,
          storagePath: typeof f.storagePath === "string" ? f.storagePath : undefined,
        }))
    : [];

  let clientDisconnected = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          clientDisconnected = true;
        }
      };

      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const startHeartbeat = () => {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
          send("ping", { at: new Date().toISOString() });
        }, 15000);
      };
      const stopHeartbeat = () => {
        if (!heartbeatTimer) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };

      let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
      let runId: string | null = null;
      const llmUsages: LlmUsage[] = [];
      let startingCredits: number | null = null;
      let authedUserId: string | null = null;
      const chatIdValue = typeof chatId === "string" && chatId.trim() ? chatId.trim() : "";
      let billingFinalized = false;
      let billingSummary: StreamBillingSummary | null = null;

      const finalizeBilling = async (opts: {
        sendUsageEvent?: boolean;
        outcome: "done" | "failed";
      }) => {
        if (billingFinalized) return;
        if (llmUsages.length === 0) return;
        billingFinalized = true;

        try {
          const usage = aggregateUsage(llmUsages);
          const providers = Array.from(new Set(usage.map((u) => u.provider)));
          const models = Array.from(new Set(usage.map((u) => u.model)));
          let rates: BillingRate[] = [];

          if (providers.length > 0 && models.length > 0) {
            const admin = createAdminClient();
            let query = admin
              .from("billing_rates")
              .select(
                "provider, model, credits_per_1m_input_tokens, credits_per_1m_output_tokens, credits_per_1m_cached_input_tokens"
              )
              .eq("active", true);

            query =
              providers.length === 1
                ? query.eq("provider", providers[0])
                : query.in("provider", providers);
            query =
              models.length === 1 ? query.eq("model", models[0]) : query.in("model", models);

            const { data, error } = await query;
            if (error) throw error;
            rates = (data ?? []) as BillingRate[];
          }

          const calculated = calculateCredits(usage, rates);
          const maxRunCredits = parsePositiveIntEnv("TUNA_MAX_CREDITS_PER_RUN");
          const effectiveBudget =
            typeof maxRunCredits === "number"
              ? Math.min(maxRunCredits, startingCredits ?? maxRunCredits)
              : null;
          const requestedChargeCredits =
            effectiveBudget !== null
              ? Math.min(calculated.totalCredits, effectiveBudget)
              : calculated.totalCredits;
          let chargeCredits = requestedChargeCredits;
          let insufficientCredits = false;
          if (typeof startingCredits === "number" && startingCredits >= 0) {
            if (chargeCredits > startingCredits) {
              chargeCredits = startingCredits;
              insufficientCredits = true;
            }
          }

          billingSummary = {
            totalCredits: calculated.totalCredits,
            breakdown: calculated.breakdown,
            missingRates: calculated.missingRates,
            usage,
            budgetExceeded:
              typeof effectiveBudget === "number" &&
              calculated.totalCredits > effectiveBudget,
            budgetCredits: effectiveBudget ?? undefined,
            chargeCredits,
            requestedChargeCredits,
            insufficientCredits,
          };

          if (
            authedUserId &&
            typeof chargeCredits === "number" &&
            chargeCredits > 0 &&
            supabase
          ) {
            const totalInput = usage.reduce((sum, u) => sum + u.inputTokens, 0);
            const totalOutput = usage.reduce((sum, u) => sum + u.outputTokens, 0);
            const totalCached = usage.reduce((sum, u) => sum + u.cachedTokens, 0);
            const provider = usage.length === 1 ? usage[0].provider : "multi";
            const model = usage.length === 1 ? usage[0].model : "multi";

            const { error: chargeErr } = await supabase.rpc("consume_credits", {
              p_run_id: runId,
              p_amount: chargeCredits,
              p_metadata: {
                source: "llm",
                chat_id: chatIdValue || null,
                provider,
                model,
                input_tokens: totalInput,
                output_tokens: totalOutput,
                cached_tokens: totalCached,
                usage,
                breakdown: calculated.breakdown,
                missing_rates: calculated.missingRates,
                budget_exceeded:
                  typeof effectiveBudget === "number" &&
                  calculated.totalCredits > effectiveBudget,
                budget_credits: effectiveBudget ?? null,
                total_credits: calculated.totalCredits,
                charged_credits: chargeCredits,
                requested_charge_credits: requestedChargeCredits,
                unbilled_credits: Math.max(0, calculated.totalCredits - chargeCredits),
                insufficient_credits: insufficientCredits,
                starting_credits: startingCredits,
                run_outcome: opts.outcome,
                client_disconnected: clientDisconnected,
              },
            });

            if (chargeErr) {
              const msg = chargeErr.message || "";
              // Best-effort fallback: if balance changed since we computed startingCredits,
              // try charging whatever is currently available so the user is still drained.
              if (msg.toLowerCase().includes("insufficient_credits")) {
                try {
                  const { data: summary, error: summaryErr } = await supabase.rpc("get_credit_summary");
                  if (!summaryErr) {
                    const availableNow = parseCreditSummaryTotal(summary);
                    const retryAmount =
                      typeof availableNow === "number" && availableNow > 0
                        ? Math.min(chargeCredits, availableNow)
                        : 0;
                    if (retryAmount > 0 && retryAmount !== chargeCredits) {
                      const { error: retryErr } = await supabase.rpc("consume_credits", {
                        p_run_id: runId,
                        p_amount: retryAmount,
                        p_metadata: {
                          source: "llm",
                          chat_id: chatIdValue || null,
                          provider,
                          model,
                          input_tokens: totalInput,
                          output_tokens: totalOutput,
                          cached_tokens: totalCached,
                          usage,
                          breakdown: calculated.breakdown,
                          missing_rates: calculated.missingRates,
                          budget_exceeded:
                            typeof effectiveBudget === "number" &&
                            calculated.totalCredits > effectiveBudget,
                          budget_credits: effectiveBudget ?? null,
                          total_credits: calculated.totalCredits,
                          charged_credits: retryAmount,
                          requested_charge_credits: requestedChargeCredits,
                          unbilled_credits: Math.max(0, calculated.totalCredits - retryAmount),
                          insufficient_credits: true,
                          starting_credits: startingCredits,
                          retry_after_insufficient: true,
                          run_outcome: opts.outcome,
                          client_disconnected: clientDisconnected,
                        },
                      });
                      if (!retryErr) {
                        billingSummary.chargeCredits = retryAmount;
                        billingSummary.insufficientCredits = true;
                      } else {
                        console.error("Failed to charge credits (retry):", retryErr.message);
                      }
                    }
                  }
                } catch {
                  // Best-effort only.
                }
              } else {
                console.error("Failed to charge credits:", msg);
              }
            }
          }

          if (opts.sendUsageEvent) {
            send("usage", billingSummary);
          }
        } catch (error) {
          console.error("Failed to compute billing summary:", error);
        }
      };

      try {
        startHeartbeat();
        const provider = configuredProvider;
        const missingEnv = getMissingServerEnv(provider);
        const invalidProviderEnv = hasInvalidProviderEnv(provider);
        if (missingEnv.length > 0 || invalidProviderEnv) {
          if (missingEnv.length > 0) {
            console.error("Missing server environment variables:", missingEnv.join(", "));
          }
          if (invalidProviderEnv) {
            console.error(`Invalid provider configuration for ${provider}.`);
          }
          send("error", buildConfigErrorPayload());
          if (!clientDisconnected) {
            controller.close();
          }
          return;
        }

        supabase = await createClient();
        if (!supabase) throw new Error("Supabase client unavailable");
        const supabaseClient = supabase;
        const authedUser = (await supabaseClient.auth.getUser()).data.user;
        authedUserId = authedUser?.id ?? null;
        const authedUserEmail = authedUser?.email ?? null;
        let userProfile: ProjectContext["userProfile"] | undefined;
        let preferredMode: ProjectMode | null = null;
        let skillPreferences: ProjectContext["skillPreferences"] | undefined;
        let mcpEnabledServers: string[] | undefined;
        let mcpServers: McpRuntimeServerConfig[] | undefined;
        let userPrefs: Record<string, unknown> | null = null;
        let commQueuedTasks = false;
        let queuedTaskStartEmailLastSentAt: string | null = null;
        if (authedUserId) {
          const { data: summary, error: summaryErr } = await supabaseClient.rpc(
            "get_credit_summary"
          );
          if (summaryErr) {
            console.error("Failed to load credit summary:", summaryErr.message);
          } else {
            startingCredits = parseCreditSummaryTotal(summary);
          }

          const minCreditsToStart = parsePositiveIntEnv("TUNA_MIN_CREDITS_TO_START") ?? 1;
          if (typeof startingCredits === "number" && startingCredits < minCreditsToStart) {
            send("error", buildInsufficientCreditsPayload());
            if (!clientDisconnected) {
              controller.close();
            }
            return;
          }
        }
        if (authedUserId) {
          const { data: profile, error: profileErr } = await supabaseClient
            .from("profiles")
            .select("full_name, preferences")
            .eq("id", authedUserId)
            .maybeSingle();
          if (profileErr) {
            console.error("Failed to load user profile:", profileErr.message);
          } else if (profile) {
            const parsed = parseProfileContext(profile);
            userPrefs = parsed.prefs;
            preferredMode = parsed.preferredMode;
            skillPreferences = parsed.skillPreferences;
            userProfile = parsed.userProfile;
            if (typeof parsed.comm.queuedTaskStart === "boolean") {
              commQueuedTasks = parsed.comm.queuedTaskStart;
            }
            queuedTaskStartEmailLastSentAt = parsed.comm.queuedTaskStartLastSentAt ?? null;
          }
        }
        if (authedUserId) {
          try {
            const envConfigs = await applyFirecrawlTokenToMcpServers(getMcpServerConfigs(), authedUserId);
            const envServers = envConfigs.map((server) => ({
              ...server,
              origin: "env" as const,
            }));
            const userRows = await listUserMcpServers(authedUserId);
            const userServers = userRows.map((row) => ({
              id: row.id,
              label: row.label,
              transport: "http" as const,
              url: row.url,
              headers: row.headers ?? {},
              origin: "user" as const,
              userServerId: row.id,
            }));
            const combined = [...envServers, ...userServers];
            const availableIds = combined.map((server) => server.id);
            const resolvedPrefs = userPrefs ?? {};
            const mcpPref = readMcpEnabledServers(resolvedPrefs, availableIds);
            mcpEnabledServers = mcpPref.enabledServers;
            const enabledSet = new Set(mcpEnabledServers ?? []);
            const filtered = enabledSet.size > 0
              ? combined.filter((server) => enabledSet.has(server.id))
              : [];
            if (filtered.length > 0) {
              mcpServers = filtered;
            } else {
              mcpServers = undefined;
            }
          } catch (error) {
            console.error("Failed to load MCP servers:", error);
          }
        }
        const assistantMessageId = assistantMessageIdRaw.trim() || randomUUID();
        const assistantMessageCreatedAt =
          typeof assistantMessageCreatedAtRaw === "string" && assistantMessageCreatedAtRaw.trim()
            ? assistantMessageCreatedAtRaw.trim()
            : new Date().toISOString();

        let chatTitleForEmail: string | null = null;
        if (authedUserId && chatIdValue) {
          const { data: chatRow, error: chatErr } = await supabaseClient
            .from("chats")
            .select("id, title")
            .eq("id", chatIdValue)
            .eq("user_id", authedUserId)
            .maybeSingle();

          if (chatErr) {
            console.error("Failed to verify chat before saving state:", chatErr.message);
          } else if (!chatRow) {
            const { error: insertErr } = await supabaseClient
              .from("chats")
              .insert([{ id: chatIdValue, user_id: authedUserId, title: "New chat" }]);
            if (insertErr) {
              console.error("Failed to create chat for agent state:", insertErr.message);
            } else {
              chatTitleForEmail = "New chat";
            }
          } else {
            chatTitleForEmail = typeof chatRow.title === "string" ? chatRow.title : null;
          }
        }

        if (authedUserId && chatIdValue) {
          runId = randomUUID();
          const { error: runErr } = await supabaseClient
            .from("agent_runs")
            .insert([{ id: runId, chat_id: chatIdValue, status: "running" }]);
          if (runErr) {
            console.error("Failed to create agent run:", runErr.message);
            runId = null;
          } else if (authedUserEmail && commQueuedTasks) {
            const cooldownMinutes =
              parsePositiveIntEnv("TUNA_QUEUED_TASK_START_EMAIL_COOLDOWN_MINUTES") ?? 60;
            const cooldownMs = cooldownMinutes * 60_000;
            const lastSentMs = queuedTaskStartEmailLastSentAt
              ? Date.parse(queuedTaskStartEmailLastSentAt)
              : Number.NaN;
            const canSendQueuedEmail =
              !queuedTaskStartEmailLastSentAt ||
              !Number.isFinite(lastSentMs) ||
              Date.now() - lastSentMs >= cooldownMs;

            if (canSendQueuedEmail) {
              const name =
                userProfile?.fullName ??
                userProfile?.nickname ??
                userProfile?.occupation ??
                userProfile?.roleTitle ??
                null;
              const sentAt = new Date().toISOString();
              queuedTaskStartEmailLastSentAt = sentAt;

              void (async () => {
                try {
                  await sendQueuedTaskStartedEmail({
                    email: authedUserEmail,
                    name,
                    chatTitle: chatTitleForEmail ?? undefined,
                  });
                } catch (error) {
                  console.error("Failed to send queued task email:", error);
                  return;
                }

                try {
                  const { data: profileRow, error: profileErr } = await supabaseClient
                    .from("profiles")
                    .select("preferences")
                    .eq("id", authedUserId)
                    .maybeSingle();
                  if (profileErr) throw profileErr;

                  const prefs = (profileRow?.preferences ?? {}) as Record<string, unknown>;
                  const commPrefs =
                    typeof prefs.comm === "object" && prefs.comm !== null
                      ? (prefs.comm as Record<string, unknown>)
                      : {};

                  const nextPrefs = {
                    ...prefs,
                    comm: {
                      ...commPrefs,
                      queued_task_start_last_sent_at: sentAt,
                    },
                  };

                  const { error: updateErr } = await supabaseClient
                    .from("profiles")
                    .upsert({ id: authedUserId, preferences: nextPrefs }, { onConflict: "id" });
                  if (updateErr) throw updateErr;
                } catch (error) {
                  console.error(
                    "Failed to persist queued task email throttle timestamp:",
                    error
                  );
                }
              })();
            }
          }
        }

        let assistantMessage: StreamMessageLike = { content: "" };
        const updateAssistant = (updater: (m: StreamMessageLike) => StreamMessageLike) => {
          assistantMessage = updater(assistantMessage);
        };
        const streamParser = createStreamParser<StreamMessageLike>({
          updateAssistant,
          updateReasoningOwner: updateAssistant,
          createId: () => randomUUID(),
        });

        const persistAssistantMessage = async () => {
          if (!authedUserId || !chatIdValue) return;
          const row = buildMessageRow({
            id: assistantMessageId,
            chatId: chatIdValue,
            role: "assistant",
            content: assistantMessage.content ?? "",
            status: assistantMessage.status,
            reasoningSummary: assistantMessage.reasoningSummary,
            reasoningSegments: assistantMessage.reasoningSegments,
            traceSegments: assistantMessage.traceSegments,
            renderOrder: assistantMessage.renderOrder,
            createdAt: assistantMessageCreatedAt,
          });
          const { error } = await supabaseClient
            .from("messages")
            .upsert([row], { onConflict: "id" });
          if (error) {
            console.error("Failed to persist assistant message:", error.message);
          }
        };

        let persistTimer: ReturnType<typeof setTimeout> | null = null;
        const schedulePersist = () => {
          if (!authedUserId || !chatIdValue) return;
          if (persistTimer) return;
          persistTimer = setTimeout(() => {
            persistTimer = null;
            void persistAssistantMessage();
          }, 750);
        };
        const flushPersist = async () => {
          if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          await persistAssistantMessage();
        };

        if (authedUserId && chatIdValue) {
          await persistAssistantMessage();
        }

        const context: ProjectContext & { inputFiles?: typeof inputFiles } = {
          projectId: chatIdValue || randomUUID(),
          userId: authedUserId || "demo-user",
          mode: resolvePreferredMode(preferredMode),
          createdAt: new Date(),
          userProfile,
          skillPreferences,
          dataContext: null,
          edaContext: null,
          goalContext: null,
          preparationContext: null,
          providerContext: null,
          trainingContext: null,
          exportContext: null,
          inputFiles,
        };

        const coordinator = new AgentCoordinator({
          ...context,
          sessionId: context.projectId,
          mcpServers,
          constraints: {
            noClientSecrets: true,
            provider: getConfiguredLlmProvider(),
            allowWebSearch: Boolean(process.env.EXA_API_KEY),
            sourcePolicy: buildSourcePolicySettings(),
            mcp: mcpEnabledServers ? { enabledServers: mcpEnabledServers } : undefined,
          },
          budgets: {
            maxIterations:
              parsePositiveIntEnv("TUNA_AGENT_MAX_ITERATIONS") ??
              parsePositiveIntEnv("AGENT_MAX_ITERATIONS") ??
              80,
            maxToolCallsTotal:
              parsePositiveIntEnv("TUNA_AGENT_MAX_TOOL_CALLS_TOTAL") ??
              parsePositiveIntEnv("AGENT_MAX_TOOL_CALLS_TOTAL") ??
              400,
            maxRunMs:
              parsePositiveIntEnv("TUNA_AGENT_MAX_RUN_MS") ??
              parsePositiveIntEnv("AGENT_MAX_RUN_MS") ??
              600_000,
          },
        });

        const result = await coordinator.processMessage(message, {
          history,
          reasoningEffort,
          onStatusEvent: (event) => {
            streamParser.appendStatusEvent(event);
            schedulePersist();
            send("status", event);
          },
          onContextUsage: (usage) => send("context", usage),
          onUiUpsert: (upsert) => send("ui_upsert", upsert),
          onUiOpen: (open) => send("ui_open", open),
          onContentDelta: (delta) => {
            if (typeof delta === "string" && delta) {
              streamParser.appendContentDelta(delta);
              schedulePersist();
            }
            send("content", delta);
          },
          onReasoningSummaryDelta: (delta) => {
            if (typeof delta === "string" && delta) {
              streamParser.appendReasoningSummaryDelta(delta);
              schedulePersist();
            }
            send("reasoning_summary", delta);
          },
          onLlmUsage: (usage) => {
            llmUsages.push(usage);
          },
        });
        await finalizeBilling({ sendUsageEvent: true, outcome: "done" });

        streamParser.flushStreamBuffer();
        streamParser.closeActiveTraceSegment();
        streamParser.closeActiveReasoningSegment();
        const isDone = result.status?.phase === "done";
        const shouldPromoteFinalTrace =
          traceRoutingPolicy.promoteTraceOnDoneWhenAnswerEmpty && isDone;
        if (shouldPromoteFinalTrace && !assistantMessage.content.trim()) {
          streamParser.promoteFinalTraceSegment({ promote: true });
        } else if (!assistantMessage.content.trim() && isDone) {
          streamParser.promoteFinalTraceSegment();
        } else {
          streamParser.promoteFinalTraceSegment({ promote: false });
        }
        if (!assistantMessage.content.trim() && typeof result.content === "string" && result.content.trim()) {
          streamParser.appendAnswerDelta(result.content);
        }
        await flushPersist();

        if (runId) {
          const { error: runUpdateErr } = await supabaseClient
            .from("agent_runs")
            .update({ status: "done" })
            .eq("id", runId);
          if (runUpdateErr) {
            console.error("Failed to mark run done:", runUpdateErr.message);
          }
        }

        send("done", { status: result.status, ui: result.ui, content: result.content });
        if (!clientDisconnected) {
          controller.close();
        }
      } catch (error) {
        const safePayload = buildSafeErrorPayload(error);
        await finalizeBilling({ outcome: "failed" });
        if (runId && supabase) {
          const { error: runUpdateErr } = await supabase
            .from("agent_runs")
            .update({ status: "failed", error: safePayload.message })
            .eq("id", runId);
          if (runUpdateErr) {
            console.error("Failed to mark run failed:", runUpdateErr.message);
          }
        }
        send("error", safePayload);
        if (!clientDisconnected) {
          controller.close();
        }
      } finally {
        stopHeartbeat();
      }
    },
    cancel() {
      clientDisconnected = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      [TRACE_PROMOTE_ON_DONE_HEADER]: traceRoutingPolicy.promoteTraceOnDoneWhenAnswerEmpty ? "1" : "0",
    },
  });
}
