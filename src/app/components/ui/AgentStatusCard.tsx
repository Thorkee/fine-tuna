"use client";

import { useState } from "react";

type AgentStatusEvent = {
  label: string;
  detail?: string;
  at: string;
};

type AgentStatus = {
  phase?: string;
  events: AgentStatusEvent[];
};

const LABEL_OVERRIDES: Record<string, string> = {
  web_search: "Searching web",
};

const DETAIL_OVERRIDES: Record<string, string> = {
  read_file: "Reading files",
  list_files: "Listing files",
  web_fetch: "Reading web pages",
  web_search: "Searching web",
};

function formatLabel(value: string) {
  if (LABEL_OVERRIDES[value]) return LABEL_OVERRIDES[value];
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDetail(value: string) {
  if (DETAIL_OVERRIDES[value]) return DETAIL_OVERRIDES[value];
  return value.replace(/_/g, " ");
}

function formatTime(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

export default function AgentStatusCard(props: { status: AgentStatus; isDark?: boolean }) {
  const { status, isDark = false } = props;
  const events = Array.isArray(status?.events) ? status.events : [];
  const [open, setOpen] = useState(false);
  const formattedEvents = events.map((event) => {
    const labelKey = event.label || status?.phase || "";
    const label = formatLabel(labelKey);
    const detailRaw = event.detail ? formatDetail(event.detail) : "";
    const detail = detailRaw && detailRaw.toLowerCase() !== label.toLowerCase() ? detailRaw : "";
    return {
      label,
      detail,
      time: formatTime(event.at),
    };
  });
  const latest = formattedEvents[formattedEvents.length - 1];
  if (!latest) return null;

  const label = latest.label;
  const detail = latest.detail;
  const active = isActiveStatus(events[events.length - 1]?.label || status?.phase);
  const hasHistory = formattedEvents.length > 1;
  const remaining = Math.max(formattedEvents.length - 1, 0);

  return (
    <div className="not-prose my-0">
      <div className="inline-flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            active
              ? "bg-emerald-400 animate-pulse"
              : isDark
                ? "bg-white/20"
                : "bg-zinc-300"
          }`}
        />
        <span className="font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
        {detail ? <span className="text-zinc-500 dark:text-zinc-400">- {detail}</span> : null}
        {hasHistory ? (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="text-[10px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            {open ? "Hide steps" : `Show ${remaining} more`}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 w-full space-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {formattedEvents.map((event, idx) => (
            <div
              key={`${event.time || "event"}-${idx}`}
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2"
            >
              <span className="mt-1.5 h-1 w-1 rounded-full bg-zinc-300 dark:bg-white/20" />
              <span className="min-w-0">
                <span className="font-medium text-zinc-600 dark:text-zinc-300">{event.label}</span>
                {event.detail ? (
                  <span className="text-zinc-500 dark:text-zinc-400"> - {event.detail}</span>
                ) : null}
              </span>
              {event.time ? (
                <span className="shrink-0 justify-self-end text-right tabular-nums text-[10px] text-zinc-400 dark:text-zinc-500">
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
