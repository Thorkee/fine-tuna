import { NextRequest } from "next/server";

import {
  buildFallbackMessageRow,
  type MissingMessageColumnFlags,
} from "@/lib/agent/message-row";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function detectMissingMessageColumns(error: unknown): MissingMessageColumnFlags {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  const code =
    typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";

  const missingStatusColumn = code === "42703" || message.includes('column "status" of relation "messages" does not exist');
  const missingReasoningColumn =
    code === "42703" || message.includes('column "reasoning_summary" of relation "messages" does not exist');
  const missingReasoningSegmentsColumn =
    code === "42703" || message.includes('column "reasoning_segments" of relation "messages" does not exist');
  const missingTraceColumn =
    code === "42703" || message.includes('column "trace_segments" of relation "messages" does not exist');
  const missingRenderOrderColumn =
    code === "42703" || message.includes('column "render_order" of relation "messages" does not exist');

  return {
    missingStatusColumn,
    missingReasoningColumn,
    missingReasoningSegmentsColumn,
    missingTraceColumn,
    missingRenderOrderColumn,
  };
}

function shouldFallbackForMissingColumns(missing: MissingMessageColumnFlags): boolean {
  return Boolean(
    missing.missingStatusColumn ||
      missing.missingReasoningColumn ||
      missing.missingReasoningSegmentsColumn ||
      missing.missingTraceColumn ||
      missing.missingRenderOrderColumn
  );
}

function pickRow(body: Record<string, unknown>, chatId: string): Record<string, unknown> {
  const allowed = new Set([
    "id",
    "role",
    "content",
    "files",
    "status",
    "reasoning_summary",
    "reasoning_segments",
    "trace_segments",
    "render_order",
    "created_at",
  ]);
  const row: Record<string, unknown> = { chat_id: chatId };
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) row[key] = value;
  }
  return row;
}

function hasMeaningfulMessagePayload(body: Record<string, unknown>): boolean {
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (content) return true;

  const files = body.files;
  if (Array.isArray(files) && files.length > 0) return true;

  const status = body.status;
  if (status && typeof status === "object") {
    const phase = (status as { phase?: unknown }).phase;
    if (typeof phase === "string") return true;

    const events = (status as { events?: unknown }).events;
    if (Array.isArray(events) && events.length > 0) return true;
  }

  if (typeof body.reasoning_summary === "string" && body.reasoning_summary.trim()) return true;
  if (Array.isArray(body.reasoning_segments) && body.reasoning_segments.length > 0) return true;
  if (Array.isArray(body.trace_segments) && body.trace_segments.length > 0) return true;
  if (Array.isArray(body.render_order) && body.render_order.length > 0) return true;

  return false;
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
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? []);
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
  if (!body) {
    return Response.json({ error: "Missing request body" }, { status: 400 });
  }

  const role = typeof body.role === "string" ? body.role : "";
  if ((role !== "user" && role !== "assistant") || !hasMeaningfulMessagePayload(body)) {
    return Response.json({ error: "Invalid message payload" }, { status: 400 });
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

  const insert = async (row: Record<string, unknown>) => {
    const { data, error } = await supabase.from("messages").insert([row]).select().single();
    if (error) throw error;
    return data;
  };

  const row = pickRow(body, chatId);
  try {
    const data = await insert(row);
    return Response.json(data, { status: 201 });
  } catch (error) {
    const missing = detectMissingMessageColumns(error);
    if (shouldFallbackForMissingColumns(missing)) {
      const data = await insert(buildFallbackMessageRow(row, missing));
      return Response.json(data, { status: 201 });
    }
    const message = error instanceof Error ? error.message : "Failed to insert message";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
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
  if (!body) {
    return Response.json({ error: "Missing request body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const role = typeof body.role === "string" ? body.role : "";
  if (!id || (role !== "user" && role !== "assistant") || !hasMeaningfulMessagePayload(body)) {
    return Response.json({ error: "Invalid message payload" }, { status: 400 });
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

  const upsert = async (row: Record<string, unknown>) => {
    const { data, error } = await supabase
      .from("messages")
      .upsert([row], { onConflict: "id" })
      .select()
      .single();
    if (error) throw error;
    return data;
  };

  const row = pickRow(body, chatId);
  try {
    const data = await upsert(row);
    return Response.json(data);
  } catch (error) {
    const missing = detectMissingMessageColumns(error);
    if (shouldFallbackForMissingColumns(missing)) {
      const data = await upsert(buildFallbackMessageRow(row, missing));
      return Response.json(data);
    }
    const message = error instanceof Error ? error.message : "Failed to upsert message";
    return Response.json({ error: message }, { status: 500 });
  }
}

