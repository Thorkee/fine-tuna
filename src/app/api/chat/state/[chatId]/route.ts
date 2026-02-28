import { NextRequest } from "next/server";
import { AgentPersistence } from "@/lib/agent/persistence";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StateArtifactResponse = {
  id: string;
  type: string;
  data: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ chatId: string }> | { chatId: string } }
) {
  const params = await ctx.params;
  const chatId = typeof params?.chatId === "string" ? params.chatId : "";
  if (!chatId) {
    return Response.json(
      { artifacts: [] satisfies StateArtifactResponse[], canvasTimeline: [] as unknown[], phase: null },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const authedUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!authedUserId) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Ensure the requesting user owns this chat.
  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .eq("user_id", authedUserId)
    .maybeSingle();

  if (chatErr || !chatRow) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const state = await AgentPersistence.loadState(chatId);
  if (!state) {
    return Response.json({
      artifacts: [] satisfies StateArtifactResponse[],
      canvasTimeline: [] as unknown[],
      phase: null,
    });
  }

  const artifacts: StateArtifactResponse[] = Array.isArray(state.artifacts)
    ? state.artifacts
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
          id: String((a as { id?: unknown }).id ?? ""),
          type: String((a as { type?: unknown }).type ?? ""),
          data: (a as { content?: unknown }).content,
          createdAt: typeof (a as { createdAt?: unknown }).createdAt === "string"
            ? (a as { createdAt?: string }).createdAt
            : undefined,
          updatedAt: typeof (a as { updatedAt?: unknown }).updatedAt === "string"
            ? (a as { updatedAt?: string }).updatedAt
            : undefined,
        }))
        .filter((a) => a.id.trim().length > 0)
    : [];

  const canvasTimeline = Array.isArray((state as { ui?: { canvasTimeline?: unknown } })?.ui?.canvasTimeline)
    ? ((state as { ui?: { canvasTimeline?: unknown[] } })?.ui?.canvasTimeline ?? [])
    : [];

  const contextUsage = (state as { ui?: { contextUsage?: unknown } })?.ui?.contextUsage ?? null;
  const phase =
    typeof (state as { phase?: unknown })?.phase === "string"
      ? (state as { phase: string }).phase
      : null;

  return Response.json({ artifacts, canvasTimeline, contextUsage, phase });
}

