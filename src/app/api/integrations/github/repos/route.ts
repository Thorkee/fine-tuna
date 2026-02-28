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

function normalizeRepoFullName(value: unknown): string {
  const repo = typeof value === "string" ? value.trim() : "";
  if (!repo) return "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
  return repo;
}

function normalizeBranch(value: unknown, fallback: string): string {
  const branch = typeof value === "string" ? value.trim() : "";
  if (!branch) return fallback;
  if (branch.includes(" ") || branch.includes("..")) return fallback;
  return branch;
}

function normalizePublishMode(value: unknown): PublishMode {
  return value === "direct" ? "direct" : "pr";
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

export async function GET() {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("integration_repo_connections")
    .select(
      "id, provider, repo_full_name, is_private, base_branch, work_branch, default_publish_mode, created_at, updated_at"
    )
    .eq("user_id", user.id)
    .eq("provider", "github")
    .order("updated_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message || "Failed to list repo connections" }, { status: 500 });
  }

  const rows = (Array.isArray(data) ? data : []) as RepoConnectionRow[];
  return Response.json({ repos: rows.map(toRepoResponse) });
}

export async function POST(req: NextRequest) {
  const { supabase, user } = await requireUser();
  if (!user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const payload = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const repoFullName = normalizeRepoFullName(payload?.repoFullName);
  if (!repoFullName) {
    return Response.json({ error: "repoFullName must be in owner/repo format" }, { status: 400 });
  }

  const insertPayload = {
    user_id: user.id,
    provider: "github",
    repo_full_name: repoFullName,
    is_private: Boolean(payload?.isPrivate),
    base_branch: normalizeBranch(payload?.baseBranch, "main"),
    work_branch: normalizeBranch(payload?.workBranch, "tuna"),
    default_publish_mode: normalizePublishMode(payload?.defaultPublishMode),
  };

  const { data, error } = await supabase
    .from("integration_repo_connections")
    .upsert(insertPayload, { onConflict: "user_id,provider,repo_full_name" })
    .select(
      "id, provider, repo_full_name, is_private, base_branch, work_branch, default_publish_mode, created_at, updated_at"
    )
    .single();

  if (error || !data) {
    return Response.json({ error: error?.message || "Failed to save repo connection" }, { status: 500 });
  }

  return Response.json({ repo: toRepoResponse(data as RepoConnectionRow) });
}

