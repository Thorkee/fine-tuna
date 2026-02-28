"use client";

import { useMemo, useState } from "react";

type AgentStatusEvent = {
  label: string;
  detail?: string;
  at: string;
};

type AgentStatus = {
  phase?: string;
  events: AgentStatusEvent[];
};

const HUMAN_LABELS: Record<string, string> = {
  thinking: "Thinking",
  planning: "Creating plan",
  executing: "Executing",
  verifying: "Verifying",
  reflecting: "Reflecting",
  reading: "Reading file",
  writing: "Writing",
  web_search: "Searching the web",
  web_fetch: "Fetching page",
  read_file: "Reading file",
  list_files: "Listing files",
  done: "Done",
  blocked: "Blocked",
};

function humanizeLabel(value: string): string {
  if (HUMAN_LABELS[value]) return HUMAN_LABELS[value];
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeDetail(value: string): string {
  if (HUMAN_LABELS[value]) return HUMAN_LABELS[value];
  if (value.length > 60) return value.slice(0, 57) + "…";
  return value;
}

function formatTime(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function elapsedBetween(a?: string, b?: string): string {
  if (!a || !b) return "";
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return "";
  const ms = Math.abs(tb - ta);
  if (ms < 1000) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function isActiveStatus(label?: string) {
  return (
    label === "thinking" ||
    label === "planning" ||
    label === "executing" ||
    label === "verifying" ||
    label === "reflecting" ||
    label === "reading" ||
    label === "writing" ||
    label === "web_search"
  );
}

export default function AgentStatusCard(props: {
  status: AgentStatus;
  isDark?: boolean;
}) {
  const { status } = props;
  const events = Array.isArray(status?.events) ? status.events : [];
  const [open, setOpen] = useState(false);

  const formattedEvents = useMemo(
    () =>
      events.map((event, idx) => {
        const labelKey = event.label || status?.phase || "";
        const label = humanizeLabel(labelKey);
        const detailRaw = event.detail ? humanizeDetail(event.detail) : "";
        const detail =
          detailRaw && detailRaw.toLowerCase() !== label.toLowerCase()
            ? detailRaw
            : "";
        const next = events[idx + 1];
        const elapsed = next ? elapsedBetween(event.at, next.at) : "";
        return {
          label,
          detail,
          time: formatTime(event.at),
          elapsed,
          rawLabel: labelKey,
        };
      }),
    [events, status?.phase]
  );

  const latest = formattedEvents[formattedEvents.length - 1];
  if (!latest) return null;

  const label = latest.label;
  const detail = latest.detail;
  const active = isActiveStatus(events[events.length - 1]?.label || status?.phase);
  const hasHistory = formattedEvents.length > 1;
  const remaining = Math.max(formattedEvents.length - 1, 0);

  const totalElapsed = useMemo(() => {
    if (events.length < 2) return "";
    return elapsedBetween(events[0]?.at, events[events.length - 1]?.at);
  }, [events]);

  return (
    <div className="not-prose my-0">
      <div className="flex items-center gap-0">
        <span className="font-mono text-xs text-emerald-500/70 dark:text-emerald-400/70">$</span>
        <span className="ml-1.5 font-mono text-xs text-emerald-400/50 dark:text-emerald-300/50">tuna</span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-500 mx-1">—</span>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
          {label.toLowerCase()}
        </span>
        {detail ? (
          <span className="font-mono text-xs text-zinc-400/60 dark:text-zinc-600 ml-1.5">
            {detail.toLowerCase()}
          </span>
        ) : null}
        {totalElapsed && !active ? (
          <span className="font-mono text-[10px] text-zinc-400/50 dark:text-zinc-600 ml-1.5 tabular-nums">
            {totalElapsed}
          </span>
        ) : null}
        {active ? <span className="terminal-prompt-cursor" /> : null}
        {hasHistory ? (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="font-mono text-[10px] text-zinc-500/50 hover:text-zinc-400 ml-2 transition-colors"
          >
            {open ? "▾ collapse" : `▸ ${remaining} step${remaining > 1 ? "s" : ""}`}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-1 w-full space-y-px border-l border-emerald-500/15 dark:border-emerald-400/10 ml-[7px] pl-3">
          {formattedEvents.map((event, idx) => (
            <div
              key={`${event.time || "event"}-${idx}`}
              className="flex items-center gap-0 py-0.5"
            >
              <span className="font-mono text-[10px] text-zinc-500/40 dark:text-zinc-600 select-none">
                $
              </span>
              <span className="font-mono text-[10px] text-zinc-400/70 dark:text-zinc-500 ml-1">
                {event.label.toLowerCase()}
              </span>
              {event.detail ? (
                <span className="font-mono text-[10px] text-zinc-400/50 dark:text-zinc-600 ml-1.5">
                  {event.detail.toLowerCase()}
                </span>
              ) : null}
              {event.elapsed ? (
                <span className="font-mono text-[9px] text-zinc-400/40 dark:text-zinc-600 tabular-nums ml-1.5">
                  {event.elapsed}
                </span>
              ) : null}
              {event.time ? (
                <span className="font-mono text-[9px] text-zinc-500/30 dark:text-zinc-700 tabular-nums ml-auto">
                  {event.time}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
