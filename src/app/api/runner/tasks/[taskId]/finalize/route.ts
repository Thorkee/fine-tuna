import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { finalizeTrainingOutputs } from "@/lib/training/finalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FinalizePayload = {
  chatId?: string;
  force?: boolean;
};

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> | { taskId: string } }
) {
  const params = await ctx.params;
  const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
  const body = (await req.json().catch(() => null)) as FinalizePayload | null;
  const chatId = body?.chatId?.trim();
  if (!chatId || !taskId) {
    return Response.json({ error: "Missing chatId or taskId" }, { status: 400 });
  }

  const supabase = await createClient();
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (chatErr || !chatRow) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  try {
    const result = await finalizeTrainingOutputs({
      chatId,
      taskId,
      force: Boolean(body?.force),
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Training finalize failed";
    const status = message.toLowerCase().includes("not completed") ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}
