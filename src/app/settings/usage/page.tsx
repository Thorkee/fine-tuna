import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UsageSearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function parseSignedCredits(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseBalance(value: unknown): number {
  return Math.max(0, parseSignedCredits(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCreditSummary(value: unknown): { base: number; daily: number; total: number } {
  if (!isRecord(value)) {
    return { base: 0, daily: 0, total: 0 };
  }
  const base = parseBalance(value.credits_balance);
  const daily = parseBalance(value.daily_credits_balance);
  const total =
    typeof value.total_credits === "number" || typeof value.total_credits === "string"
      ? parseBalance(value.total_credits)
      : base + daily;
  return { base, daily, total };
}

function formatCredits(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return `${Math.round(value)}`;
  if (abs < 1_000_000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  const m = value / 1_000_000;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString();
}

type LedgerEntry = {
  id: string;
  entry_type: string;
  source?: string | null;
  amount: number | string;
  created_at?: string | null;
  chat_id?: string | null;
  chats?: { title?: string | null } | Array<{ title?: string | null }> | null;
};

function buildUsageHref(page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 50) params.set("pageSize", String(pageSize));
  const qs = params.toString();
  return qs ? `/settings/usage?${qs}` : "/settings/usage";
}

export default async function UsagePage({ searchParams }: { searchParams?: UsageSearchParams }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  if (!user) {
    return (
      <div className="min-h-dvh bg-primary px-4 sm:px-6 py-6 sm:py-10 text-primary">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-2xl font-semibold">Usage</h1>
          <p className="mt-3 text-sm text-muted">Please sign in to view your usage.</p>
        </div>
      </div>
    );
  }

  const { data: summaryRaw, error: summaryErr } = await supabase.rpc("get_credit_summary");
  let balance = 0;
  let dailyCredits = 0;
  if (summaryErr) {
    const { data: balanceRaw } = await supabase.rpc("get_credit_balance");
    balance = parseBalance(balanceRaw);
  } else {
    const summary = parseCreditSummary(summaryRaw);
    balance = summary.base;
    dailyCredits = summary.daily;
  }

  const page = parsePositiveInt(firstParam(searchParams?.page), 1);
  const pageSize = Math.min(200, parsePositiveInt(firstParam(searchParams?.pageSize), 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: ledger, count: ledgerCount } = await supabase
    .from("credit_ledger")
    .select("id, entry_type, source, amount, created_at, chat_id, chats(title)", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);
  const ledgerRows = (ledger ?? []) as LedgerEntry[];
  const total = typeof ledgerCount === "number" ? ledgerCount : null;
  const hasMore = total !== null ? from + ledgerRows.length < total : ledgerRows.length === pageSize;

  return (
    <div className="min-h-dvh bg-primary px-4 sm:px-6 py-6 sm:py-10 text-primary">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Usage</h1>
        </div>

        <div className="rounded-xl border border-default p-5 bg-elevated">
          <div className="text-xs uppercase tracking-wide text-muted">Current balance</div>
          <div className="mt-2 text-3xl font-semibold">{formatCredits(balance)} credits</div>
        </div>

        <div className="rounded-xl border border-default p-5 bg-elevated">
          <div className="text-xs uppercase tracking-wide text-muted">Daily refresh credits</div>
          <div className="mt-2 text-3xl font-semibold">{formatCredits(dailyCredits)} credits</div>
        </div>

        <div className="rounded-xl border border-default p-5 bg-elevated">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold">Activity</div>
            {total !== null ? (
              <div className="text-xs text-muted">
                Showing {ledgerRows.length > 0 ? from + 1 : 0}–{ledgerRows.length > 0 ? from + ledgerRows.length : 0} of {total}
              </div>
            ) : null}
          </div>
          <div className="mt-3 divide-y divide-[hsl(var(--border-default))]">
            {ledgerRows.length > 0 ? (
              ledgerRows.map((entry) => {
                const amount = parseSignedCredits(entry.amount);
                const isNegative = amount < 0 || entry.entry_type === "usage" || entry.entry_type === "expire";
                const chatTitle = Array.isArray(entry.chats)
                  ? entry.chats[0]?.title ?? ""
                  : entry.chats?.title ?? "";
                const typeLabel =
                  entry.entry_type === "usage"
                    ? "Usage"
                    : entry.entry_type === "grant"
                      ? "Grant"
                      : entry.entry_type === "refund"
                        ? "Refund"
                        : entry.entry_type === "adjustment"
                          ? "Adjustment"
                          : entry.entry_type === "expire"
                            ? "Expiration"
                            : entry.entry_type;
                const labelParts = [
                  typeLabel,
                  entry.source ? `(${entry.source})` : "",
                ].filter(Boolean);
                const detail = chatTitle || labelParts.join(" ");
                return (
                  <div key={entry.id} className="flex items-center justify-between py-3 text-sm">
                    <div>
                      <div className="font-medium">
                        {entry.chat_id && chatTitle ? (
                          <Link href={`/${entry.chat_id}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {detail}
                          </Link>
                        ) : (
                          detail
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        {formatTimestamp(entry.created_at)}
                      </div>
                    </div>
                    <div className={isNegative ? "text-red-600" : "text-emerald-700"}>
                      {isNegative ? "-" : "+"}
                      {formatCredits(Math.abs(amount))}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-6 text-sm text-muted">No activity yet.</div>
            )}
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            {page > 1 ? (
              <Link
                href={buildUsageHref(page - 1, pageSize)}
                className="rounded-md border border-default px-3 py-1.5 text-sm hover:bg-tertiary"
              >
                Newer
              </Link>
            ) : null}
            {hasMore ? (
              <Link
                href={buildUsageHref(page + 1, pageSize)}
                className="rounded-md border border-default px-3 py-1.5 text-sm hover:bg-tertiary"
              >
                Older
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
