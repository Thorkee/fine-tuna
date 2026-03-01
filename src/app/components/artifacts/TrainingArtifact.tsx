"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Cpu } from "lucide-react";

import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";
import GenericArtifactRenderer from "@/app/components/ui/GenericArtifactRenderer";
import TerminalViewer from "@/app/components/ui/TerminalViewer";
import TrainingCurveChart from "@/app/components/artifacts/TrainingCurveChart";
import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import { parseTrainingMetrics } from "@/lib/training/parse-metrics";

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function TrainingPanelBadge() {
    const { artifacts } = useProjectArtifacts();
    const trainingData = useMemo(() => {
        const a = artifacts.find(x => x.id === "training");
        const d = a?.data;
        return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
    }, [artifacts]);

    const status = typeof trainingData?.status === "string" ? trainingData.status : "";
    const startedAt = typeof trainingData?.createdAt === "string"
        ? trainingData.createdAt
        : typeof trainingData?.updatedAt === "string"
            ? trainingData.updatedAt
            : null;

    const [elapsed, setElapsed] = useState("");

    useEffect(() => {
        if (status !== "pending" && status !== "running") return;
        const origin = startedAt ? new Date(startedAt).getTime() : Date.now();
        const base = Number.isNaN(origin) ? Date.now() : origin;

        const tick = () => setElapsed(formatElapsed(Date.now() - base));
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [status, startedAt]);

    if (status !== "pending" && status !== "running") return null;

    return (
        <span className="inline-flex items-center gap-1.5 text-[10px] text-blue-600 dark:text-blue-400">
            <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
            {elapsed && <span className="tabular-nums">{elapsed}</span>}
        </span>
    );
}

export default function TrainingArtifact(props: { dataOverride?: unknown } = {}) {
    const dataOverride = props.dataOverride;
    const { artifacts } = useProjectArtifacts();
    const resolvedData = useMemo(() => {
        if (dataOverride !== undefined) return dataOverride;
        const a = artifacts.find(x => x.id === "training");
        return a?.data as unknown;
    }, [artifacts, dataOverride]);
    const [liveData, setLiveData] = useState<Record<string, unknown> | null>(null);
    const pollRef = useRef<number | null>(null);
    const persistRef = useRef<{ lastAt: number; lastStatus?: string; timer?: number }>({
        lastAt: 0,
        lastStatus: undefined,
    });
    const finalizeRef = useRef<{ taskId?: string; inFlight: boolean; lastAttempt: number; done: boolean }>({
        taskId: undefined,
        inFlight: false,
        lastAttempt: 0,
        done: false,
    });
    const params = useParams();
    const chatId = useMemo(() => {
        const raw = (params as { chatId?: string | string[] })?.chatId;
        if (Array.isArray(raw)) return raw[0] ?? "";
        return typeof raw === "string" ? raw : "";
    }, [params]);

    const hasRawContent = Boolean(
        resolvedData !== undefined &&
        resolvedData !== null &&
        !(typeof resolvedData === "string" && !resolvedData.trim())
    );
    const baseTrainingData = resolvedData && typeof resolvedData === "object"
        ? (resolvedData as Record<string, unknown>)
        : null;
    const trainingData = useMemo(() => {
        if (!baseTrainingData && !liveData) return null;
        return { ...(baseTrainingData ?? {}), ...(liveData ?? {}) } as Record<string, unknown>;
    }, [baseTrainingData, liveData]);

    const taskId = typeof trainingData?.taskId === "string" ? trainingData.taskId : "";
    const statusRaw = typeof trainingData?.status === "string" ? trainingData.status : "";
    const status = statusRaw || (taskId ? "pending" : "idle");
    const inputName = typeof trainingData?.inputName === "string" ? trainingData.inputName : "";
    const scriptName = typeof trainingData?.scriptName === "string" ? trainingData.scriptName : "";
    const stdout = typeof trainingData?.stdout === "string" ? trainingData.stdout : "";
    const stderr = typeof trainingData?.stderr === "string" ? trainingData.stderr : "";
    const logSnippet = typeof trainingData?.logSnippet === "string" ? trainingData.logSnippet : "";
    const errorMessage = typeof trainingData?.error === "string" ? trainingData.error : "";
    const downloadUrl =
        typeof trainingData?.downloadUrl === "string"
            ? trainingData.downloadUrl
            : typeof trainingData?.modelUrl === "string"
              ? trainingData.modelUrl
              : "";
    const logUrl = typeof trainingData?.logUrl === "string" ? trainingData.logUrl : "";
    const metadataUrl = typeof trainingData?.metadataUrl === "string" ? trainingData.metadataUrl : "";
    const reportUrl = typeof trainingData?.reportUrl === "string" ? trainingData.reportUrl : "";
    const bundleUrl = typeof trainingData?.bundleUrl === "string" ? trainingData.bundleUrl : "";
    const requestedBackend = typeof trainingData?.requestedBackend === "string" ? trainingData.requestedBackend : "";
    const executionBackend = typeof trainingData?.executionBackend === "string" ? trainingData.executionBackend : "";
    const wandb = trainingData?.wandb && typeof trainingData.wandb === "object"
        ? (trainingData.wandb as Record<string, unknown>)
        : null;
    const wandbProject = typeof trainingData?.wandbProject === "string"
        ? trainingData.wandbProject
        : typeof wandb?.project === "string"
            ? wandb.project
            : "";
    const wandbRunUrl = typeof trainingData?.wandbRunUrl === "string"
        ? trainingData.wandbRunUrl
        : typeof wandb?.run_url === "string"
            ? wandb.run_url
            : typeof wandb?.runUrl === "string"
                ? wandb.runUrl
                : "";

    const stdoutText = stdout || logSnippet;
    const hasRenderableData = Boolean(trainingData && taskId);

    const isReadOnly = dataOverride !== undefined;
    const [activeStream, setActiveStream] = useState<"all" | "stdout" | "stderr">("all");
    const [activeView, setActiveView] = useState<"logs" | "curve">("logs");

    const metrics = useMemo(() => parseTrainingMetrics(stdoutText), [stdoutText]);
    const hasMetrics = metrics.length > 0;

    useEffect(() => {
        if (isReadOnly || !taskId || !chatId) return;
        if (status === "completed" || status === "failed") return;
        let cancelled = false;

        const poll = async () => {
            try {
                const resp = await fetch(`/api/runner/tasks/${taskId}/status?chatId=${chatId}`);
                if (resp.ok) {
                    const data = (await resp.json()) as Record<string, unknown>;
                    const nextStatus = typeof data.status === "string" ? data.status : status;
                    const next = {
                        kind: "e2b_training_v1",
                        taskId,
                        status: nextStatus,
                        updatedAt: new Date().toISOString(),
                        stdout: typeof data.stdout === "string" ? data.stdout : undefined,
                        stderr: typeof data.stderr === "string" ? data.stderr : undefined,
                        error: typeof data.error_message === "string" ? data.error_message : undefined,
                        outputModelKey: data.output_model_key,
                        runLogKey: data.run_log_key,
                    };
                    setLiveData((prev) => ({ ...(prev ?? {}), ...next }));
                    if (nextStatus === "completed" || nextStatus === "failed") {
                        return;
                    }
                }
            } catch {
                // ignore polling errors
            } finally {
                if (!cancelled) {
                    pollRef.current = window.setTimeout(poll, 2500);
                }
            }
        };

        poll();
        return () => {
            cancelled = true;
            if (pollRef.current) window.clearTimeout(pollRef.current);
        };
    }, [chatId, isReadOnly, status, taskId]);

    useEffect(() => {
        if (isReadOnly || !chatId || !taskId || !trainingData) return;
        if (persistRef.current.lastStatus === status && !liveData) return;

        const persist = async () => {
            const now = Date.now();
            persistRef.current.lastAt = now;
            persistRef.current.lastStatus = status;
            const payload = {
                chatId,
                artifact: {
                    id: "training",
                    type: "markdown",
                    data: trainingData,
                    status: status === "completed" ? "final" : "executing",
                    isCollaborative: false,
                },
            };
            try {
                await fetch("/api/chat/artifacts/upsert", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            } catch {
                // ignore persistence errors
            }
        };

        const now = Date.now();
        const elapsed = now - persistRef.current.lastAt;
        if (elapsed < 2000) {
            if (persistRef.current.timer) window.clearTimeout(persistRef.current.timer);
            persistRef.current.timer = window.setTimeout(persist, 2000 - elapsed);
            return;
        }
        persist();
    }, [chatId, isReadOnly, liveData, status, taskId, trainingData]);

    useEffect(() => {
        if (isReadOnly || !chatId || !taskId) return;
        if (status !== "completed") return;
        let ref = finalizeRef.current;
        if (ref.taskId !== taskId) {
            ref = { taskId, inFlight: false, lastAttempt: 0, done: false };
            finalizeRef.current = ref;
        }
        if (reportUrl && bundleUrl) {
            finalizeRef.current.done = true;
            return;
        }
        if (ref.done || ref.inFlight) return;
        const now = Date.now();
        if (now - ref.lastAttempt < 5000) return;
        ref.inFlight = true;
        ref.lastAttempt = now;

        const finalize = async () => {
            try {
                const resp = await fetch(`/api/runner/tasks/${taskId}/finalize`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chatId }),
                });
                const data = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
                if (!resp.ok || !data) return;
                if (data.ok === false) return;
                const { ok, error, ...rest } = data;
                const merged = { ...rest } as Record<string, unknown>;
                if (typeof merged.modelUrl === "string" && typeof merged.downloadUrl !== "string") {
                    merged.downloadUrl = merged.modelUrl;
                }
                if (Object.keys(merged).length > 0) {
                    setLiveData((prev) => ({ ...(prev ?? {}), ...merged }));
                }
                finalizeRef.current.done = true;
            } catch {
                // Ignore finalize errors; user can refresh or retry later.
            } finally {
                finalizeRef.current.inFlight = false;
            }
        };

        void finalize();
    }, [bundleUrl, chatId, isReadOnly, reportUrl, status, taskId]);

    const statusStyles: Record<string, string> = {
        pending: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
        running: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
        completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
        failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
        idle: "bg-zinc-100 text-zinc-600 dark:bg-zinc-700/30 dark:text-zinc-300",
    };

    if (hasRawContent && !trainingData) {
        return (
            <div className="h-full overflow-y-auto animate-fade-in-up">
                <GenericArtifactRenderer artifactId="training" dataOverride={resolvedData} />
            </div>
        );
    }

    if (!hasRenderableData) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 dark:text-zinc-400">
                <Cpu className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm font-medium">No training job yet.</p>
                <p className="text-xs mt-1">Start a training run to see logs and outputs here.</p>
                <ArtifactLoadingState
                    variant="inline"
                    title="Waiting for training updates..."
                    className="mt-3 text-xs text-zinc-400 dark:text-zinc-500"
                />
            </div>
        );
    }

    if (trainingData?.kind && trainingData.kind !== "e2b_training_v1") {
        return (
            <div className="h-full overflow-y-auto animate-fade-in-up">
                <GenericArtifactRenderer artifactId="training" dataOverride={resolvedData} />
            </div>
        );
    }

    const stdoutTrimmed = (stdoutText || "").trim();
    const stderrTrimmed = (stderr || "").trim();
    const errorTrimmed = (errorMessage || "").trim();
    const hasStdout = Boolean(stdoutTrimmed);
    const hasStderr = Boolean(stderrTrimmed);
    const hasAnyLog = hasStdout || hasStderr || Boolean(errorTrimmed);

    const syntheticError =
        errorTrimmed && (!hasStderr || !stderrTrimmed.includes(errorTrimmed))
            ? `ERROR: ${errorTrimmed}\n\n`
            : "";

    const combinedLogs = (() => {
        const parts: string[] = [];
        if (syntheticError) parts.push(syntheticError);
        if (hasStdout) parts.push(stdoutTrimmed);
        if (hasStderr) {
            parts.push(`${hasStdout ? "\n\n" : ""}----- STDERR -----\n${stderrTrimmed}`);
        }
        const combined = parts.join("");
        return combined.trim() ? combined : "No output yet.";
    })();

    const terminalContent =
        activeStream === "stdout"
            ? (stdoutTrimmed || "No output yet.")
            : activeStream === "stderr"
              ? ((stderrTrimmed || syntheticError.trim()) ? `${syntheticError}${stderrTrimmed}`.trim() : "No errors.")
              : combinedLogs;

    const terminalVariant: "default" | "error" =
        activeStream === "stderr" || (activeStream === "all" && status === "failed" && !hasStdout && hasStderr)
            ? "error"
            : "default";

    return (
        <div className="h-full overflow-y-auto p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${statusStyles[status] || statusStyles.idle}`}>
                    {status}
                </span>
                {taskId ? (
                    <span className="font-mono text-zinc-600 dark:text-zinc-300">Task {taskId.slice(0, 8)}</span>
                ) : null}
                {requestedBackend ? <span>Requested backend {requestedBackend}</span> : null}
                {executionBackend ? <span>Executed on {executionBackend}</span> : null}
                {wandbProject ? <span>W&amp;B {wandbProject}</span> : null}
                {wandbRunUrl ? (
                    <a
                        href={wandbRunUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 text-blue-600 dark:text-blue-300"
                    >
                        W&amp;B run
                    </a>
                ) : null}
                {scriptName ? <span className="truncate">Script {scriptName}</span> : null}
                {inputName ? <span className="truncate">Input {inputName}</span> : null}
            </div>

            <div className="flex items-center gap-1 rounded-full border border-zinc-200/70 dark:border-white/10 bg-white/70 dark:bg-white/5 p-0.5 w-fit">
                <button
                    type="button"
                    onClick={() => setActiveView("logs")}
                    className={[
                        "px-3 py-1 rounded-full text-[11px] font-medium transition-colors",
                        activeView === "logs"
                            ? "bg-zinc-900 text-white dark:bg-white/15 dark:text-zinc-100"
                            : "text-zinc-600 hover:bg-zinc-100/80 dark:text-zinc-300 dark:hover:bg-white/10",
                    ].join(" ")}
                >
                    Logs
                </button>
                <button
                    type="button"
                    onClick={() => setActiveView("curve")}
                    className={[
                        "px-3 py-1 rounded-full text-[11px] font-medium transition-colors",
                        !hasMetrics ? "opacity-40 cursor-not-allowed" : "",
                        activeView === "curve"
                            ? "bg-zinc-900 text-white dark:bg-white/15 dark:text-zinc-100"
                            : "text-zinc-600 hover:bg-zinc-100/80 dark:text-zinc-300 dark:hover:bg-white/10",
                    ].join(" ")}
                    disabled={!hasMetrics}
                >
                    Curve
                    {hasMetrics ? (
                        <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                    ) : null}
                </button>
            </div>

            {activeView === "curve" ? (
                <TrainingCurveChart metrics={metrics} />
            ) : (
                <div className="glass-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="text-xs text-zinc-500">
                            Logs{hasAnyLog ? "" : " (waiting…)"}
                        </div>
                        <div className="flex items-center gap-1 rounded-full border border-zinc-200/70 dark:border-white/10 bg-white/70 dark:bg-white/5 p-0.5">
                            <button
                                type="button"
                                onClick={() => setActiveStream("all")}
                                className={[
                                    "px-2 py-1 rounded-full text-[10px] transition-colors",
                                    activeStream === "all"
                                        ? "bg-zinc-900 text-white dark:bg-white/15 dark:text-zinc-100"
                                        : "text-zinc-600 hover:bg-zinc-100/80 dark:text-zinc-300 dark:hover:bg-white/10",
                                ].join(" ")}
                            >
                                All
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveStream("stdout")}
                                className={[
                                    "px-2 py-1 rounded-full text-[10px] transition-colors",
                                    activeStream === "stdout"
                                        ? "bg-zinc-900 text-white dark:bg-white/15 dark:text-zinc-100"
                                        : "text-zinc-600 hover:bg-zinc-100/80 dark:text-zinc-300 dark:hover:bg-white/10",
                                ].join(" ")}
                            >
                                Stdout
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveStream("stderr")}
                                disabled={!hasStderr && !errorTrimmed}
                                className={[
                                    "px-2 py-1 rounded-full text-[10px] transition-colors",
                                    (!hasStderr && !errorTrimmed) ? "opacity-40 cursor-not-allowed" : "",
                                    activeStream === "stderr"
                                        ? "bg-zinc-900 text-white dark:bg-white/15 dark:text-zinc-100"
                                        : "text-zinc-600 hover:bg-zinc-100/80 dark:text-zinc-300 dark:hover:bg-white/10",
                                ].join(" ")}
                            >
                                Stderr
                            </button>
                        </div>
                    </div>
                    <TerminalViewer content={terminalContent} variant={terminalVariant} />
                </div>
            )}

            <div className="flex flex-wrap gap-3 text-xs">
                {downloadUrl ? (
                    <a
                        className="text-emerald-600 dark:text-emerald-300 hover:underline"
                        href={downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Model
                    </a>
                ) : (
                    <span className="text-zinc-400">No model yet</span>
                )}
                {reportUrl ? (
                    <a
                        className="text-emerald-600 dark:text-emerald-300 hover:underline"
                        href={reportUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Report (PDF)
                    </a>
                ) : null}
                {bundleUrl ? (
                    <a
                        className="text-emerald-600 dark:text-emerald-300 hover:underline"
                        href={bundleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Bundle (ZIP)
                    </a>
                ) : null}
                {logUrl ? (
                    <a
                        className="text-emerald-600 dark:text-emerald-300 hover:underline"
                        href={logUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Log
                    </a>
                ) : null}
                {metadataUrl ? (
                    <a
                        className="text-emerald-600 dark:text-emerald-300 hover:underline"
                        href={metadataUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Metadata
                    </a>
                ) : null}
            </div>
        </div>
    );
}
