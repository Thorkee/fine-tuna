"use client";

import { useMemo, useState, useEffect } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { TrendingDown } from "lucide-react";
import type { MetricPoint } from "@/lib/training/parse-metrics";

type Props = {
  metrics: MetricPoint[];
};

const SERIES_CONFIG = {
  loss: { label: "Train Loss", light: "#3b82f6", dark: "#60a5fa", yAxis: "left" },
  evalLoss: { label: "Eval Loss", light: "#10b981", dark: "#34d399", yAxis: "left" },
  accuracy: { label: "Accuracy", light: "#8b5cf6", dark: "#a78bfa", yAxis: "left" },
  evalAccuracy: { label: "Eval Accuracy", light: "#6366f1", dark: "#818cf8", yAxis: "left" },
  lr: { label: "Learning Rate", light: "#f59e0b", dark: "#fbbf24", yAxis: "right" },
} as const;

type SeriesKey = keyof typeof SERIES_CONFIG;

function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const check = () => setDark(document.documentElement.classList.contains("dark") || mq.matches);
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    mq.addEventListener("change", check);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", check);
    };
  }, []);
  return dark;
}

function formatAxis(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) < 0.001 && value !== 0) return value.toExponential(1);
  if (Math.abs(value) >= 10000) return `${(value / 1000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(3);
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-sm px-3 py-2 shadow-lg text-[11px]">
      <div className="text-zinc-500 dark:text-zinc-400 mb-1 font-medium">{label}</div>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-zinc-600 dark:text-zinc-300">{entry.name}</span>
          <span className="ml-auto font-mono text-zinc-800 dark:text-zinc-100">
            {typeof entry.value === "number" ? (Math.abs(entry.value) < 0.001 && entry.value !== 0 ? entry.value.toExponential(2) : entry.value.toPrecision(4)) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function TrainingCurveChart({ metrics }: Props) {
  const isDark = useDarkMode();

  const { xKey, xLabel, activeSeries, data, hasRight } = useMemo(() => {
    const hasStep = metrics.some((p) => p.step !== undefined);
    const hasEpoch = metrics.some((p) => p.epoch !== undefined);
    const xK = hasStep ? "step" : hasEpoch ? "epoch" : "step";
    const xL = hasStep ? "Step" : hasEpoch ? "Epoch" : "Step";

    const active: SeriesKey[] = [];
    for (const key of Object.keys(SERIES_CONFIG) as SeriesKey[]) {
      if (metrics.some((p) => p[key] !== undefined)) active.push(key);
    }

    const hasR = active.some((k) => SERIES_CONFIG[k].yAxis === "right");

    const chartData = metrics.map((p) => {
      const row: Record<string, number | undefined> = { [xK]: p[xK] };
      for (const k of active) row[k] = p[k];
      return row;
    });

    return { xKey: xK, xLabel: xL, activeSeries: active, data: chartData, hasRight: hasR };
  }, [metrics]);

  if (metrics.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400 px-6 text-center">
        <div className="w-12 h-12 rounded-2xl border border-black/5 dark:border-white/10 bg-white/70 dark:bg-white/5 flex items-center justify-center mb-4">
          <TrendingDown className="w-6 h-6 opacity-40" />
        </div>
        <p className="text-sm font-medium">No training metrics detected yet</p>
        <p className="text-xs mt-1 max-w-[280px] text-zinc-400 dark:text-zinc-500">
          Metrics will appear once the training script starts logging loss, accuracy, or other values to stdout.
        </p>
      </div>
    );
  }

  const gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const axisColor = isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";

  return (
    <div className="glass-card p-4">
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 font-medium">
        Training Curve
        <span className="ml-2 font-normal text-zinc-400 dark:text-zinc-500">
          {metrics.length} point{metrics.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="w-full" style={{ height: Math.min(360, Math.max(220, metrics.length * 4 + 180)) }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: hasRight ? 12 : 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis
              dataKey={xKey}
              label={{ value: xLabel, position: "insideBottomRight", offset: -4, style: { fontSize: 10, fill: axisColor } }}
              tick={{ fontSize: 10, fill: axisColor }}
              stroke={gridColor}
              tickFormatter={formatAxis}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10, fill: axisColor }}
              stroke={gridColor}
              tickFormatter={formatAxis}
              width={48}
            />
            {hasRight && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 10, fill: axisColor }}
                stroke={gridColor}
                tickFormatter={formatAxis}
                width={48}
              />
            )}
            <Tooltip content={<CustomTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
              iconType="circle"
              iconSize={8}
            />
            {activeSeries.map((key) => {
              const cfg = SERIES_CONFIG[key];
              return (
                <Line
                  key={key}
                  yAxisId={cfg.yAxis === "right" && hasRight ? "right" : "left"}
                  type="monotone"
                  dataKey={key}
                  name={cfg.label}
                  stroke={isDark ? cfg.dark : cfg.light}
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: isDark ? cfg.dark : cfg.light, strokeWidth: 0 }}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: isDark ? "#18181b" : "#ffffff" }}
                  connectNulls
                  animationDuration={400}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
