import { NextRequest } from "next/server";

import { downloadStorageObject, headStorageObject, type StorageObjectHead } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAllowedArtifactsPath(chatId: string, storagePath: string): boolean {
  return (
    storagePath.startsWith(`exports/${chatId}/`) ||
    storagePath.startsWith(`runner-outputs/${chatId}/`)
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ shareId: string }> | { shareId: string } }
) {
  const params = await ctx.params;
  const shareId = typeof params?.shareId === "string" ? params.shareId.trim() : "";
  if (!shareId) {
    return Response.json({ error: "Missing shareId" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const bucket = searchParams.get("bucket")?.trim() ?? "";
  const storagePath = searchParams.get("path")?.trim() ?? "";

  if (!bucket || !storagePath) {
    return Response.json({ error: "Missing bucket or path" }, { status: 400 });
  }

  if (bucket !== "artifacts") {
    return Response.json({ error: "Unsupported bucket" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("chat_shares")
    .select("chat_id")
    .eq("share_id", shareId)
    .maybeSingle();

  if (error || !data?.chat_id) {
    return Response.json({ error: "Share not found" }, { status: 404 });
  }

  const chatId = String(data.chat_id);
  if (!isAllowedArtifactsPath(chatId, storagePath)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const head = await headStorageObject(bucket, storagePath).catch(() => ({} as StorageObjectHead));
    const buffer = await downloadStorageObject(bucket, storagePath);
    const contentType = typeof head.contentType === "string" ? head.contentType : "application/octet-stream";
    const body = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load storage object";
    return Response.json({ error: message }, { status: 500 });
  }
}
