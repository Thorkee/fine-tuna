import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_PHASES = new Set(["idle", "done", "failed", "blocked"]);

function parsePositiveIntEnv(...varNames: string[]): number | null {
  for (const varName of varNames) {
    const raw = process.env[varName];
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n;
  }
  return null;
}

function toEpochMs(value: string | undefined | null): number | null {
  if (!value || typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function getPhase(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const phase = (state as { phase?: unknown }).phase;
  return typeof phase === "string" ? phase : null;
}

async function ensureChatOwnedByUser(supabase: Awaited<ReturnType<typeof createClient>>, chatId: string, userId: string) {
  const { data, error } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return true;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ chatId: string }> | { chatId: string } }
) {
  const params = await ctx.params;
  const chatId = typeof params?.chatId === "string" ? params.chatId.trim() : "";
  if (!chatId) {
    return Response.json({ error: "Missing chatId" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const owned = await ensureChatOwnedByUser(supabase, chatId, authedUserId);
  if (!owned) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("agent_runs")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json(null);
  }

  const { data: stateRow, error: stateErr } = await supabase
    .from("agent_states")
    .select("state, updated_at")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (stateErr) {
    console.error("Failed to load agent state for run check:", stateErr.message);
  }

  const phase = getPhase(stateRow?.state);
  const isTerminalPhase = phase ? TERMINAL_PHASES.has(phase) : false;
  const maxRunMs =
    parsePositiveIntEnv("TUNA_AGENT_MAX_RUN_MS") ??
    parsePositiveIntEnv("AGENT_MAX_RUN_MS") ??
    600_000;
  const staleAfterMs = maxRunMs + 30_000;
  const lastStateUpdateMs = toEpochMs(stateRow?.updated_at);
  const lastRunUpdateMs = toEpochMs((data as { updated_at?: string }).updated_at);
  const lastUpdateMs = lastStateUpdateMs ?? lastRunUpdateMs;
  const isStale = lastUpdateMs !== null && Date.now() - lastUpdateMs > staleAfterMs;

  if (isTerminalPhase || isStale) {
    const nextStatus = phase === "failed" ? "failed" : "done";
    const { error: runUpdateErr } = await supabase
      .from("agent_runs")
      .update({ status: nextStatus })
      .eq("id", data.id);
    if (runUpdateErr) {
      console.error("Failed to mark stale run complete:", runUpdateErr.message);
    }
    return Response.json(null);
  }

  return Response.json(data);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ chatId: string }> | { chatId: string } }
) {
  const params = await ctx.params;
  const chatId = typeof params?.chatId === "string" ? params.chatId.trim() : "";
  if (!chatId) {
    return Response.json({ error: "Missing chatId" }, { status: 400 });
  }

  const payload: unknown = await req.json().catch(() => null);
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const owned = await ensureChatOwnedByUser(supabase, chatId, authedUserId);
  if (!owned) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const row: Record<string, unknown> = { chat_id: chatId, status: "running" };
  if (id) row.id = id;

  const { data, error } = await supabase.from("agent_runs").insert([row]).select().single();
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data, { status: 201 });
}

