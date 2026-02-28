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

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> | { sessionId: string } }
) {
  const params = await ctx.params;
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId")?.trim();
  const path = searchParams.get("path")?.trim() || "";
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";

  if (!chatId || !sessionId || !path) {
    return Response.json({ error: "Missing chatId, sessionId, or path" }, { status: 400 });
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
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/files/content?${qp.toString()}`;
    const resp = await fetch(url, { headers: buildAuthHeaders(token) });
    if (!resp.ok) {
      const message = await resp.text().catch(() => "Runner file download failed");
      return Response.json({ error: message || "Runner file download failed" }, { status: resp.status });
    }

    const billing = await maybeBillSandboxSession({
      userId: user.id,
      chatId,
      sessionId,
    });
    if (billing?.blocked === "insufficient_credits") {
      return Response.json({ error: "insufficient_credits" }, { status: 402 });
    }

    const headers = new Headers();
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    headers.set("Content-Type", contentType);
    const disposition = resp.headers.get("content-disposition");
    if (disposition) headers.set("Content-Disposition", disposition);
    const length = resp.headers.get("content-length");
    if (length) headers.set("Content-Length", length);
    return new Response(resp.body, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner file download failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

