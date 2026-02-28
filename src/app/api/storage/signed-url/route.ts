import { NextRequest } from "next/server";

import { createStorageSignedUrl } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SignedUrlPayload = {
  chatId: string;
  bucket: "uploads" | "artifacts";
  storagePath: string;
  ttlSeconds?: number;
};

function isAllowedArtifactsPath(chatId: string, storagePath: string): boolean {
  return (
    storagePath.startsWith(`exports/${chatId}/`) ||
    storagePath.startsWith(`runner-outputs/${chatId}/`)
  );
}

function parseTtl(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as SignedUrlPayload | null;
  const chatId = payload?.chatId?.trim();
  const bucket = payload?.bucket;
  const storagePath = payload?.storagePath?.trim();
  const ttlSeconds = parseTtl(payload?.ttlSeconds) ?? 60 * 10;

  if (!chatId || (bucket !== "uploads" && bucket !== "artifacts") || !storagePath) {
    return Response.json({ error: "Missing payload" }, { status: 400 });
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

  if (bucket === "uploads") {
    const expectedPrefix = `${user.id}/${chatId}/`;
    if (!storagePath.startsWith(expectedPrefix)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (!isAllowedArtifactsPath(chatId, storagePath)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = await createStorageSignedUrl(bucket, storagePath, ttlSeconds);
    return Response.json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create signed URL";
    return Response.json({ error: message }, { status: 500 });
  }
}

