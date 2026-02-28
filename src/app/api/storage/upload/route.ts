import { NextRequest } from "next/server";

import { uploadStorageObject } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "file";
  return trimmed.replace(/[^a-z0-9_-]+/gi, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const formData = await req.formData();
  const chatId = getFormString(formData, "chatId");
  const fileId = getFormString(formData, "fileId");
  const fileName = getFormString(formData, "fileName");
  const mimeType = getFormString(formData, "mimeType");
  const file = formData.get("file");

  if (!chatId || !fileId || !(file instanceof File)) {
    return Response.json({ error: "Missing payload" }, { status: 400 });
  }

  const name = fileName || file.name || "file";
  const safeName = safeFileName(name);
  const storagePath = `${user.id}/${chatId}/${fileId}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const contentType = mimeType || file.type || "application/octet-stream";

  try {
    await uploadStorageObject("uploads", storagePath, buffer, { contentType });
    return Response.json({ storagePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
