"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";

import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";

export default function DataAnalysisArtifact(props: { dataOverride?: unknown } = {}) {
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();
    const resolvedData = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === "analysis");
        return a?.data as unknown;
    }, [artifacts, dataOverride]);

    const hasRenderableData = Boolean(
        resolvedData !== undefined &&
        resolvedData !== null &&
        !(typeof resolvedData === "string" && !resolvedData.trim())
    );

    const [progress, setProgress] = useState(0);
    useEffect(() => {
        if (hasRenderableData) return;
        const reset = window.setTimeout(() => setProgress(0), 0);
        const timer = window.setInterval(() => {
            setProgress((p) => Math.min(p + 2, 100));
        }, 50);
        return () => {
            window.clearTimeout(reset);
            window.clearInterval(timer);
        };
    }, [hasRenderableData]);

    if (hasRenderableData) {
        return (
            <div className="h-full overflow-y-auto animate-fade-in-up">
                <GenericArtifactRenderer artifactId="analysis" dataOverride={resolvedData} />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col items-center justify-center p-3 sm:p-4 animate-fade-in-up">
            <div className="text-center w-full max-w-md">
                <h2 className="text-lg sm:text-xl font-semibold mb-2 text-primary">Preprocess & Analyze</h2>
                <p className="text-[12px] text-muted mb-4">Preprocessing and EDA to assess structure and quality</p>

                <div className="card p-4 sm:p-5 text-center">
                    <div className="relative w-20 h-20 sm:w-24 sm:h-24 mx-auto mb-4 sm:mb-5">
                        <svg className="w-full h-full progress-ring" viewBox="0 0 100 100">
                            <circle
                                className="text-tertiary"
                                strokeWidth="8"
                                stroke="currentColor"
                                fill="transparent"
                                r="40"
                                cx="50"
                                cy="50"
                            />
                            <circle
                                className="text-[hsl(var(--accent-blue))]"
                                strokeWidth="8"
                                strokeLinecap="round"
                                stroke="currentColor"
                                fill="transparent"
                                r="40"
                                cx="50"
                                cy="50"
                                strokeDasharray={251.2}
                                strokeDashoffset={251.2 - (progress / 100) * 251.2}
                                style={{ transition: 'stroke-dashoffset 0.1s ease' }}
                            />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                            <BarChart3 className="w-8 h-8 text-[hsl(var(--accent-blue))]" />
                        </div>
                    </div>
                    <p className="text-secondary font-medium mb-2 text-[13px]">Running preprocessing and EDA checks...</p>
                    <p className="text-[11px] text-muted mb-4">This may take a few moments</p>
                    <div className="text-xl font-semibold text-[hsl(var(--accent-blue))]">{progress}%</div>
                </div>
            </div>
        </div>
    );
}
