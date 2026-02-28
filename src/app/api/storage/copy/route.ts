import { NextRequest } from "next/server";
import { randomUUID } from "crypto";

import { copyStorageObject } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CopyPayload = {
  chatId: string;
  fromBucket: "uploads" | "artifacts";
  fromStoragePath: string;
  toBucket: "uploads" | "artifacts";
  toStoragePath?: string;
  fileName?: string;
};

function isAllowedArtifactsPath(chatId: string, storagePath: string): boolean {
  return (
    storagePath.startsWith(`exports/${chatId}/`) ||
    storagePath.startsWith(`runner-outputs/${chatId}/`)
  );
}

function safeFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "file";
  return trimmed.replace(/[^a-z0-9_.-]+/gi, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

function keyToName(key: string): string {
  const parts = key.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : key;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as CopyPayload | null;
  const chatId = payload?.chatId?.trim();
  const fromBucket = payload?.fromBucket;
  const fromStoragePath = payload?.fromStoragePath?.trim();
  const toBucket = payload?.toBucket;
  const toStoragePathRaw = payload?.toStoragePath?.trim() || "";
  const fileNameHint = payload?.fileName?.trim() || "";

  if (
    !chatId ||
    (fromBucket !== "uploads" && fromBucket !== "artifacts") ||
    (toBucket !== "uploads" && toBucket !== "artifacts") ||
    !fromStoragePath
  ) {
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

  const allowPath = (bucket: "uploads" | "artifacts", storagePath: string): boolean => {
    if (bucket === "uploads") {
      return storagePath.startsWith(`${user.id}/${chatId}/`);
    }
    return isAllowedArtifactsPath(chatId, storagePath);
  };

  if (!allowPath(fromBucket, fromStoragePath)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const fileName = safeFileName(fileNameHint || keyToName(fromStoragePath));
  const toStoragePath =
    toStoragePathRaw ||
    (toBucket === "uploads"
      ? `${user.id}/${chatId}/copies/${randomUUID()}-${fileName}`
      : `runner-outputs/${chatId}/copies/${randomUUID()}-${fileName}`);

  if (!allowPath(toBucket, toStoragePath)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await copyStorageObject(fromBucket, fromStoragePath, toBucket, toStoragePath);
    return Response.json({
      ok: true,
      from: { bucket: fromBucket, storagePath: fromStoragePath },
      to: { bucket: toBucket, storagePath: toStoragePath },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Copy failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

