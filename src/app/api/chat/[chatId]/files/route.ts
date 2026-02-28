import { NextRequest } from "next/server";

import { AgentPersistence } from "@/lib/agent/persistence";
import {
  headStorageObject,
  listStorageObjects,
  uploadStorageObject,
  type ListedStorageObject,
} from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FileItem = {
  bucket: "uploads" | "artifacts";
  storagePath: string;
  name: string;
  size?: number;
  lastModified?: string;
};

function safeStorageSegment(value: string, fallback: string): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function shouldMirrorArtifact(artifactId: string): boolean {
  const id = artifactId.trim().toLowerCase();
  if (!id) return false;
  if (id === "sandbox" || id === "training" || id === "intent") return false;
  return true;
}

function encodeArtifactSnapshot(artifactId: string, artifactType: string, content: unknown): {
  ext: "md" | "json";
  body: Buffer;
  contentType: string;
} {
  if (typeof content === "string") {
    return {
      ext: "md",
      body: Buffer.from(content, "utf-8"),
      contentType: "text/markdown; charset=utf-8",
    };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(
      {
        artifactId,
        artifactType,
        content,
      },
      null,
      2
    );
  } catch {
    serialized = JSON.stringify(
      {
        artifactId,
        artifactType,
        content: String(content),
      },
      null,
      2
    );
  }
  return {
    ext: "json",
    body: Buffer.from(serialized, "utf-8"),
    contentType: "application/json; charset=utf-8",
  };
}

async function backfillRuntimeArtifactSnapshots(chatId: string) {
  try {
    const state = await AgentPersistence.loadState(chatId);
    const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.id !== "string") continue;
      if (!shouldMirrorArtifact(artifact.id)) continue;
      const snapshot = encodeArtifactSnapshot(
        artifact.id,
        typeof artifact.type === "string" ? artifact.type : "markdown",
        artifact.content
      );
      const fileId = safeStorageSegment(artifact.id, "artifact");
      const storagePath = `runner-outputs/${chatId}/runtime/artifacts/${fileId}.${snapshot.ext}`;
      try {
        await headStorageObject("artifacts", storagePath);
      } catch {
        await uploadStorageObject("artifacts", storagePath, snapshot.body, {
          contentType: snapshot.contentType,
        });
      }
    }
  } catch {
    // Best-effort only; listing should still succeed when backfill fails.
  }
}

function keyToName(key: string): string {
  const parts = key.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : key;
}

function normalize(bucket: FileItem["bucket"], item: ListedStorageObject): FileItem | null {
  const key = item.key.trim();
  if (!key) return null;
  if (key.endsWith("/")) return null;
  return {
    bucket,
    storagePath: key,
    name: keyToName(key),
    size: item.size,
    lastModified: item.lastModified,
  };
}

function sortByLastModifiedDesc(items: FileItem[]): FileItem[] {
  return [...items].sort((a, b) => {
    const ta = a.lastModified ? Date.parse(a.lastModified) : 0;
    const tb = b.lastModified ? Date.parse(b.lastModified) : 0;
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name);
  });
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ chatId: string }> | { chatId: string } }
) {
  const params = await ctx.params;
  const chatId = typeof params?.chatId === "string" ? params.chatId.trim() : "";
  if (!chatId) {
    return Response.json({ error: "Missing chatId" }, { status: 400 });
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

  try {
    await backfillRuntimeArtifactSnapshots(chatId);

    const uploadsPrefix = `${user.id}/${chatId}/`;
    const uploadsRaw = await listStorageObjects("uploads", uploadsPrefix);
    const uploads = sortByLastModifiedDesc(
      uploadsRaw.map((item) => normalize("uploads", item)).filter(Boolean) as FileItem[]
    );

    const exportsRaw = await listStorageObjects("artifacts", `exports/${chatId}/`);
    const runnerRaw = await listStorageObjects("artifacts", `runner-outputs/${chatId}/`);
    const outputs = sortByLastModifiedDesc(
      [...exportsRaw, ...runnerRaw]
        .map((item) => normalize("artifacts", item))
        .filter(Boolean) as FileItem[]
    );

    return Response.json({ uploads, outputs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list chat files";
    return Response.json({ error: message }, { status: 500 });
  }
}

