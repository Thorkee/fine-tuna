"use client";

import { useMemo, useState } from "react";

import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";

export default function ProviderComparisonArtifact(props: { dataOverride?: unknown } = {}) {
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();
    const resolvedData = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === "providers");
        return a?.data as unknown;
    }, [artifacts, dataOverride]);

    const hasRenderableData = Boolean(
        resolvedData !== undefined &&
        resolvedData !== null &&
        !(typeof resolvedData === "string" && !resolvedData.trim())
    );

    const [selected, setSelected] = useState<string | null>(null);

    if (hasRenderableData) {
        return (
            <div className="h-full overflow-y-auto animate-fade-in-up">
                <GenericArtifactRenderer artifactId="providers" dataOverride={resolvedData} />
            </div>
        );
    }

    const providers = [
        { id: "lambda", name: "Lambda Labs", gpu: "A100 80GB", price: 1.29, time: "2h 15m", savings: 15 },
        { id: "runpod", name: "RunPod", gpu: "A100 80GB", price: 1.49, time: "2h 30m" },
        { id: "together", name: "Together AI", gpu: "A100 80GB", price: 1.59, time: "2h 45m" },
    ];

    return (
        <div className="h-full flex flex-col p-3 sm:p-4 animate-fade-in-up">
            <h2 className="text-lg sm:text-xl font-semibold mb-2 text-primary">Compare Providers</h2>
            <p className="text-[12px] text-muted mb-2">Guided compute selection for your training run.</p>
            <p className="text-[11px] text-muted mb-4">
                Live multi-provider orchestration appears when integrations are enabled. Until then,
                examples are shown below.
            </p>

            <div className="space-y-2 max-w-xl mx-auto w-full">
                {providers.map((provider, idx) => (
                    <button
                        key={provider.id}
                        onClick={() => setSelected(provider.id)}
                        className={`provider-card w-full text-left flex items-center justify-between animate-fade-in-up rounded-lg border transition-colors duration-200 ${selected === provider.id
                            ? "border-[hsl(var(--accent-blue))] bg-[hsl(var(--accent-blue)/0.04)]"
                            : "border-[hsl(var(--border-default))] hover:border-[hsl(var(--border-hover))] bg-card"
                            }`}
                        style={{ animationDelay: `${idx * 100}ms` }}
                    >
                        <div>
                            <div className="flex items-center gap-3">
                                <h3 className="font-semibold text-primary text-[14px]">{provider.name}</h3>
                                {provider.savings && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[hsl(var(--accent-green)/0.12)] text-[hsl(var(--accent-green))] font-medium border border-[hsl(var(--accent-green)/0.2)]">
                                        Best value
                                    </span>
                                )}
                            </div>
                            <p className="text-[12px] text-secondary mt-1">{provider.gpu}</p>
                        </div>
                        <div className="text-right">
                            <p className="font-semibold text-primary text-[15px]">${provider.price}<span className="text-[11px] text-muted font-normal">/hr</span></p>
                            <p className="text-[11px] text-muted">~{provider.time} est.</p>
                        </div>
                    </button>
                ))}
            </div>

            {selected && (
                <div className="mt-4 text-center animate-fade-in">
                    <button className="btn-primary px-5 py-2 rounded-full transition-colors">
                        Select {providers.find(p => p.id === selected)?.name}
                    </button>
                </div>
            )}
        </div>
    );
}
