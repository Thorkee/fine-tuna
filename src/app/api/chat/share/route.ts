import { NextRequest } from "next/server";
import { AgentPersistence } from "@/lib/agent/persistence";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShareSnapshot = {
  version: 1;
  createdAt: string;
  chat: { id: string; title: string; created_at: string };
  messages: Array<{
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string;
    files?: unknown;
    status?: unknown;
    reasoning_summary?: string;
    reasoning_segments?: unknown;
    trace_segments?: unknown;
    render_order?: unknown;
    created_at: string;
  }>;
  state: {
    artifacts: Array<{ id: string; type: string; data: unknown; createdAt?: string; updatedAt?: string }>;
    canvasTimeline: unknown[];
  };
};

type StateArtifactResponse = {
  id: string;
  type: string;
  data: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const chatId =
    body && typeof body === "object" && "chatId" in body && typeof (body as { chatId?: unknown }).chatId === "string"
      ? String((body as { chatId?: string }).chatId)
      : "";

  if (!chatId.trim()) {
    return Response.json({ error: "Missing chatId" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id,title,created_at")
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .maybeSingle();

  if (chatErr || !chatRow) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const { data: messageRows, error: msgErr } = await supabase
    .from("messages")
    .select("id,chat_id,role,content,files,status,reasoning_summary,reasoning_segments,trace_segments,render_order,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (msgErr) {
    return Response.json({ error: "Failed to load messages" }, { status: 500 });
  }

  const agentState = await AgentPersistence.loadState(chatId);
  const artifacts: StateArtifactResponse[] = Array.isArray(agentState?.artifacts)
    ? agentState.artifacts
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
          id: String((a as { id?: unknown }).id ?? ""),
          type: String((a as { type?: unknown }).type ?? ""),
          data: (a as { content?: unknown }).content,
          createdAt:
            typeof (a as { createdAt?: unknown }).createdAt === "string"
              ? (a as { createdAt?: string }).createdAt
              : undefined,
          updatedAt:
            typeof (a as { updatedAt?: unknown }).updatedAt === "string"
              ? (a as { updatedAt?: string }).updatedAt
              : undefined,
        }))
        .filter((a) => a.id.trim().length > 0)
    : [];

  const canvasTimeline = Array.isArray((agentState as { ui?: { canvasTimeline?: unknown } })?.ui?.canvasTimeline)
    ? (((agentState as { ui?: { canvasTimeline?: unknown[] } })?.ui?.canvasTimeline ?? []) as unknown[])
    : [];

  const snapshot: ShareSnapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    chat: {
      id: String(chatRow.id ?? chatId),
      title: String(chatRow.title ?? "Untitled chat"),
      created_at: String(chatRow.created_at ?? new Date().toISOString()),
    },
    messages: Array.isArray(messageRows)
      ? messageRows.map((m) => ({
          id: String((m as { id?: unknown }).id ?? ""),
          chat_id: String((m as { chat_id?: unknown }).chat_id ?? chatId),
          role: (String((m as { role?: unknown }).role ?? "user") as "user" | "assistant"),
          content: String((m as { content?: unknown }).content ?? ""),
          files: (m as { files?: unknown }).files,
          status: (m as { status?: unknown }).status,
          reasoning_summary:
            typeof (m as { reasoning_summary?: unknown }).reasoning_summary === "string"
              ? String((m as { reasoning_summary?: string }).reasoning_summary)
              : undefined,
          reasoning_segments: (m as { reasoning_segments?: unknown }).reasoning_segments,
          trace_segments: (m as { trace_segments?: unknown }).trace_segments,
          render_order: (m as { render_order?: unknown }).render_order,
          created_at: String((m as { created_at?: unknown }).created_at ?? new Date().toISOString()),
        }))
      : [],
    state: { artifacts, canvasTimeline },
  };

  const { data: shareRow, error: shareErr } = await supabase
    .from("chat_shares")
    .insert([
      {
        chat_id: chatId,
        owner_id: authedUserId,
        snapshot,
        is_public: true,
      },
    ])
    .select("share_id")
    .single();

  if (shareErr || !shareRow?.share_id) {
    return Response.json({ error: "Failed to create share" }, { status: 500 });
  }

  const shareId = String(shareRow.share_id);
  return Response.json({ shareId, url: `/share/${shareId}` });
}

