import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ensureRunOwnedByUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  runId: string,
  userId: string
) {
  const { data: runRow, error: runErr } = await supabase
    .from("agent_runs")
    .select("id, chat_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !runRow?.chat_id) return null;

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", runRow.chat_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (chatErr || !chatRow) return null;

  return runRow as { id: string; chat_id: string };
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> | { runId: string } }
) {
  const params = await ctx.params;
  const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const payload: unknown = await req.json().catch(() => null);
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const status = typeof body?.status === "string" ? body.status.trim() : "";
  const errorMessage = typeof body?.error === "string" ? body.error : undefined;
  if (!status) {
    return Response.json({ error: "Missing status" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const owned = await ensureRunOwnedByUser(supabase, runId, authedUserId);
  if (!owned) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { status };
  if (typeof errorMessage === "string") updates.error = errorMessage;

  const { data, error } = await supabase
    .from("agent_runs")
    .update(updates)
    .eq("id", runId)
    .select()
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json(data);
}

