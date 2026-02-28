"use client";

import { Loader2 } from "lucide-react";

type ArtifactLoadingStateProps = {
  title?: string;
  description?: string;
  variant?: "panel" | "inline";
  className?: string;
};

export default function ArtifactLoadingState({
  title = "Loading artifact...",
  description,
  variant = "panel",
  className,
}: ArtifactLoadingStateProps) {
  const wrapperClassName = [
    variant === "panel"
      ? "h-full flex items-center justify-center p-3 sm:p-4 animate-fade-in-up"
      : "flex items-center gap-2 text-[12px] text-zinc-500 dark:text-zinc-400",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (variant === "inline") {
    return (
      <div className={wrapperClassName}>
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--accent-blue))]" />
        <span>{title}</span>
        {description ? (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{description}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className={wrapperClassName}>
      <div className="flex items-center gap-3 rounded-xl border border-default bg-secondary px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--accent-blue))]" />
        <div>
          <div className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
            {title}
          </div>
          {description ? (
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {description}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
