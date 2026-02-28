import { NextRequest } from "next/server";

import { deleteStorageObject } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeletePayload = {
  chatId: string;
  bucket: "uploads" | "artifacts";
  storagePath: string;
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

async function removeUploadRefsFromMessages(
  supabase: Awaited<ReturnType<typeof createClient>>,
  chatId: string,
  storagePath: string
): Promise<number> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, files")
    .eq("chat_id", chatId);
  if (error) {
    throw new Error(error.message);
  }

  const rows = Array.isArray(data) ? data : [];
  let updated = 0;
  for (const row of rows) {
    const id = typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : "";
    if (!id) continue;
    const filesRaw = (row as { files?: unknown }).files;
    const files = Array.isArray(filesRaw) ? filesRaw : [];
    const nextFiles = files.filter((f) => readStoragePath(f) !== storagePath);
    if (nextFiles.length === files.length) continue;
    updated += 1;
    const nextValue = nextFiles.length > 0 ? nextFiles : null;
    const { error: updErr } = await supabase
      .from("messages")
      .update({ files: nextValue })
      .eq("id", id)
      .eq("chat_id", chatId);
    if (updErr) {
      throw new Error(updErr.message);
    }
  }

  return updated;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json().catch(() => null)) as DeletePayload | null;
  const chatId = payload?.chatId?.trim();
  const bucket = payload?.bucket;
  const storagePath = payload?.storagePath?.trim();

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
    let messagesUpdated = 0;
    if (bucket === "uploads") {
      messagesUpdated = await removeUploadRefsFromMessages(supabase, chatId, storagePath);
    }
    await deleteStorageObject(bucket, storagePath);
    return Response.json({ ok: true, bucket, storagePath, messagesUpdated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

