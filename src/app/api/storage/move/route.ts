import { NextRequest } from "next/server";

import { moveStorageObject } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MovePayload = {
  chatId: string;
  bucket: "uploads" | "artifacts";
  fromStoragePath: string;
  toStoragePath: string;
};

function isAllowedArtifactsPath(chatId: string, storagePath: string): boolean {
  return (
    storagePath.startsWith(`exports/${chatId}/`) ||
    storagePath.startsWith(`runner-outputs/${chatId}/`)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStoragePath(value: unknown): string {
  if (!isRecord(value)) return "";
  const a = value.storagePath;
  if (typeof a === "string") return a;
  const b = value.storage_path;
  if (typeof b === "string") return b;
  return "";
}

function keyToName(key: string): string {
  const parts = key.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : key;
}

async function updateUploadRefsInMessages(
  supabase: Awaited<ReturnType<typeof createClient>>,
  chatId: string,
  fromPath: string,
  toPath: string
): Promise<number> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, files")
    .eq("chat_id", chatId);
  if (error) throw new Error(error.message);

  const rows = Array.isArray(data) ? data : [];
  let updated = 0;
  const nextName = keyToName(toPath);
  for (const row of rows) {
    const id = typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : "";
    if (!id) continue;
    const filesRaw = (row as { files?: unknown }).files;
    const files = Array.isArray(filesRaw) ? filesRaw : [];
    let changed = false;
    const nextFiles = files.map((f) => {
      if (!isRecord(f)) return f;
      const sp = readStoragePath(f);
      if (sp !== fromPath) return f;
      changed = true;
      return { ...f, storagePath: toPath, name: nextName };
    });
    if (!changed) continue;
    updated += 1;
    const { error: updErr } = await supabase
      .from("messages")
      .update({ files: nextFiles.length > 0 ? nextFiles : null })
      .eq("id", id)
      .eq("chat_id", chatId);
    if (updErr) throw new Error(updErr.message);
  }
  return updated;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as MovePayload | null;
  const chatId = payload?.chatId?.trim();
  const bucket = payload?.bucket;
  const fromStoragePath = payload?.fromStoragePath?.trim();
  const toStoragePath = payload?.toStoragePath?.trim();

  if (
    !chatId ||
    (bucket !== "uploads" && bucket !== "artifacts") ||
    !fromStoragePath ||
    !toStoragePath
  ) {
    return Response.json({ error: "Missing payload" }, { status: 400 });
  }
  if (toStoragePath.endsWith("/")) {
    return Response.json({ error: "Invalid toStoragePath" }, { status: 400 });
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
    if (!fromStoragePath.startsWith(expectedPrefix) || !toStoragePath.startsWith(expectedPrefix)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    if (!isAllowedArtifactsPath(chatId, fromStoragePath) || !isAllowedArtifactsPath(chatId, toStoragePath)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    await moveStorageObject(bucket, fromStoragePath, bucket, toStoragePath);
    const messagesUpdated =
      bucket === "uploads"
        ? await updateUploadRefsInMessages(supabase, chatId, fromStoragePath, toStoragePath)
        : 0;
    return Response.json({
      ok: true,
      bucket,
      fromStoragePath,
      toStoragePath,
      messagesUpdated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Move failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

