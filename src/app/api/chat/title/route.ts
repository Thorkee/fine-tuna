import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import type { ProjectContext, ProjectMode } from "@/types";
import { parseProfileContext, resolvePreferredMode } from "@/lib/profile/profile-context";
import { getLlmRuntime } from "@/lib/llm/runtime";
import { getConfiguredLlmProvider } from "@/lib/llm/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeGeneratedTitle(raw: string): string {
  const cleaned = (raw || "").trim();
  if (!cleaned) return "New chat";

  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Prefer first non-code-fence line.
  let title = (lines.find((l) => !l.startsWith("```")) || lines[0] || "").trim();

  // Strip wrapping quotes.
  title = title.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();

  // Strip common prefixes like "Title:".
  title = title.replace(/^(title|workload)\s*:\s*/i, "").trim();

  // Collapse whitespace + remove trailing punctuation.
  title = title.replace(/\s+/g, " ").replace(/[.?!:;,\s]+$/, "").trim();

  const MAX = 80;
  if (title.length > MAX) title = title.slice(0, MAX).trim();

  return title || "New chat";
}

export async function POST(req: NextRequest) {
  const payload: unknown = await req.json().catch(() => null);
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return Response.json({ title: "New chat" });

  const filesRaw = body?.files;
  const files = Array.isArray(filesRaw)
    ? filesRaw.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 8)
    : [];

  const chatId =
    typeof body?.chatId === "string" && body.chatId.trim().length > 0 ? body.chatId.trim() : undefined;

  try {
    const supabase = await createClient();
    const authedUserId = (await supabase.auth.getUser()).data.user?.id;
    let userProfile: ProjectContext["userProfile"] | undefined;
    let preferredMode: ProjectMode | null = null;
    if (authedUserId) {
      const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("full_name, preferences")
        .eq("id", authedUserId)
        .maybeSingle();
      if (profileErr) {
        console.error("Failed to load user profile:", profileErr.message);
      } else if (profile) {
        const parsed = parseProfileContext(profile);
        preferredMode = parsed.preferredMode;
        userProfile = parsed.userProfile;
      }
    }

    const context: ProjectContext = {
      projectId: chatId || randomUUID(),
      userId: authedUserId || "demo-user",
      mode: resolvePreferredMode(preferredMode),
      createdAt: new Date(),
      userProfile,
      dataContext: null,
      edaContext: null,
      goalContext: null,
      preparationContext: null,
      providerContext: null,
      trainingContext: null,
      exportContext: null,
    };

    const fileList = files.length > 0 ? `\n\nAttached files:\n- ${files.join("\n- ")}` : "";
    const titlePrompt = [
      "Generate a concise workload title for this chat.",
      "Rules:",
      "- 3 to 7 words",
      "- Title Case",
      "- No quotes",
      "- No trailing punctuation",
      "- Output ONLY the title text",
      "",
      "User request:",
      prompt.slice(0, 1200),
      fileList,
    ]
      .filter(Boolean)
      .join("\n");

    const llm = getLlmRuntime(getConfiguredLlmProvider());
    const raw = await llm.chat([{ role: "user", content: titlePrompt }], context, {
      temperature: 0.2,
      maxTokens: 32,
    });

    return Response.json({ title: sanitizeGeneratedTitle(raw) });
  } catch (error) {
    console.error("Failed to generate chat title:", error);
    return Response.json({ title: "New chat" }, { status: 200 });
  }
}

