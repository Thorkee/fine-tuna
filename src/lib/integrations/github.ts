import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type GithubPublishMode = "pr" | "direct";

export type GithubRepoConnection = {
  id: string;
  userId: string;
  repoFullName: string;
  isPrivate: boolean;
  baseBranch: string;
  workBranch: string;
  defaultPublishMode: GithubPublishMode;
};

type GithubRepoConnectionRow = {
  id: string;
  user_id: string;
  repo_full_name: string;
  is_private: boolean;
  base_branch: string;
  work_branch: string;
  default_publish_mode: GithubPublishMode;
};

type GithubPullRequestResponse = {
  html_url?: string;
  number?: number;
};

function toConnection(row: GithubRepoConnectionRow): GithubRepoConnection {
  return {
    id: row.id,
    userId: row.user_id,
    repoFullName: row.repo_full_name,
    isPrivate: Boolean(row.is_private),
    baseBranch: row.base_branch,
    workBranch: row.work_branch,
    defaultPublishMode: row.default_publish_mode === "direct" ? "direct" : "pr",
  };
}

function parseRepoOwnerAndName(repoFullName: string): { owner: string; repo: string } | null {
  const normalized = normalizeGithubRepoFullName(repoFullName);
  if (!normalized) return null;
  const [owner, repo] = normalized.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function githubApi<T>(args: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  body?: Record<string, unknown>;
}): Promise<T> {
  const { token, owner, repo, path, method = "GET", body } = args;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }
  );
  const payload = (await response.json().catch(() => null)) as
    | (T & { message?: string; errors?: Array<{ message?: string }> })
    | null;
  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.errors?.[0]?.message ||
      `GitHub API request failed (${response.status})`;
    throw new Error(message);
  }
  return (payload ?? ({} as T)) as T;
}

export function normalizeGithubRepoFullName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return "";
  return trimmed;
}

export async function getGithubRepoConnectionForUser(args: {
  userId: string;
  connectionId?: string;
  repoFullName?: string;
}): Promise<GithubRepoConnection | null> {
  const userId = args.userId.trim();
  if (!userId) return null;

  const admin = createAdminClient();
  let query = admin
    .from("integration_repo_connections")
    .select("id, user_id, repo_full_name, is_private, base_branch, work_branch, default_publish_mode")
    .eq("user_id", userId)
    .eq("provider", "github");

  const connectionId = typeof args.connectionId === "string" ? args.connectionId.trim() : "";
  const repoFullName = normalizeGithubRepoFullName(args.repoFullName ?? "");
  if (connectionId) {
    query = query.eq("id", connectionId);
  } else if (repoFullName) {
    query = query.eq("repo_full_name", repoFullName);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) return null;
  return toConnection(data as GithubRepoConnectionRow);
}

export async function ensureGithubPullRequest(args: {
  token: string;
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body?: string;
  draft?: boolean;
}): Promise<{ url: string; number: number | null; existing: boolean }> {
  const parsed = parseRepoOwnerAndName(args.repoFullName);
  if (!parsed) {
    throw new Error("repoFullName must be in owner/repo format.");
  }
  const { owner, repo } = parsed;
  const baseBranch = args.baseBranch.trim() || "main";
  const headBranch = args.headBranch.trim();
  if (!headBranch) {
    throw new Error("headBranch is required to open a pull request.");
  }

  const existing = await githubApi<GithubPullRequestResponse[]>({
    token: args.token,
    owner,
    repo,
    path: `/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}&base=${encodeURIComponent(
      baseBranch
    )}&per_page=1`,
  });
  const existingPr = Array.isArray(existing) ? existing[0] : undefined;
  if (existingPr?.html_url) {
    return { url: existingPr.html_url, number: existingPr.number ?? null, existing: true };
  }

  const created = await githubApi<GithubPullRequestResponse>({
    token: args.token,
    owner,
    repo,
    path: "/pulls",
    method: "POST",
    body: {
      title: args.title.trim() || `Update ${headBranch}`,
      head: headBranch,
      base: baseBranch,
      body: args.body?.trim() || undefined,
      draft: Boolean(args.draft),
    },
  });
  if (!created?.html_url) {
    throw new Error("Pull request created but no URL was returned.");
  }
  return { url: created.html_url, number: created.number ?? null, existing: false };
}

