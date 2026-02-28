"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

type ChainOfThoughtCardProps = {
  text?: string;
  status?: "loading" | "done" | "error";
  error?: string;
  isDark?: boolean;
};

export default function ChainOfThoughtCard(props: ChainOfThoughtCardProps) {
  const { text, status, error, isDark = false } = props;
  const normalizedText = useMemo(() => (typeof text === "string" ? text.trim() : ""), [text]);
  const hasText = normalizedText.length > 0;
  const isLoading = status === "loading" && !hasText;
  const isError = status === "error";
  const compactText = useMemo(() => {
    if (!normalizedText) return "";
    const singleLine = normalizedText.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 160) return singleLine;
    return `${singleLine.slice(0, 157)}...`;
  }, [normalizedText]);
  const hasCompactText = compactText.length > 0;

  const [open, setOpen] = useState<boolean>(false);
  const isOpen = open;

  if (!hasText && !isLoading && !isError) return null;

  const headerTextClasses = isDark ? "text-zinc-400" : "text-zinc-500";
  const bodyTextClasses = isDark ? "text-zinc-300" : "text-zinc-600";
  const errorTextClasses = isDark ? "text-zinc-400" : "text-zinc-500";

  return (
    <div className="not-prose my-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={isOpen}
        className={`flex w-full min-w-0 items-center gap-2 py-1 text-[10px] ${headerTextClasses}`}
      >
        <span className="shrink-0 uppercase tracking-[0.2em]">Reasoning</span>
        {!isOpen && hasCompactText && !isLoading && !isError ? (
          <span className={`min-w-0 flex-1 truncate text-[11px] normal-case ${bodyTextClasses}`}>
            {compactText}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="inline-flex items-center gap-1">
          {isLoading ? (
            <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-current/40" />
          ) : null}
          {isError ? (
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-red-500/70" />
          ) : null}
          <ChevronDown
            className={`h-3 w-3 transition-transform ${
              isOpen ? "rotate-180" : "rotate-0"
            }`}
          />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            key="panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className={`pb-2 text-[11px] leading-relaxed whitespace-pre-wrap ${bodyTextClasses}`}>
              {isError ? (
                <span className={errorTextClasses}>
                  {error?.trim() || "Unavailable."}
                </span>
              ) : hasText ? (
                normalizedText
              ) : (
                <span className="opacity-60">Thinking...</span>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
