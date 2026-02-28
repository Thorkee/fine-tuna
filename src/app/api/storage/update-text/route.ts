import { NextRequest } from "next/server";

import { uploadStorageObject } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdateTextPayload = {
  chatId: string;
  bucket: "uploads" | "artifacts";
  storagePath: string;
  contentText: string;
  contentType?: string;
};

function isAllowedArtifactsPath(chatId: string, storagePath: string): boolean {
  return (
    storagePath.startsWith(`exports/${chatId}/`) ||
    storagePath.startsWith(`runner-outputs/${chatId}/`)
  );
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function maxEditBytes(): number {
  return parsePositiveInt(process.env.FILES_DRAWER_MAX_EDIT_BYTES) ?? 500_000;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as UpdateTextPayload | null;
  const chatId = payload?.chatId?.trim();
  const bucket = payload?.bucket;
  const storagePath = payload?.storagePath?.trim();
  const contentText = typeof payload?.contentText === "string" ? payload.contentText : null;
  const contentType = typeof payload?.contentType === "string" ? payload.contentType.trim() : "";

  if (!chatId || (bucket !== "uploads" && bucket !== "artifacts") || !storagePath || contentText === null) {
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

  const buffer = Buffer.from(contentText, "utf-8");
  const limit = maxEditBytes();
  if (buffer.byteLength > limit) {
    return Response.json({ error: `Content too large (max ${limit} bytes)` }, { status: 413 });
  }

  try {
    await uploadStorageObject(bucket, storagePath, buffer, {
      contentType: contentType || "text/plain; charset=utf-8",
    });
    return Response.json({ ok: true, bucket, storagePath, bytes: buffer.byteLength });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

