"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

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

const STATUS_ICONS: Record<string, string> = {
  thinking: "◆",
  planning: "◇",
  executing: "▶",
  verifying: "✓",
  reflecting: "↻",
  reading: "◉",
  writing: "✎",
  web_search: "⊕",
  web_fetch: "↗",
  read_file: "◉",
  list_files: "☰",
  done: "●",
  blocked: "⊘",
};

function statusIcon(label: string): string {
  return STATUS_ICONS[label] || "·";
}

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
      {/* Header row */}
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs text-emerald-500/70 dark:text-emerald-400/70">$</span>
        <span className="font-mono text-xs text-emerald-400/50 dark:text-emerald-300/50 tracking-wide">tuna</span>
        <span className="font-mono text-xs text-zinc-400/40 dark:text-zinc-600 mx-0.5">—</span>

        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
          {label.toLowerCase()}
        </span>
        {detail ? (
          <span className="font-mono text-[11px] text-zinc-400/60 dark:text-zinc-600 truncate max-w-[160px]">
            {detail.toLowerCase()}
          </span>
        ) : null}

        {active ? <span className="terminal-prompt-cursor ml-0.5" /> : null}

        {totalElapsed && !active ? (
          <span className="font-mono text-[10px] text-zinc-400/50 dark:text-zinc-600 tabular-nums ml-0.5">
            {totalElapsed}
          </span>
        ) : null}

        <span className="flex-1" />

        {hasHistory ? (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="
              inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md
              font-mono text-[10px] text-zinc-500/60 dark:text-zinc-500
              hover:text-zinc-500 dark:hover:text-zinc-400
              hover:bg-zinc-100/50 dark:hover:bg-white/5
              transition-all duration-150
            "
          >
            <ChevronDown
              className={`w-3 h-3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
            />
            {open ? "collapse" : `${remaining} step${remaining > 1 ? "s" : ""}`}
          </button>
        ) : null}
      </div>

      {/* Expanded timeline */}
      {open ? (
        <div className="mt-2 ml-[7px] border-l border-emerald-500/10 dark:border-emerald-400/8">
          {formattedEvents.map((event, idx) => {
            const isLast = idx === formattedEvents.length - 1;
            const isActive = isLast && active;
            return (
              <div
                key={`${event.time || "event"}-${idx}`}
                className="group relative flex items-baseline gap-2 py-[3px] pl-3"
              >
                {/* Timeline node */}
                <span
                  className={`
                    absolute -left-[3.5px] top-[9px] flex h-[7px] w-[7px] items-center justify-center
                    rounded-full
                    ${isActive
                      ? "bg-emerald-500/80 dark:bg-emerald-400/80 shadow-[0_0_6px_rgba(16,185,129,0.35)]"
                      : "bg-zinc-300/60 dark:bg-zinc-600/50"
                    }
                  `}
                />

                {/* Icon */}
                <span
                  className={`
                    font-mono text-[10px] select-none shrink-0 w-3 text-center
                    ${isActive
                      ? "text-emerald-500/70 dark:text-emerald-400/60"
                      : "text-zinc-400/40 dark:text-zinc-600"
                    }
                  `}
                >
                  {statusIcon(event.rawLabel)}
                </span>

                {/* Label */}
                <span
                  className={`
                    font-mono text-[11px] shrink-0
                    ${isActive
                      ? "text-zinc-600 dark:text-zinc-300"
                      : "text-zinc-400/80 dark:text-zinc-500"
                    }
                  `}
                >
                  {event.label.toLowerCase()}
                </span>

                {/* Detail */}
                {event.detail ? (
                  <span className="font-mono text-[10px] text-zinc-400/50 dark:text-zinc-600 truncate max-w-[120px]">
                    {event.detail.toLowerCase()}
                  </span>
                ) : null}

                {/* Elapsed badge */}
                {event.elapsed ? (
                  <span
                    className="
                      font-mono text-[9px] tabular-nums
                      px-1 py-px rounded
                      bg-zinc-100/60 dark:bg-white/5
                      text-zinc-400/70 dark:text-zinc-600
                    "
                  >
                    {event.elapsed}
                  </span>
                ) : null}

                {/* Timestamp */}
                {event.time ? (
                  <span className="font-mono text-[9px] text-zinc-400/30 dark:text-zinc-700 tabular-nums ml-auto select-none">
                    {event.time}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
