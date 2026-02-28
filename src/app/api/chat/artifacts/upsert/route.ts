import { NextRequest } from "next/server";
import { randomUUID } from "crypto";

import { AgentPersistence } from "@/lib/agent/persistence";
import { createClient } from "@/lib/supabase/server";
import { normalizeArtifactId } from "@/lib/agent/artifact-mapping";
import { appendCanvasTimelineEvent } from "@/lib/agent/canvas-timeline";
import type { AgentArtifact, AgentBudgets, AgentConstraints, AgentState } from "@/lib/agent/types";
import { buildSourcePolicySettings } from "@/lib/agent/source-policy";
import { getConfiguredLlmProvider } from "@/lib/llm/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpsertPayload = {
  chatId: string;
  at?: string;
  artifact: {
    id: string;
    type: string;
    data: unknown;
    title?: string;
    status?: string;
    isCollaborative?: boolean;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickValidTimelineAt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return value;
}

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

function defaultBudgets(): AgentBudgets {
  return {
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
  };
}

function defaultConstraints(): AgentConstraints {
  return {
    noClientSecrets: true as const,
    provider: getConfiguredLlmProvider(),
    allowWebSearch: false,
    sourcePolicy: buildSourcePolicySettings(),
  };
}

const ARTIFACT_TYPES: readonly AgentArtifact["type"][] = [
  "plan",
  "code",
  "dataset",
  "visualization",
  "model_card",
  "markdown",
  "document",
  "spreadsheet",
] as const;

function toArtifactType(raw: unknown): AgentArtifact["type"] {
  return typeof raw === "string" && ARTIFACT_TYPES.includes(raw as AgentArtifact["type"])
    ? (raw as AgentArtifact["type"])
    : "markdown";
}

const ARTIFACT_STATUSES: readonly AgentArtifact["status"][] = ["draft", "final", "executing"] as const;
function toArtifactStatus(raw: unknown): AgentArtifact["status"] {
  return typeof raw === "string" && ARTIFACT_STATUSES.includes(raw as AgentArtifact["status"])
    ? (raw as AgentArtifact["status"])
    : "draft";
}

function ensureState(chatId: string, existing: AgentState | null): AgentState {
  if (existing) return existing;
  return {
    runId: randomUUID(),
    phase: "idle",
    goal: null,
    successCriteria: [],
    constraints: defaultConstraints(),
    budgets: defaultBudgets(),
    llm: {},
    plan: [],
    memory: { shortTerm: [], summary: "" },
    artifacts: [],
    activeSkillId: "orchestrator",
    ui: {},
    activeErrors: [],
  };
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as UpsertPayload | null;
  const chatId = payload?.chatId?.trim();
  if (!chatId || !payload?.artifact?.id) {
    return Response.json({ error: "Missing chatId or artifact" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .maybeSingle();

  if (chatErr || !chatRow) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const existing = await AgentPersistence.loadState(chatId);
  const state = ensureState(chatId, existing);

  const artifactInput = payload.artifact;
  const normalizedId = normalizeArtifactId(artifactInput.id, artifactInput.type);
  const now = new Date().toISOString();
  const artifactDataUpdatedAt = isRecord(artifactInput.data)
    ? pickValidTimelineAt((artifactInput.data as { updatedAt?: unknown }).updatedAt)
    : null;
  const timelineAt = pickValidTimelineAt(payload?.at) ?? artifactDataUpdatedAt ?? now;

  const normalized: AgentArtifact = {
    id: normalizedId,
    type: toArtifactType(artifactInput.type),
    title: artifactInput.title?.trim() || normalizedId,
    content: artifactInput.data,
    status: toArtifactStatus(artifactInput.status),
    isCollaborative: artifactInput.isCollaborative ?? true,
    createdAt: timelineAt,
    updatedAt: timelineAt,
  };

  const idx = state.artifacts.findIndex((a) => a.id === normalizedId);
  if (idx >= 0) {
    const existingArtifact = state.artifacts[idx];
    state.artifacts[idx] = {
      ...existingArtifact,
      ...normalized,
      createdAt: existingArtifact.createdAt,
      updatedAt: timelineAt,
    };
  } else {
    state.artifacts.push(normalized);
  }

  state.ui = state.ui ?? {};
  state.ui.canvasTimeline = Array.isArray(state.ui.canvasTimeline) ? state.ui.canvasTimeline : [];
  const timeline = state.ui.canvasTimeline;
  appendCanvasTimelineEvent(timeline, {
    at: timelineAt,
    kind: "upsert",
    artifactId: normalizedId,
    artifactType: normalized.type,
    data: normalized.content ?? null,
  });

  await AgentPersistence.saveState(chatId, state);

  return Response.json({ ok: true, artifactId: normalizedId, at: timelineAt });
}
