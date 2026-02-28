import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRunnerConfig() {
  const baseUrl = (process.env.E2B_RUNNER_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("E2B_RUNNER_URL is not configured");
  }
  const token = (process.env.E2B_RUNNER_TOKEN || "").trim();
  return { baseUrl, token };
}

function buildAuthHeaders(token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function assertChatOwnership(chatId: string) {
  const supabase = await createClient();
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) {
    return { ok: false, response: Response.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (chatErr || !chatRow) {
    return { ok: false, response: Response.json({ error: "Chat not found" }, { status: 404 }) };
  }
  return { ok: true, response: null };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string; pid: string }> | { sessionId: string; pid: string } }
) {
  const params = await ctx.params;
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId")?.trim();
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
  const pid = typeof params?.pid === "string" ? params.pid.trim() : "";

  if (!chatId || !sessionId || !pid) {
    return Response.json({ error: "Missing chatId, sessionId, or pid" }, { status: 400 });
  }

  const auth = await assertChatOwnership(chatId);
  if (!auth.ok) return auth.response!;

  try {
    const { baseUrl, token } = getRunnerConfig();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/pty/${encodeURIComponent(pid)}/kill`;
    const resp = await fetch(url, { method: "POST", headers: buildAuthHeaders(token) });
    const text = await resp.text();
    if (!resp.ok) {
      return Response.json({ error: text || "Runner PTY kill failed" }, { status: resp.status });
    }
    const data = text ? JSON.parse(text) : {};
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner PTY kill failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
