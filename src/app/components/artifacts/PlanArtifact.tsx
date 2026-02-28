"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, Loader2, PauseCircle, XCircle, SkipForward } from "lucide-react";
import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";

type StepStatus = "todo" | "doing" | "blocked" | "done" | "failed" | "skipped";

type PlanStepView = {
    id: string;
    title: string;
    description?: string;
    status: StepStatus;
    evidence?: string;
    result?: string;
};

type PlanMeta = {
    action?: string;
    tool?: string;
    source?: string;
    at?: string;
    updatedAt?: string;
};

type PlanData = {
    goal: string;
    successCriteria?: string[];
    steps: PlanStepView[];
    meta?: PlanMeta;
};

function isStepStatus(v: unknown): v is StepStatus {
    return (
        typeof v === "string" &&
        (v === "todo" || v === "doing" || v === "blocked" || v === "done" || v === "failed" || v === "skipped")
    );
}

function isPlanData(v: unknown): v is PlanData {
    if (!v || typeof v !== "object") return false;
    const obj = v as Record<string, unknown>;
    if (typeof obj.goal !== "string") return false;
    if (!Array.isArray(obj.steps)) return false;
    for (const s of obj.steps) {
        if (!s || typeof s !== "object") return false;
        const step = s as Record<string, unknown>;
        if (typeof step.id !== "string") return false;
        if (typeof step.title !== "string") return false;
        if (!isStepStatus(step.status)) return false;
    }
    return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function extractPlanMeta(plan: unknown): PlanMeta | null {
    if (!isRecord(plan)) return null;
    const meta = plan.meta;
    if (isRecord(meta)) return meta as PlanMeta;
    return null;
}

function formatPlanActionLabel(meta: PlanMeta | null): string | null {
    if (!meta) return null;
    const action = meta.action ?? meta.tool ?? meta.source;
    if (!action) return null;
    switch (action) {
        case "set_plan":
            return "Plan created";
        case "update_plan":
            return "Plan updated";
        case "update_plan_step":
            return "Plan updated";
        case "read_plan":
        case "get_plan":
            return "Plan viewed";
        case "open_artifact":
            return "Plan opened";
        default: {
            const normalized = action.replace(/_/g, " ").trim();
            if (!normalized) return null;
            return normalized.startsWith("plan") ? normalized : `Plan ${normalized}`;
        }
    }
}

function StatusIcon({ status, size = "md" }: { status: StepStatus; size?: "sm" | "md" }) {
    const sizeClass = size === "sm" ? "w-4 h-4" : "w-5 h-5";
    switch (status) {
        case "done":
            return <CheckCircle2 className={`${sizeClass} text-[hsl(var(--accent-green))]`} />;
        case "doing":
            return <Loader2 className={`${sizeClass} text-[hsl(var(--accent-blue))] animate-spin`} />;
        case "blocked":
            return <PauseCircle className={`${sizeClass} text-[hsl(var(--accent-amber))]`} />;
        case "failed":
            return <XCircle className={`${sizeClass} text-red-500`} />;
        case "skipped":
            return <SkipForward className={`${sizeClass} text-zinc-400`} />;
        case "todo":
        default:
            return <Circle className={`${sizeClass} text-zinc-400`} />;
    }
}

type ArtifactVariant = "canvas" | "inline";

export default function PlanArtifact(props: { variant?: ArtifactVariant; dataOverride?: unknown } = {}) {
    const variant: ArtifactVariant = props.variant ?? "canvas";
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();

    const plan = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === "plan");
        return a?.data as unknown;
    }, [artifacts, dataOverride]);

    const parsed = isPlanData(plan) ? plan : null;
    const meta = extractPlanMeta(plan);
    const [cachedPlan, setCachedPlan] = useState<PlanData | null>(parsed);
    const [cachedMeta, setCachedMeta] = useState<PlanMeta | null>(meta);

    useEffect(() => {
        if (!parsed) return;
        setCachedPlan(parsed);
        setCachedMeta(meta);
    }, [meta, parsed]);

    const effectivePlan = parsed ?? cachedPlan;
    const effectiveMeta = meta ?? cachedMeta;
    const goal = effectivePlan?.goal || "";
    const steps = effectivePlan?.steps || [];
    const actionLabel = formatPlanActionLabel(effectiveMeta);
    const total = steps.length;
    const done = steps.filter(s => s.status === "done").length;
    const doing = steps.filter(s => s.status === "doing").length;
    const blocked = steps.filter(s => s.status === "blocked").length;
    const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

    const statusLabel = (status: StepStatus) => {
        switch (status) {
            case "doing":
                return "In progress";
            case "blocked":
                return "Blocked";
            case "done":
                return "Done";
            case "failed":
                return "Failed";
            case "skipped":
                return "Skipped";
            case "todo":
            default:
                return "Pending";
        }
    };

    if (variant === "inline") {
        return (
            <div className="p-3">
                {goal ? (
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mb-2">
                        Goal: <span className="text-zinc-800 dark:text-zinc-200 break-words">{goal}</span>
                    </div>
                ) : (
                    <ArtifactLoadingState
                        variant="inline"
                        title="Preparing plan..."
                        className="text-[12px] text-zinc-500 dark:text-zinc-400"
                    />
                )}

                {actionLabel ? (
                    <div className="mb-2 inline-flex items-center rounded-full border border-zinc-200/70 dark:border-white/10 bg-white/70 dark:bg-white/5 px-2 py-0.5 text-[10px] text-zinc-600 dark:text-zinc-300">
                        {actionLabel}
                    </div>
                ) : null}

                {steps.length === 0 ? (
                    <ArtifactLoadingState
                        variant="inline"
                        title="Updating plan..."
                        className="text-[12px] text-zinc-500 dark:text-zinc-400"
                    />
                ) : (
                    <div className="space-y-2">
                        {steps.map((s) => (
                            <div key={s.id} className="flex items-start gap-2">
                                <div className="mt-[2px] shrink-0">
                                    <StatusIcon status={s.status} size="sm" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="text-[12px] font-medium text-zinc-900 dark:text-zinc-100">
                                            {s.title}
                                        </div>
                                        <span className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                                            {statusLabel(s.status)}
                                        </span>
                                    </div>
                                    {s.description ? (
                                        <div className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400 break-words">
                                            {s.description}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col animate-fade-in-up h-full p-3 sm:p-4 gap-3">
            {/* Header */}
            <div className="shrink-0">
                {goal ? (
                    <div className="flex items-start justify-between gap-6">
                        <div className="min-w-0 flex-1">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                                Goal
                            </div>
                            <div className="mt-1 text-[14px] sm:text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 leading-snug break-words">
                                {goal}
                            </div>
                            {actionLabel ? (
                                <div className="mt-2 inline-flex items-center rounded-full border border-zinc-200/70 dark:border-white/10 bg-white/70 dark:bg-white/5 px-2.5 py-0.5 text-[10px] text-zinc-600 dark:text-zinc-300">
                                    {actionLabel}
                                </div>
                            ) : null}
                        </div>

                        {total > 0 ? (
                            <div className="shrink-0 flex flex-col items-end gap-2">
                                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                                    {done}/{total} done
                                </div>
                                <div className="w-24 h-1 rounded-full bg-zinc-200/70 dark:bg-white/10 overflow-hidden">
                                    <div
                                        className="h-full bg-[hsl(var(--accent-green))]"
                                        style={{ width: `${progressPct}%` }}
                                    />
                                </div>
                                {(doing > 0 || blocked > 0) ? (
                                    <div className="flex items-center gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                                        {doing > 0 ? <span>{doing} doing</span> : null}
                                        {blocked > 0 ? <span>{blocked} blocked</span> : null}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <ArtifactLoadingState
                        variant="inline"
                        title="Preparing plan..."
                        className="text-sm text-zinc-500 dark:text-zinc-400"
                    />
                )}
            </div>

            {/* Body */}
            {total === 0 ? (
                goal ? (
                    <ArtifactLoadingState
                        variant="inline"
                        title="Updating plan..."
                        className="text-[12px] text-zinc-500 dark:text-zinc-400"
                    />
                ) : null
            ) : (
                <div className="divide-y divide-zinc-200/70 dark:divide-white/10">
                    {steps.map((s, idx) => (
                        <div key={s.id} className="py-2 first:pt-0 last:pb-0">
                            <div className="flex items-start gap-2">
                                <div className="mt-0.5 shrink-0">
                                    <StatusIcon status={s.status} />
                                </div>

                                <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">
                                                    {idx + 1}.
                                                </span>
                                                <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
                                                    {s.title}
                                                </p>
                                            </div>
                                        </div>

                                        <span className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                                            {statusLabel(s.status)}
                                        </span>
                                    </div>

                                    {s.description ? (
                                        <p className="mt-1 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300 break-words">
                                            {s.description}
                                        </p>
                                    ) : null}

                                    {s.evidence ? (
                                        <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap break-words">
                                            <span className="font-medium text-zinc-600 dark:text-zinc-300">Evidence:</span>{" "}
                                            {s.evidence}
                                        </p>
                                    ) : null}

                                    {s.result ? (
                                        <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap break-words">
                                            <span className="font-medium text-zinc-600 dark:text-zinc-300">Result:</span>{" "}
                                            {s.result}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

