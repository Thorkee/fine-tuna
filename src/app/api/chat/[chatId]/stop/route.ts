import { NextRequest } from "next/server";

import { AgentPersistence } from "@/lib/agent/persistence";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ensureChatOwnedByUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  chatId: string,
  userId: string
) {
  const { data, error } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return true;
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
  const reason = typeof body?.reason === "string" ? body.reason : undefined;

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const owned = await ensureChatOwnedByUser(supabase, chatId, authedUserId);
  if (!owned) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const state = await AgentPersistence.loadState(chatId).catch(() => null);
  if (!state) {
    return Response.json({ ok: true, stopRequested: false });
  }

  state.stopRequested = {
    at: new Date().toISOString(),
    reason,
  };
  await AgentPersistence.saveState(chatId, state);

  return Response.json({ ok: true, stopRequested: true });
}
