import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("chats")
    .select("*")
    .eq("user_id", authedUserId)
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const payload: unknown = await req.json().catch(() => null);
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!title) {
    return Response.json({ error: "Missing title" }, { status: 400 });
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const row: Record<string, unknown> = { title, user_id: authedUserId };
  if (id) row.id = id;

  const { data, error } = await supabase.from("chats").insert([row]).select().single();
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data, { status: 201 });
}

