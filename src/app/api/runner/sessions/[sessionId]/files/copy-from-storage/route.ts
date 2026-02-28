import { NextRequest } from "next/server";

import { downloadStorageObject } from "@/lib/supabase/storage";
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

function isSafeSandboxPath(value: string): boolean {
  const path = value.trim();
  if (!path) return false;
  if (path === "/code") return true;
  if (!path.startsWith("/code/")) return false;
  if (path.includes("\0")) return false;
  if (path.split("/").includes("..")) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function maxCopyBytes(): number {
  return (
    parsePositiveInt(process.env.FILES_DRAWER_MAX_COPY_BYTES) ??
    parsePositiveInt(process.env.RUNNER_MAX_FILE_BYTES) ??
    20_000_000
  );
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

  const payload = (await req.json().catch(() => null)) as unknown;
  const body = isRecord(payload) ? payload : null;
  const bucket = body && typeof body.bucket === "string" ? body.bucket.trim() : "";
  const storagePath = body && typeof body.storagePath === "string" ? body.storagePath.trim() : "";
  const destPath = body && typeof body.destPath === "string" ? body.destPath.trim() : "";

  if ((bucket !== "uploads" && bucket !== "artifacts") || !storagePath || !destPath) {
    return Response.json({ error: "Missing payload" }, { status: 400 });
  }
  if (!isSafeSandboxPath(destPath)) {
    return Response.json({ error: "Invalid destPath" }, { status: 400 });
  }

  // Enforce strict storage scoping.
  if (bucket === "uploads") {
    const expectedPrefix = `${user.id}/${chatId}/`;
    if (!storagePath.startsWith(expectedPrefix)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const ok =
      storagePath.startsWith(`exports/${chatId}/`) ||
      storagePath.startsWith(`runner-outputs/${chatId}/`);
    if (!ok) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const buffer = await downloadStorageObject(bucket, storagePath);
    const limit = maxCopyBytes();
    if (buffer.byteLength > limit) {
      return Response.json({ error: `File too large (max ${limit} bytes)` }, { status: 413 });
    }
    const base64 = buffer.toString("base64");
    const { baseUrl, token } = getRunnerConfig();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/files`;
    const headers = { ...buildAuthHeaders(token), "Content-Type": "application/json" };
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        files: [{ path: destPath, content_base64: base64 }],
      }),
    });
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
    return Response.json({ ...data, destPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Copy to sandbox failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

