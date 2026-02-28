import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { maybeBillSandboxSession } from "@/lib/billing/e2b-session-billing";

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

const SANDBOX_READ_ROOTS = ["/code", "/pipelines"] as const;

function isSafeSandboxReadPath(value: string): boolean {
  const p = value.trim();
  if (!p) return false;
  if (p.includes("\0")) return false;
  if (p.split("/").includes("..")) return false;
  return SANDBOX_READ_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));
}

function isSafeSandboxWritePath(value: string): boolean {
  const p = value.trim();
  if (!p) return false;
  // Keep user-driven file writes confined to /code.
  if (p === "/code") return true;
  if (!p.startsWith("/code/")) return false;
  if (p.includes("\0")) return false;
  if (p.split("/").includes("..")) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> | { sessionId: string } }
) {
  const params = await ctx.params;
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId")?.trim();
  const path = searchParams.get("path")?.trim() || "/code";
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";

  if (!chatId || !sessionId) {
    return Response.json({ error: "Missing chatId or sessionId" }, { status: 400 });
  }
  if (!isSafeSandboxReadPath(path)) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
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
    const { baseUrl, token } = getRunnerConfig();
    const qp = new URLSearchParams({ path });
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/files?${qp.toString()}`;
    const resp = await fetch(url, { headers: buildAuthHeaders(token) });
    const text = await resp.text();
    if (!resp.ok) {
      return Response.json({ error: text || "Runner files list failed" }, { status: resp.status });
    }
    const data = text ? JSON.parse(text) : {};
    const billing = await maybeBillSandboxSession({
      userId: user.id,
      chatId,
      sessionId,
    });
    if (billing?.blocked === "insufficient_credits") {
      return Response.json({ error: "insufficient_credits" }, { status: 402 });
    }
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner files list failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> | { sessionId: string } }
) {
  const params = await ctx.params;
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId")?.trim();
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";

  if (!chatId || !sessionId) {
    return Response.json({ error: "Missing chatId or sessionId" }, { status: 400 });
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

  const payload: unknown = await req.json().catch(() => null);
  const body = isRecord(payload) ? payload : null;
  const files = body && Array.isArray(body.files) ? body.files : null;
  if (!files || files.length === 0) {
    return Response.json({ error: "Missing files" }, { status: 400 });
  }

  for (const f of files) {
    if (!isRecord(f)) return Response.json({ error: "Invalid file entry" }, { status: 400 });
    const path = typeof f.path === "string" ? f.path : "";
    if (!isSafeSandboxWritePath(path)) {
      return Response.json({ error: `Invalid sandbox path: ${String(path)}` }, { status: 400 });
    }
  }

  try {
    const { baseUrl, token } = getRunnerConfig();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/files`;
    const headers = { ...buildAuthHeaders(token), "Content-Type": "application/json" };
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await resp.text();
    if (!resp.ok) {
      return Response.json({ error: text || "Runner file write failed" }, { status: resp.status });
    }
    const data = text ? JSON.parse(text) : {};
    const billing = await maybeBillSandboxSession({
      userId: user.id,
      chatId,
      sessionId,
    });
    if (billing?.blocked === "insufficient_credits") {
      return Response.json({ error: "insufficient_credits" }, { status: 402 });
    }
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner file write failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

