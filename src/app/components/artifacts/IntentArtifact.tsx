"use client";

import { useMemo } from "react";

import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";

type IntentPayload = {
    kind?: string;
    intent?: {
        taskType?: string;
        taskSubtype?: string;
        inputDescription?: string;
        outputDescription?: string;
        budget?: {
            hasConstraint?: boolean;
            min?: number;
            max?: number;
            currency?: string;
            isFlexible?: boolean;
            notes?: string;
        };
        timeline?: {
            hasDeadline?: boolean;
            deadline?: string | Date;
            urgency?: string;
            preferredDuration?: string;
            notes?: string;
        };
        quality?: {
            priority?: string;
            minimumAccuracy?: number;
            evaluationMetrics?: string[];
        };
        dataRequirements?: {
            domain?: string;
            geographicScope?: string;
            temporalScope?: string;
            granularity?: string;
            estimatedSize?: string;
        };
        deployment?: {
            target?: string;
        };
        confidence?: number;
        clarificationsNeeded?: string[];
        assumptions?: string[];
    };
    suggestedFollowUp?: string[];
    missingInformation?: string[];
    intentComplete?: boolean;
    intentBlockers?: string[];
    extractedAt?: string;
    refinedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isIntentPayload(value: unknown): value is IntentPayload {
    if (!isRecord(value)) return false;
    if (!("intent" in value)) return false;
    const intent = (value as Record<string, unknown>).intent;
    if (!isRecord(intent)) return false;
    return typeof intent.inputDescription === "string" && typeof intent.outputDescription === "string";
}

function formatLabel(value?: string) {
    if (!value) return undefined;
    return value
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function IntentArtifact(props: { dataOverride?: unknown } = {}) {
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();

    const intentPayload = useMemo(() => {
        if (dataOverride !== undefined) return isIntentPayload(dataOverride) ? dataOverride : null;
        const artifact = artifacts.find(a => a.id === "intent");
        return isIntentPayload(artifact?.data) ? artifact.data : null;
    }, [artifacts, dataOverride]);

    const intent = intentPayload?.intent;

    const taskLabel = intent
        ? formatLabel(intent.taskSubtype || intent.taskType) || "Intent"
        : "Understanding your request";
    const summaryLine = intent
        ? `${intent.inputDescription} → ${intent.outputDescription}`
        : "Extracting goals, constraints, and data needs.";

    const followUps = useMemo(() => {
        const merged = new Set<string>();
        (intent?.clarificationsNeeded || []).forEach((item) => {
            if (item && item.trim()) merged.add(item.trim());
        });
        (intentPayload?.suggestedFollowUp || []).forEach((item) => {
            if (item && item.trim()) merged.add(item.trim());
        });
        return Array.from(merged).slice(0, 4);
    }, [intent, intentPayload]);

    const missingInfo = (intentPayload?.missingInformation || []).filter(Boolean).slice(0, 4);

    const intentComplete = intentPayload?.intentComplete;
    const blockers = (intentPayload?.intentBlockers || []).filter(Boolean).slice(0, 3);
    const statusLabel = !intentPayload
        ? "Analyzing"
        : intentComplete === false
            ? "Needs clarification"
            : "Ready";

    return (
        <div className="h-full flex flex-col gap-3 p-3 sm:p-4 animate-fade-in-up">
            <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-primary">Intent</h2>
                <span className="text-[10px] text-muted">{statusLabel}</span>
            </div>

            <div>
                <div className="text-[13px] font-medium text-primary">{taskLabel}</div>
                <p className="mt-1 text-[12px] text-muted break-words">{summaryLine}</p>
            </div>

            {intent ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Input</div>
                        <p className="mt-1.5 text-[12px] text-primary leading-relaxed break-words">
                            {intent.inputDescription}
                        </p>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Output</div>
                        <p className="mt-1.5 text-[12px] text-primary leading-relaxed break-words">
                            {intent.outputDescription}
                        </p>
                    </div>
                </div>
            ) : (
                <ArtifactLoadingState
                    variant="inline"
                    title="Waiting for an intent summary. Provide a bit more detail to refine this view."
                    className="text-[12px] text-muted"
                />
            )}

            {(followUps.length > 0 || missingInfo.length > 0) ? (
                <div className="border-t border-zinc-200/70 dark:border-white/10 pt-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Clarifications</div>
                    {missingInfo.length > 0 ? (
                        <p className="mt-1.5 text-[11px] text-muted break-words">
                            Missing: {missingInfo.join(", ")}
                        </p>
                    ) : null}
                    {followUps.length > 0 ? (
                        <ul className="mt-1.5 list-disc pl-3 text-[12px] text-primary">
                            {followUps.map((item) => (
                                <li key={item} className="break-words">{item}</li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}

            {intentComplete === false && blockers.length > 0 ? (
                <div className="border-t border-zinc-200/70 dark:border-white/10 pt-3">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Blockers</div>
                    <ul className="mt-1.5 list-disc pl-3 text-[12px] text-primary">
                        {blockers.map((item) => (
                            <li key={item} className="break-words">{item}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
