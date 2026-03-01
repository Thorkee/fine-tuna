"use client";

import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { Terminal } from "lucide-react";

interface ChatCodeArtifactProps {
    language: string;
    code: string;
    isDark?: boolean;
    onOpenSandboxPanel?: () => void;
}

function hasSandboxMetadata(code: string): boolean {
    return code.split('\n').some(
        line => line.trim().startsWith('# Title:') || line.trim().startsWith('# Summary:')
    );
}

export default function ChatCodeArtifact({
    language,
    code,
    isDark = false,
    onOpenSandboxPanel,
}: ChatCodeArtifactProps) {
    const { setSandboxCode } = useProjectArtifacts();

    const isSandboxPython = language === 'python' && hasSandboxMetadata(code);

    // For non-sandbox code (any language, or Python without sandbox markers), show as a normal code block
    if (!isSandboxPython) {
        return (
            <pre
                className={`not-prose my-1.5 max-w-full p-3 rounded-xl font-mono text-[12px] overflow-x-auto whitespace-pre glass-inset ${isDark
                    ? "text-zinc-300"
                    : "text-zinc-800"
                    }`}
            >
                <code className={`language-${language}`}>{code}</code>
            </pre>
        );
    }

    // Sandbox-intended Python: extract metadata and show compact card
    const lines = code.split('\n');
    let title = 'Analysis';
    let summary = '';

    for (const line of lines) {
        if (line.trim().startsWith('# Title:')) {
            title = line.replace('# Title:', '').trim();
        } else if (line.trim().startsWith('# Summary:')) {
            summary = line.replace('# Summary:', '').trim();
        }
    }

    if (!summary) {
        const firstRealLine = lines.find(l => l.trim().length > 0 && !l.trim().startsWith('#'));
        summary = firstRealLine ? firstRealLine.substring(0, 60) + (firstRealLine.length > 60 ? '...' : '') : '';
    }

    const handleOpenSandbox = () => {
        setSandboxCode(code);
        if (onOpenSandboxPanel) {
            onOpenSandboxPanel();
        }
    };

    return (
        <div
            className={`my-1.5 w-full max-w-sm p-3 rounded-xl glass-card select-none overflow-hidden ${isDark
                ? "text-zinc-100"
                : "text-zinc-900"
                }`}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 overflow-hidden">
                    <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center glass-inset ${isDark
                            ? "text-zinc-400"
                            : "text-zinc-500"
                            }`}
                    >
                        <Terminal className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex flex-col overflow-hidden">
                        <span className="text-[12px] font-medium truncate">
                            {title}
                        </span>
                        {summary ? (
                            <span className={`text-[10px] truncate leading-tight ${isDark ? "text-zinc-400" : "text-zinc-500"}`}>
                                {summary}
                            </span>
                        ) : null}
                    </div>
                </div>
                {onOpenSandboxPanel ? (
                    <button
                        type="button"
                        onClick={handleOpenSandbox}
                        className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${
                            isDark
                                ? "border-white/10 text-zinc-200 hover:bg-white/10"
                                : "border-black/10 text-zinc-700 hover:bg-black/5"
                            }`}
                    >
                        Open in Sandbox
                    </button>
                ) : null}
            </div>

            <div className="hidden">{code}</div>
        </div>
    );
}
