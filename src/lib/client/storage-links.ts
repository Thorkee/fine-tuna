"use client";

export type StorageBucket = "uploads" | "artifacts" | "runner-artifacts";

export function parseSupabaseStorageUrl(rawUrl: string): { bucket: StorageBucket; storagePath: string } | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const validBuckets = new Set<StorageBucket>(["uploads", "artifacts", "runner-artifacts"]);

  // S3-compat: {endpoint}/storage/v1/s3/{bucket}/{key}
  const s3Match = url.pathname.match(/\/storage\/v1\/s3\/([^/]+)\/(.+)/);
  if (s3Match) {
    const bucket = s3Match[1] as StorageBucket;
    const storagePath = s3Match[2];
    if (validBuckets.has(bucket) && typeof storagePath === "string" && storagePath.trim()) {
      return { bucket, storagePath };
    }
  }

  // Object API: /storage/v1/object/public/{bucket}/{key} or /storage/v1/object/sign/{bucket}/{key}
  const objectMatch = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)/);
  if (objectMatch) {
    const bucket = objectMatch[1] as StorageBucket;
    const storagePath = objectMatch[2];
    if (validBuckets.has(bucket) && typeof storagePath === "string" && storagePath.trim()) {
      return { bucket, storagePath };
    }
  }

  return null;
}

export function looksLikeImageUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;
  const base = rawUrl.split(/[?#]/)[0] ?? "";
  return Boolean(base && /\.(png|jpe?g|gif|webp|avif)$/i.test(base));
}

export function fileNameFromUrl(rawUrl: string): string {
  const input = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!input) return "file";
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "file";
    return decodeURIComponent(last) || "file";
  } catch {
    const base = input.split(/[?#]/)[0] ?? input;
    const parts = base.split("/").filter(Boolean);
    return (parts[parts.length - 1] ?? "file").trim() || "file";
  }
}

function isAlreadySigned(url: URL): boolean {
  const sp = url.searchParams;
  return (
    sp.has("X-Amz-Signature") ||
    sp.has("X-Amz-Credential") ||
    sp.has("X-Amz-Algorithm") ||
    sp.has("token") ||
    sp.has("signature")
  );
}

function inferChatIdFromStoragePath(bucket: StorageBucket, storagePath: string): string | null {
  const parts = String(storagePath || "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (bucket === "artifacts") {
    // exports/{chatId}/... or runner-outputs/{chatId}/...
    if (parts[0] === "exports" || parts[0] === "runner-outputs") {
      return parts[1] ?? null;
    }
    return null;
  }
  // uploads: {userId}/{chatId}/...
  return parts[1] ?? null;
}

async function tryFetchSignedUrl(args: {
  chatId: string;
  bucket: StorageBucket;
  storagePath: string;
  ttlSeconds?: number;
}): Promise<string | null> {
  try {
    const resp = await fetch("/api/storage/signed-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: args.chatId,
        bucket: args.bucket,
        storagePath: args.storagePath,
        ttlSeconds: args.ttlSeconds,
      }),
    });
    const data = (await resp.json().catch(() => null)) as { url?: string } | null;
    if (!resp.ok) return null;
    if (!data?.url || typeof data.url !== "string") return null;
    return data.url;
  } catch {
    return null;
  }
}

export async function resolveSignedStorageUrl(
  rawUrl: string,
  opts: { chatId?: string; ttlSeconds?: number } = {}
): Promise<string> {
  const input = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!input) return rawUrl;

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(input);
  } catch {
    parsedUrl = null;
  }

  if (parsedUrl && isAlreadySigned(parsedUrl)) {
    return input;
  }

  const storage = parseSupabaseStorageUrl(input);
  if (!storage) return input;

  const inferredChatId = inferChatIdFromStoragePath(storage.bucket, storage.storagePath);
  const candidates = [opts.chatId, inferredChatId]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  const uniqueChatIds = Array.from(new Set(candidates));
  if (uniqueChatIds.length === 0) return input;

  for (const chatId of uniqueChatIds) {
    const signed = await tryFetchSignedUrl({
      chatId,
      bucket: storage.bucket,
      storagePath: storage.storagePath,
      ttlSeconds: opts.ttlSeconds,
    });
    if (signed) return signed;
  }

  return input;
}

export async function openUrlInNewTab(
  rawUrl: string,
  opts: { chatId?: string; ttlSeconds?: number } = {}
): Promise<void> {
  const input = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!input) return;

  // Open synchronously to avoid popup blockers, then navigate once we have a signed URL.
  const tab = window.open("", "_blank");
  if (tab) {
    try {
      tab.opener = null;
      tab.document.title = "Loading…";
      tab.document.body.innerHTML =
        '<div style="font-family: ui-sans-serif, system-ui; padding: 24px;">Loading…</div>';
    } catch {
      // ignore
    }
  }

  const finalUrl = await resolveSignedStorageUrl(input, opts);

  if (tab) {
    try {
      tab.location.href = finalUrl;
      return;
    } catch {
      // ignore fallthrough
    }
  }

  window.open(finalUrl, "_blank", "noopener,noreferrer");
}

