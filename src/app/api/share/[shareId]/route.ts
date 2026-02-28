import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ shareId: string }> | { shareId: string } }
) {
  const params = await ctx.params;
  const shareId = typeof params?.shareId === "string" ? params.shareId : "";
  if (!shareId.trim()) {
    return Response.json({ error: "Missing shareId" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("chat_shares")
    .select("snapshot, is_public, revoked_at, expires_at")
    .eq("share_id", shareId)
    .maybeSingle();

  if (error) {
    return Response.json({ error: "Failed to load share" }, { status: 500 });
  }

  if (!data?.snapshot) {
    return Response.json({ error: "Share not found" }, { status: 404 });
  }

  // Explicit checks for revocation and expiration (in addition to RLS policies)
  if (!data.is_public) {
    return Response.json({ error: "This share is not public" }, { status: 403 });
  }

  if (data.revoked_at) {
    return Response.json({ error: "This share has been revoked" }, { status: 410 });
  }

  if (data.expires_at) {
    const expiresAt = new Date(data.expires_at);
    if (!isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
      return Response.json({ error: "This share has expired" }, { status: 410 });
    }
  }

  // Return with cache headers – snapshots are immutable once created
  return new Response(JSON.stringify(data.snapshot), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
