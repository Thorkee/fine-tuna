import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { downloadStorageObject } from "@/lib/supabase/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DownloadPayload = {
  chatId: string;
  storagePath: string;
  fileName?: string;
  mimeType?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "file";
  return trimmed.replace(/[^a-z0-9_-]+/gi, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const payload = (await req.json().catch(() => null)) as DownloadPayload | null;
  const chatId = payload?.chatId?.trim();
  const storagePath = payload?.storagePath?.trim();

  if (!chatId || !storagePath) {
    return Response.json({ error: "Missing payload" }, { status: 400 });
  }

  const expectedPrefix = `${user.id}/${chatId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const buffer = await downloadStorageObject("uploads", storagePath);
    const fileName = safeFileName(payload?.fileName || "file");
    const mimeType = payload?.mimeType?.trim() || "application/octet-stream";
    const headers = new Headers();
    headers.set("Content-Type", mimeType);
    headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
    headers.set("Content-Length", buffer.byteLength.toString());
    const arrayBuffer = (buffer.buffer as ArrayBuffer).slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Response(arrayBuffer, { status: 200, headers });
  } catch (error) {
    if (isRecord(error)) {
      const metadata = error.$metadata;
      if (isRecord(metadata) && metadata.httpStatusCode === 404) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
    }
    const message = error instanceof Error ? error.message : "Download failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
