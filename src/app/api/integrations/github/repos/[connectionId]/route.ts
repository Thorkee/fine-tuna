import "server-only";

import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PublishMode = "pr" | "direct";

type RepoConnectionRow = {
  id: string;
  provider: string;
  repo_full_name: string;
  is_private: boolean;
  base_branch: string;
  work_branch: string;
  default_publish_mode: PublishMode;
  created_at: string;
  updated_at: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeRepoFullName(value: unknown): string | null {
  if (value === undefined) return null;
  const repo = typeof value === "string" ? value.trim() : "";
  if (!repo) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return repo;
}

function normalizeBranch(value: unknown): string | null {
  if (value === undefined) return null;
  const branch = typeof value === "string" ? value.trim() : "";
  if (!branch || branch.includes(" ") || branch.includes("..")) return null;
  return branch;
}

function normalizePublishMode(value: unknown): PublishMode | null {
  if (value === undefined) return null;
  if (value === "pr" || value === "direct") return value;
  return null;
}

function toRepoResponse(row: RepoConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    repoFullName: row.repo_full_name,
    isPrivate: Boolean(row.is_private),
    baseBranch: row.base_branch,
    workBranch: row.work_branch,
    defaultPublishMode: row.default_publish_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireUser() {
  const supabase = await createClient();
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) return { supabase, user: null as null };
  return { supabase, user };
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ connectionId: string }> | { connectionId: string } }
) {
  const params = await ctx.params;
  const connectionId = typeof params?.connectionId === "string" ? params.connectionId.trim() : "";
  if (!isUuid(connectionId)) {
    return Response.json({ error: "Invalid connectionId" }, { status: 400 });
  }

  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const payload = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const updatePayload: Record<string, unknown> = {};

  const repoFullName = normalizeRepoFullName(payload?.repoFullName);
  if (payload?.repoFullName !== undefined && !repoFullName) {
    return Response.json({ error: "repoFullName must be in owner/repo format" }, { status: 400 });
  }
  if (repoFullName) updatePayload.repo_full_name = repoFullName;

  const baseBranch = normalizeBranch(payload?.baseBranch);
  if (payload?.baseBranch !== undefined && !baseBranch) {
    return Response.json({ error: "Invalid baseBranch" }, { status: 400 });
  }
  if (baseBranch) updatePayload.base_branch = baseBranch;

  const workBranch = normalizeBranch(payload?.workBranch);
  if (payload?.workBranch !== undefined && !workBranch) {
    return Response.json({ error: "Invalid workBranch" }, { status: 400 });
  }
  if (workBranch) updatePayload.work_branch = workBranch;

  const mode = normalizePublishMode(payload?.defaultPublishMode);
  if (payload?.defaultPublishMode !== undefined && !mode) {
    return Response.json({ error: "Invalid defaultPublishMode" }, { status: 400 });
  }
  if (mode) updatePayload.default_publish_mode = mode;

  if (payload?.isPrivate !== undefined) {
    updatePayload.is_private = Boolean(payload.isPrivate);
  }

  if (Object.keys(updatePayload).length === 0) {
    return Response.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("integration_repo_connections")
    .update(updatePayload)
    .eq("id", connectionId)
    .eq("user_id", user.id)
    .eq("provider", "github")
    .select(
      "id, provider, repo_full_name, is_private, base_branch, work_branch, default_publish_mode, created_at, updated_at"
    )
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message || "Failed to update repo connection" }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Repo connection not found" }, { status: 404 });
  }

  return Response.json({ repo: toRepoResponse(data as RepoConnectionRow) });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ connectionId: string }> | { connectionId: string } }
) {
  const params = await ctx.params;
  const connectionId = typeof params?.connectionId === "string" ? params.connectionId.trim() : "";
  if (!isUuid(connectionId)) {
    return Response.json({ error: "Invalid connectionId" }, { status: 400 });
  }

  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: existing, error: existingError } = await supabase
    .from("integration_repo_connections")
    .select("id")
    .eq("id", connectionId)
    .eq("user_id", user.id)
    .eq("provider", "github")
    .maybeSingle();

  if (existingError) {
    return Response.json({ error: existingError.message || "Failed to delete repo connection" }, { status: 500 });
  }
  if (!existing) {
    return Response.json({ error: "Repo connection not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("integration_repo_connections")
    .delete()
    .eq("id", connectionId)
    .eq("user_id", user.id)
    .eq("provider", "github");

  if (error) {
    return Response.json({ error: error.message || "Failed to delete repo connection" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

