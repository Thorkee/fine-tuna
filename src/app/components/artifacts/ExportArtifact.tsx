"use client";

import { useMemo } from "react";
import { Share2, Database, Github, Code } from "lucide-react";

import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";

export default function ExportArtifact(props: { dataOverride?: unknown } = {}) {
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();
    const resolvedData = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === "export");
        return a?.data as unknown;
    }, [artifacts, dataOverride]);

    const hasRenderableData = Boolean(
        resolvedData !== undefined &&
        resolvedData !== null &&
        !(typeof resolvedData === "string" && !resolvedData.trim())
    );

    if (hasRenderableData) {
        return (
            <div className="h-full overflow-y-auto animate-fade-in-up">
                <GenericArtifactRenderer artifactId="export" dataOverride={resolvedData} />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col items-center justify-center p-3 sm:p-4 animate-fade-in-up">
            <h2 className="text-lg sm:text-xl font-semibold mb-2 text-primary text-center">Export & Deploy</h2>
            <p className="text-[12px] text-muted mb-4 text-center">
                Deployment and hosting workflows are guided here. Choose an export path to continue.
            </p>

            <div className="grid md:grid-cols-2 gap-3 w-full max-w-2xl">
                <button className="interactive-card p-3 sm:p-4 text-left group bg-card hover:bg-secondary/50 border border-[hsl(var(--border-default))] rounded-lg transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-[hsl(var(--accent-blue)/0.1)] flex items-center justify-center mb-3">
                        <Share2 className="w-5 h-5 text-[hsl(var(--accent-blue))]" />
                    </div>
                    <h3 className="font-semibold text-[14px] mb-1 text-primary">Push to Hugging Face</h3>
                    <p className="text-[12px] text-muted">Upload to HF Hub for easy sharing and inference API</p>
                </button>

                <button className="interactive-card p-3 sm:p-4 text-left group bg-card hover:bg-secondary/50 border border-[hsl(var(--border-default))] rounded-lg transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-[hsl(var(--accent-green)/0.1)] flex items-center justify-center mb-3">
                        <Database className="w-5 h-5 text-[hsl(var(--accent-green))]" />
                    </div>
                    <h3 className="font-semibold text-[14px] mb-1 text-primary">Download Weights</h3>
                    <p className="text-[12px] text-muted">Get model weights (.pt/.safetensors) and config</p>
                </button>

                <button className="interactive-card p-3 sm:p-4 text-left group bg-card hover:bg-secondary/50 border border-[hsl(var(--border-default))] rounded-lg transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-[hsl(var(--accent-purple)/0.1)] flex items-center justify-center mb-3">
                        <Code className="w-5 h-5 text-[hsl(var(--accent-purple))]" />
                    </div>
                    <h3 className="font-semibold text-[14px] mb-1 text-primary">Export Code</h3>
                    <p className="text-[12px] text-muted">Generate inference script and dependencies</p>
                </button>

                <button className="interactive-card p-3 sm:p-4 text-left group bg-card hover:bg-secondary/50 border border-[hsl(var(--border-default))] rounded-lg transition-colors">
                    <div className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/10 flex items-center justify-center mb-3">
                        <Github className="w-5 h-5 text-primary" />
                    </div>
                    <h3 className="font-semibold text-[14px] mb-1 text-primary">Push to GitHub</h3>
                    <p className="text-[12px] text-muted">Create a new repo with model and training code</p>
                </button>
            </div>
        </div>
    );
}
