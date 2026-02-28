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
      <div className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
        {active ? (
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
        ) : (
          <span className="text-emerald-500/70 dark:text-emerald-400/70 select-none text-[10px] shrink-0">
            ✓
          </span>
        )}
        <span className="font-medium text-primary/80">{label}</span>
        {detail ? (
          <span className="text-secondary/60 text-[10px]">{detail}</span>
        ) : null}
        {totalElapsed && !active ? (
          <span className="text-[10px] text-secondary/40 tabular-nums ml-0.5">
            ({totalElapsed})
          </span>
        ) : null}
        {hasHistory ? (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="text-[10px] text-secondary/50 hover:text-primary/70 ml-0.5 transition-colors"
          >
            {open ? "▾ collapse" : `▸ ${remaining} step${remaining > 1 ? "s" : ""}`}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-1.5 w-full space-y-px text-[11px] border-l-2 border-emerald-500/15 dark:border-emerald-400/15 ml-0.5 pl-3">
          {formattedEvents.map((event, idx) => (
            <div
              key={`${event.time || "event"}-${idx}`}
              className="flex items-baseline gap-2 min-w-0 py-0.5"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium text-primary/70">{event.label}</span>
                {event.detail ? (
                  <span className="text-secondary/50 ml-1">{event.detail}</span>
                ) : null}
              </span>
              {event.elapsed ? (
                <span className="shrink-0 tabular-nums text-[9px] text-secondary/40 bg-secondary/5 rounded px-1 py-0.5">
                  {event.elapsed}
                </span>
              ) : null}
              {event.time ? (
                <span className="shrink-0 ml-auto tabular-nums text-[9px] text-secondary/30">
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
