"use client";

import { ShieldAlert } from "lucide-react";

export type TakeoverPayload = {
  version?: number;
  kind?: "desktop_takeover";
  message?: string;
  reason?: string;
  instructions?: string[];
};

const TAKEOVER_BLOCK = /```takeover\s*([\s\S]*?)```/i;
const TAKEOVER_OPEN = /```takeover\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out.length > 0 ? out : undefined;
}

export function isTakeoverPayload(value: unknown): value is TakeoverPayload {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  if (kind !== undefined && kind !== "desktop_takeover") return false;
  if (value.message !== undefined && typeof value.message !== "string") return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.instructions !== undefined && !Array.isArray(value.instructions)) return false;
  return true;
}

export function extractTakeoverPayload(content: string): {
  payload: TakeoverPayload | null;
  stripped: string;
} {
  const match = content.match(TAKEOVER_BLOCK);
  if (match) {
    const stripped = content.replace(match[0], "").trim();
    try {
      const raw = match[1].trim();
      const parsed: unknown = JSON.parse(raw);
      if (!isTakeoverPayload(parsed)) {
        return { payload: null, stripped };
      }
      const payload = parsed as TakeoverPayload;
      return {
        payload: {
          version: typeof payload.version === "number" ? payload.version : undefined,
          kind: payload.kind === "desktop_takeover" ? payload.kind : "desktop_takeover",
          message: typeof payload.message === "string" ? payload.message : undefined,
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
          instructions: toStringArray(payload.instructions),
        },
        stripped,
      };
    } catch {
      return { payload: null, stripped };
    }
  }

  const openMatch = content.match(TAKEOVER_OPEN);
  if (openMatch && typeof openMatch.index === "number") {
    return { payload: null, stripped: content.slice(0, openMatch.index).trim() };
  }

  return { payload: null, stripped: content };
}

/**
 * Returns true only when the content contains an explicit ```takeover block
 * (complete or still streaming). Plain-English mentions of "take control" /
 * "hand back" are NOT enough — they caused false-positive takeover cards.
 */
export function looksLikeTakeoverRequest(content: string): boolean {
  return /```takeover\b/i.test(content);
}

export default function TakeoverCard(props: { payload?: TakeoverPayload | null }) {
  const payload = props.payload ?? null;
  const message = (payload?.message ?? "").trim() || "Agent is waiting for your takeover.";
  const reason = (payload?.reason ?? "").trim();
  const instructions =
    payload?.instructions && payload.instructions.length > 0
      ? payload.instructions
      : [
          'Open the Desktop panel and click “Take control”.',
          "Complete the login / verification step in the remote browser.",
          'When finished, click “Hand back” and send a short note (e.g. “Logged in”).',
        ];

  return (
    <div className="not-prose rounded-2xl border border-amber-200/60 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600/90 dark:text-amber-300/80" />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-800/80 dark:text-amber-200/70">
            Takeover required
          </div>
          <div className="mt-1 text-sm font-medium text-amber-950/90 dark:text-amber-100/90">
            {message}
          </div>
          {reason ? (
            <div className="mt-1 text-xs text-amber-900/70 dark:text-amber-200/70">
              Blocker: {reason}
            </div>
          ) : null}
          <ul className="mt-2 space-y-1 text-xs text-amber-900/70 dark:text-amber-200/70">
            {instructions.map((line, idx) => (
              <li key={`${idx}-${line}`} className="flex gap-2">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-amber-700/40 dark:bg-amber-200/30" />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

