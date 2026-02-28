"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

export default function CanvasTimelineBar(props: {
  maxIndex: number;
  value: number;
  isLive: boolean;
  playback: "paused" | "playing";
  onScrubPreview: (index: number) => void;
  onScrubCommit: (index: number) => void;
  onStep: (delta: number) => void;
  onTogglePlay: () => void;
  onJumpToLive: () => void;
  isDark?: boolean;
  variant?: "default" | "compact";
}) {
  const {
    maxIndex,
    value,
    isLive,
    playback,
    onScrubPreview,
    onScrubCommit,
    onStep,
    onTogglePlay,
    onJumpToLive,
    isDark = false,
    variant = "default",
  } = props;

  const disabled = maxIndex <= 0;
  const isCompact = variant === "compact";
  const clampedValue = Math.min(Math.max(value, 0), Math.max(maxIndex, 0));
  const pct = useMemo(() => {
    if (maxIndex <= 0) return 0;
    return Math.round((clampedValue / maxIndex) * 100);
  }, [clampedValue, maxIndex]);

  const progressColor = "hsl(var(--accent-blue))";
  const trackColor = "hsl(var(--border-default))";

  const [isScrubbing, setIsScrubbing] = useState(false);
  const lastPreviewRef = useRef<number>(clampedValue);

  const commit = useCallback(
    (next: number) => {
      const v = Math.min(Math.max(next, 0), Math.max(maxIndex, 0));
      lastPreviewRef.current = v;
      onScrubCommit(v);
    },
    [maxIndex, onScrubCommit]
  );

  const preview = useCallback(
    (next: number) => {
      const v = Math.min(Math.max(next, 0), Math.max(maxIndex, 0));
      lastPreviewRef.current = v;
      onScrubPreview(v);
    },
    [maxIndex, onScrubPreview]
  );
  const finishScrub = useCallback(() => {
    if (!isScrubbing) return;
    setIsScrubbing(false);
    commit(lastPreviewRef.current);
  }, [commit, isScrubbing]);

  return (
    <div className={`shrink-0 ${isCompact ? "px-3 py-2" : "px-4 py-3"}`}>
      {!isLive && maxIndex > 0 ? (
        <div className="mb-2 flex items-center justify-center">
          <button
            type="button"
            onClick={onJumpToLive}
            className="text-[12px] px-3 py-1 rounded-full border border-default bg-secondary text-primary hover:bg-tertiary transition-colors"
          >
            Jump to live
          </button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="order-2 flex items-center justify-between gap-3 sm:order-none sm:contents">
          <div className="flex items-center gap-1 sm:order-1">
          <button
            type="button"
            disabled={clampedValue <= 0}
            onClick={() => onStep(-1)}
            className={`${isCompact ? "p-1.5" : "p-2 sm:p-1.5"} rounded-md transition-colors ${
              clampedValue <= 0
                ? "opacity-40 cursor-not-allowed"
                : "text-secondary hover:text-primary hover:bg-tertiary"
            }`}
            aria-label="Step back"
          >
            <SkipBack className={`${isCompact ? "w-4 h-4" : "w-5 h-5 sm:w-4 sm:h-4"}`} />
          </button>

          <button
            type="button"
            disabled={maxIndex <= 0}
            onClick={onTogglePlay}
            className={`${isCompact ? "p-1.5" : "p-2 sm:p-1.5"} rounded-md transition-colors ${
              maxIndex <= 0
                ? "opacity-40 cursor-not-allowed"
                : "text-secondary hover:text-primary hover:bg-tertiary"
            }`}
            aria-label={playback === "playing" ? "Pause" : "Play"}
          >
            {playback === "playing" ? (
              <Pause className={`${isCompact ? "w-4 h-4" : "w-5 h-5 sm:w-4 sm:h-4"}`} />
            ) : (
              <Play className={`${isCompact ? "w-4 h-4" : "w-5 h-5 sm:w-4 sm:h-4"}`} />
            )}
          </button>

          <button
            type="button"
            disabled={clampedValue >= maxIndex}
            onClick={() => onStep(1)}
            className={`${isCompact ? "p-1.5" : "p-2 sm:p-1.5"} rounded-md transition-colors ${
              clampedValue >= maxIndex
                ? "opacity-40 cursor-not-allowed"
                : "text-secondary hover:text-primary hover:bg-tertiary"
            }`}
            aria-label="Step forward"
          >
            <SkipForward className={`${isCompact ? "w-4 h-4" : "w-5 h-5 sm:w-4 sm:h-4"}`} />
          </button>
          </div>

          <button
            type="button"
            onClick={onJumpToLive}
            disabled={maxIndex <= 0}
            className={`shrink-0 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full transition-colors sm:order-3 sm:ml-auto ${
              maxIndex <= 0
                ? "opacity-40 cursor-not-allowed"
                : "text-secondary hover:text-primary hover:bg-tertiary"
            }`}
            aria-label="Jump to live"
            title="Jump to live"
          >
            <span
              className={`w-2 h-2 rounded-full ${isLive ? "bg-emerald-400" : "bg-[hsl(var(--text-muted))]"}`}
            />
            <span className="text-[12px] tracking-tight">live</span>
          </button>
        </div>

        <div className="order-1 flex-1 min-w-0 sm:order-2">
          <input
            type="range"
            min={0}
            max={Math.max(maxIndex, 0)}
            step={1}
            value={clampedValue}
            disabled={disabled}
            onPointerDown={() => setIsScrubbing(true)}
            onPointerUp={finishScrub}
            onPointerCancel={finishScrub}
            onChange={(e) => {
              const next = Number(e.target.value);
              preview(next);
            }}
            onBlur={finishScrub}
            onKeyUp={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
                commit(Number((e.target as HTMLInputElement).value));
              }
            }}
            className={`w-full h-2 sm:h-1.5 rounded-full appearance-none cursor-pointer bg-[hsl(var(--border-default))] ${
              disabled ? "opacity-50 cursor-not-allowed" : ""
            }`}
            style={{
              background:
                maxIndex <= 0
                  ? undefined
                  : `linear-gradient(to right, ${progressColor} 0%, ${progressColor} ${pct}%, ${trackColor} ${pct}%, ${trackColor} 100%)`,
            }}
          />
          <div className="mt-1 text-[10px] text-center text-muted">
            {isScrubbing ? "Scrubbing…" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

