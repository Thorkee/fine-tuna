import { NextRequest } from "next/server";

import { deleteStoragePrefix } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const { data, error } = await supabase
    .from("chats")
    .select("*")
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  return Response.json(data);
}

export async function PATCH(
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
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json({ error: "Missing title" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("chats")
    .update({ title })
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .select()
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  return Response.json(data);
}

export async function DELETE(
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

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .maybeSingle();

  if (chatErr || !chatRow) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const { data: runRow, error: runErr } = await supabase
    .from("agent_runs")
    .select("id")
    .eq("chat_id", chatId)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runErr) {
    return Response.json({ error: "Failed to check active run" }, { status: 500 });
  }

  if (runRow) {
    return Response.json(
      {
        error: "Chat is currently running. Please wait for it to finish before deleting.",
        code: "RUN_ACTIVE",
      },
      { status: 409 }
    );
  }

  let uploadsDeleted = 0;
  let exportsDeleted = 0;
  let runnerOutputsDeleted = 0;
  try {
    ({ deleted: uploadsDeleted } = await deleteStoragePrefix("uploads", `${authedUserId}/${chatId}/`));
    ({ deleted: exportsDeleted } = await deleteStoragePrefix("artifacts", `exports/${chatId}/`));
    ({ deleted: runnerOutputsDeleted } = await deleteStoragePrefix("artifacts", `runner-outputs/${chatId}/`));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete chat files";
    return Response.json({ error: message }, { status: 500 });
  }

  const { error: deleteErr } = await supabase
    .from("chats")
    .delete()
    .eq("id", chatId)
    .eq("user_id", authedUserId);

  if (deleteErr) {
    return Response.json({ error: deleteErr.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    deleted: { uploads: uploadsDeleted, exports: exportsDeleted, runnerOutputs: runnerOutputsDeleted },
  });
}
