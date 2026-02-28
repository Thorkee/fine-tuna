import { NextRequest } from "next/server";
import path from "path";

import { createStorageSignedUrl, uploadStorageObject } from "@/lib/supabase/storage";
import { createClient } from "@/lib/supabase/server";
import { maybeBillSandboxSession } from "@/lib/billing/e2b-session-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRunnerConfig() {
  const baseUrl = (process.env.E2B_RUNNER_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("E2B_RUNNER_URL is not configured");
  }
  const token = (process.env.E2B_RUNNER_TOKEN || "").trim();
  return { baseUrl, token };
}

function buildAuthHeaders(token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

const SANDBOX_READ_ROOTS = ["/code", "/pipelines"] as const;

function isSafeSandboxReadPath(value: string): boolean {
  const p = value.trim();
  if (!p) return false;
  if (p.includes("\0")) return false;
  if (p.split("/").includes("..")) return false;
  return SANDBOX_READ_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "file";
  return trimmed.replace(/[^a-z0-9_.-]+/gi, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function maxBytes(): number {
  return (
    parsePositiveInt(process.env.FILES_DRAWER_MAX_PERSIST_BYTES) ??
    parsePositiveInt(process.env.RUNNER_MAX_FILE_BYTES) ??
    20_000_000
  );
}

function signedUrlTtlSeconds(): number {
  return parsePositiveInt(process.env.FILES_DRAWER_SIGNED_URL_TTL_SECONDS) ?? 600;
}

function maxPersistFiles(): number {
  return parsePositiveInt(process.env.FILES_DRAWER_MAX_PERSIST_FILES) ?? 1000;
}

function maxPersistTreeBytes(): number {
  return parsePositiveInt(process.env.FILES_DRAWER_MAX_PERSIST_TREE_BYTES) ?? 100_000_000;
}

function normalizeStoragePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new Error("targetPrefix cannot include '..'");
  }
  return parts.map((segment) => safeFileName(segment)).filter(Boolean).join("/");
}

function isDirType(value: unknown): boolean {
  const type = typeof value === "string" ? value.toLowerCase() : "";
  return type.includes("dir");
}

type RunnerListItem = {
  path?: string;
  type?: string;
  size?: number;
};

async function runnerListPath(args: {
  baseUrl: string;
  token?: string;
  sessionId: string;
  listPath: string;
}): Promise<RunnerListItem[]> {
  const qp = new URLSearchParams({ path: args.listPath });
  const url = `${args.baseUrl}/sessions/${encodeURIComponent(args.sessionId)}/files?${qp.toString()}`;
  const resp = await fetch(url, { headers: buildAuthHeaders(args.token) });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(text || `Runner list files failed (${resp.status})`);
  }
  let parsed: { items?: RunnerListItem[] } | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as { items?: RunnerListItem[] };
    } catch {
      parsed = null;
    }
  }
  return Array.isArray(parsed?.items) ? parsed.items : [];
}

async function runnerReadFile(args: {
  baseUrl: string;
  token?: string;
  sessionId: string;
  filePath: string;
}): Promise<Buffer> {
  const qp = new URLSearchParams({ path: args.filePath });
  const url = `${args.baseUrl}/sessions/${encodeURIComponent(args.sessionId)}/files/content?${qp.toString()}`;
  const resp = await fetch(url, { headers: buildAuthHeaders(args.token) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Runner file download failed (${resp.status})`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function collectRecursiveFiles(args: {
  baseUrl: string;
  token?: string;
  sessionId: string;
  rootPath: string;
}): Promise<Array<{ sandboxPath: string; relativePath: string; size?: number }>> {
  const visited = new Set<string>();
  const queue = [args.rootPath];
  const files: Array<{ sandboxPath: string; relativePath: string; size?: number }> = [];
  const fileLimit = maxPersistFiles();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const items = await runnerListPath({
      baseUrl: args.baseUrl,
      token: args.token,
      sessionId: args.sessionId,
      listPath: current,
    });

    for (const item of items) {
      const p = typeof item.path === "string" ? item.path.trim() : "";
      if (!p || !isSafeSandboxReadPath(p)) continue;
      if (isDirType(item.type)) {
        if (!visited.has(p)) queue.push(p);
        continue;
      }
      const relRaw = p.startsWith(`${args.rootPath}/`) ? p.slice(args.rootPath.length + 1) : path.posix.basename(p);
      const relParts = relRaw
        .split("/")
        .filter(Boolean)
        .map((part) => safeFileName(part))
        .filter(Boolean);
      const relativePath = relParts.length > 0 ? relParts.join("/") : safeFileName(path.posix.basename(p) || "file");
      files.push({ sandboxPath: p, relativePath, size: typeof item.size === "number" ? item.size : undefined });
      if (files.length > fileLimit) {
        throw new Error(`Too many files to persist (max ${fileLimit})`);
      }
    }
  }
  return files;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> | { sessionId: string } }
) {
  const params = await ctx.params;
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId")?.trim();
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId.trim() : "";
  if (!chatId || !sessionId) {
    return Response.json({ error: "Missing chatId or sessionId" }, { status: 400 });
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

  const payload = (await req.json().catch(() => null)) as unknown;
  const body = isRecord(payload) ? payload : null;
  const sandboxPath = body && typeof body.sandboxPath === "string" ? body.sandboxPath.trim() : "";
  const targetBucketRaw = body && typeof body.targetBucket === "string" ? body.targetBucket.trim() : "";
  const fileNameRaw = body && typeof body.fileName === "string" ? body.fileName.trim() : "";
  const targetPrefixRaw = body && typeof body.targetPrefix === "string" ? body.targetPrefix.trim() : "";
  const recursive = body?.recursive === true;

  const targetBucket = targetBucketRaw === "uploads" ? "uploads" : "artifacts";
  if (!sandboxPath) {
    return Response.json({ error: "Missing sandboxPath" }, { status: 400 });
  }
  if (!isSafeSandboxReadPath(sandboxPath)) {
    return Response.json({ error: "Invalid sandboxPath" }, { status: 400 });
  }
  let normalizedTargetPrefix = "";
  try {
    normalizedTargetPrefix = normalizeStoragePrefix(targetPrefixRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid targetPrefix";
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const { baseUrl, token } = getRunnerConfig();
    const billing = await maybeBillSandboxSession({
      userId: user.id,
      chatId,
      sessionId,
    });
    if (billing?.blocked === "insufficient_credits") {
      return Response.json({ error: "insufficient_credits" }, { status: 402 });
    }

    const stamp = Date.now();
    const maxSingleBytes = maxBytes();

    if (recursive) {
      const defaultTreeName = safeFileName(path.posix.basename(sandboxPath) || "sandbox-tree");
      const basePrefix =
        targetBucket === "uploads"
          ? normalizedTargetPrefix
            ? `${user.id}/${chatId}/${normalizedTargetPrefix}`
            : `${user.id}/${chatId}/sandbox-outputs/${sessionId}/${stamp}-${defaultTreeName}`
          : normalizedTargetPrefix
            ? `runner-outputs/${chatId}/${normalizedTargetPrefix}`
            : `runner-outputs/${chatId}/sandbox/${sessionId}/${stamp}-${defaultTreeName}`;

      const files = await collectRecursiveFiles({
        baseUrl,
        token,
        sessionId,
        rootPath: sandboxPath,
      });
      if (files.length === 0) {
        return Response.json({ error: "No files found under sandboxPath" }, { status: 400 });
      }

      let totalBytes = 0;
      const treeBytesLimit = maxPersistTreeBytes();
      const persisted: Array<{ sandboxPath: string; storagePath: string; size: number }> = [];
      for (const file of files) {
        const buffer = await runnerReadFile({
          baseUrl,
          token,
          sessionId,
          filePath: file.sandboxPath,
        });
        if (buffer.byteLength > maxSingleBytes) {
          return Response.json(
            { error: `File too large to persist: ${file.sandboxPath} (max ${maxSingleBytes} bytes)` },
            { status: 413 }
          );
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > treeBytesLimit) {
          return Response.json(
            { error: `Persist tree too large (max ${treeBytesLimit} bytes total)` },
            { status: 413 }
          );
        }

        const storagePath = `${basePrefix}/${file.relativePath}`;
        await uploadStorageObject(targetBucket, storagePath, buffer, {
          contentType: "application/octet-stream",
        });
        persisted.push({ sandboxPath: file.sandboxPath, storagePath, size: buffer.byteLength });
      }

      return Response.json({
        bucket: targetBucket,
        rootPath: sandboxPath,
        basePrefix,
        count: persisted.length,
        totalBytes,
        persisted,
      });
    }

    const derivedName = sandboxPath.split("/").pop() || "file";
    const fileName = safeFileName(fileNameRaw || derivedName);
    const storagePath =
      targetBucket === "uploads"
        ? normalizedTargetPrefix
          ? `${user.id}/${chatId}/${normalizedTargetPrefix}/${fileName}`
          : `${user.id}/${chatId}/sandbox-outputs/${sessionId}/${stamp}-${fileName}`
        : normalizedTargetPrefix
          ? `runner-outputs/${chatId}/${normalizedTargetPrefix}/${fileName}`
          : `runner-outputs/${chatId}/sandbox/${sessionId}/${stamp}-${fileName}`;

    const buffer = await runnerReadFile({
      baseUrl,
      token,
      sessionId,
      filePath: sandboxPath,
    });
    if (buffer.byteLength > maxSingleBytes) {
      return Response.json({ error: `File too large (max ${maxSingleBytes} bytes)` }, { status: 413 });
    }
    await uploadStorageObject(targetBucket, storagePath, buffer, {
      contentType: "application/octet-stream",
    });
    const signedUrl = await createStorageSignedUrl(targetBucket, storagePath, signedUrlTtlSeconds());
    return Response.json({ bucket: targetBucket, storagePath, url: signedUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Persist from sandbox failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

