"use server";

import { createClient } from "@/lib/supabase/server";
import { ProjectContext, type ProjectMode } from "@/types";
import { AgentCoordinator } from "@/lib/agent/coordinator";
import { buildSourcePolicySettings } from "@/lib/agent/source-policy";
import { getMcpServerConfigs } from "@/lib/mcp/config";
import { getDefaultMcpEnabledServers } from "@/lib/mcp/defaults";
import { applyFirecrawlTokenToMcpServers } from "@/lib/mcp/firecrawl";
import { listUserMcpServers } from "@/lib/mcp/user-servers";
import type { McpRuntimeServerConfig } from "@/lib/mcp/runtime";
import { parseProfileContext, resolvePreferredMode } from "@/lib/profile/profile-context";
import { getConfiguredLlmProvider } from "@/lib/llm/provider";
import { getLlmRuntime } from "@/lib/llm/runtime";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

function parsePositiveIntEnv(...varNames: string[]): number | undefined {
    for (const varName of varNames) {
        const raw = process.env[varName];
        if (!raw) continue;
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        return n;
    }
    return undefined;
}

function normalizeServerIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}

function readMcpExplicitFlag(rawMcp: Record<string, unknown> | null): boolean {
    if (!rawMcp) return false;
    return rawMcp.explicit === true;
}

function readMcpEnabledServers(
    prefs: Record<string, unknown>,
    availableServerIds?: string[]
): { enabledServers: string[]; hasExplicitConfig: boolean } {
    const rawMcp = typeof prefs.mcp === "object" && prefs.mcp !== null
        ? (prefs.mcp as Record<string, unknown>)
        : null;
    const hasAvailableList = Array.isArray(availableServerIds);
    const available = new Set(normalizeServerIds(availableServerIds));
    const explicit = readMcpExplicitFlag(rawMcp);
    const hasExplicitConfig = explicit;
    const enabled = explicit
        ? normalizeServerIds(rawMcp?.enabled_servers)
        : getDefaultMcpEnabledServers(availableServerIds);
    const filtered = hasAvailableList ? enabled.filter((id) => available.has(id)) : enabled;
    return { enabledServers: filtered, hasExplicitConfig };
}

export interface ChatResponse {
    content: string;
    ui?: {
        upserts?: { id: string; type: string; data: unknown }[];
        openArtifactId?: string;
    };
    status?: {
        phase: string;
        events: { label: string; detail?: string; at: string }[];
    };
    toolCall?: {
        name: "open_artifact";
        args: { id: string };
    };
}

export interface PythonExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

export async function executePython(code: string): Promise<PythonExecutionResult> {
    'use server';
    if (process.env.VERCEL) {
        return {
            stdout: "",
            stderr: "Python execution is not available in Vercel serverless runtimes.",
            exitCode: -1,
        };
    }
    return new Promise((resolve) => {
        const pythonProcess = spawn("python3", ["-c", code]);
        let stdout = "";
        let stderr = "";

        // Collect stdout
        pythonProcess.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        // Collect stderr
        pythonProcess.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        // Set a timeout to kill the process if it runs too long
        const timeout = setTimeout(() => {
            pythonProcess.kill();
            resolve({
                stdout,
                stderr: stderr + "\nExecution timed out after 10 seconds.",
                exitCode: -1,
            });
        }, 10000); // 10 seconds timeout

        // Handle process completion
        pythonProcess.on("close", (code) => {
            clearTimeout(timeout);
            resolve({
                stdout,
                stderr,
                exitCode: code,
            });
        });

        // Handle process errors (e.g., python3 not found)
        pythonProcess.on("error", (err) => {
            clearTimeout(timeout);
            resolve({
                stdout: "",
                stderr: "Failed to start Python process. Make sure 'python3' is installed and in your PATH.\n" + err.message,
                exitCode: -1,
            });
        });
    });
}

export async function submitUserMessage(
    userMessage: string,
    history: { role: "user" | "assistant"; content: string }[],
    opts?: { chatId?: string }
): Promise<ChatResponse> {
    'use server';
    const supabase = await createClient();
    const authedUserId = (await supabase.auth.getUser()).data.user?.id;
    let userProfile: ProjectContext["userProfile"] | undefined;
    let preferredMode: ProjectMode | null = null;
    let skillPreferences: ProjectContext["skillPreferences"] | undefined;
    let mcpEnabledServers: string[] | undefined;
    let mcpServers: McpRuntimeServerConfig[] | undefined;
    let userPrefs: Record<string, unknown> | null = null;

    if (authedUserId) {
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("full_name, preferences")
            .eq("id", authedUserId)
            .maybeSingle();
        if (profileErr) {
            console.error("Failed to load user profile:", profileErr.message);
        } else if (profile) {
            const parsed = parseProfileContext(profile);
            userPrefs = parsed.prefs;
            preferredMode = parsed.preferredMode;
            skillPreferences = parsed.skillPreferences;
            userProfile = parsed.userProfile;
        }
    }
    if (authedUserId) {
        try {
            const envConfigs = await applyFirecrawlTokenToMcpServers(getMcpServerConfigs(), authedUserId);
            const envServers = envConfigs.map((server) => ({
                ...server,
                origin: "env" as const,
            }));
            const userRows = await listUserMcpServers(authedUserId);
            const userServers = userRows.map((row) => ({
                id: row.id,
                label: row.label,
                transport: "http" as const,
                url: row.url,
                headers: row.headers ?? {},
                origin: "user" as const,
                userServerId: row.id,
            }));
            const combined = [...envServers, ...userServers];
            const availableIds = combined.map((server) => server.id);
            const resolvedPrefs = userPrefs ?? {};
            const mcpPref = readMcpEnabledServers(resolvedPrefs, availableIds);
            mcpEnabledServers = mcpPref.enabledServers;
            const enabledSet = new Set(mcpEnabledServers ?? []);
            const filtered = enabledSet.size > 0
                ? combined.filter((server) => enabledSet.has(server.id))
                : [];
            if (filtered.length > 0) {
                mcpServers = filtered;
            }
        } catch (error) {
            console.error("Failed to load MCP servers:", error);
        }
    }

    // 1. Construct a minimal context for the chat
    // In a real app, this would come from a database based on the projectId
    const context: ProjectContext = {
        projectId: opts?.chatId || randomUUID(),
        userId: authedUserId || "demo-user",
        mode: resolvePreferredMode(preferredMode),
        createdAt: new Date(),
        userProfile,
        skillPreferences,
        dataContext: null, // We could populate this if files were uploaded
        edaContext: null,
        goalContext: null,
        preparationContext: null,
        providerContext: null,
        trainingContext: null,
        exportContext: null,
    };

    try {
        // Agentic loop (server-side coordinator). Uses persisted state keyed by `projectId`.
        const coordinator = new AgentCoordinator({
            ...context,
            sessionId: context.projectId,
            mcpServers,
            constraints: {
                noClientSecrets: true,
                provider: getConfiguredLlmProvider(),
                allowWebSearch: Boolean(process.env.EXA_API_KEY),
                sourcePolicy: buildSourcePolicySettings(),
                mcp: mcpEnabledServers ? { enabledServers: mcpEnabledServers } : undefined,
            },
            // Override budgets each request so existing chats don't remain stuck with old defaults.
            budgets: {
                maxIterations:
                    parsePositiveIntEnv('TUNA_AGENT_MAX_ITERATIONS')
                    ?? parsePositiveIntEnv('AGENT_MAX_ITERATIONS')
                    ?? 60,
                maxToolCallsTotal:
                    parsePositiveIntEnv('TUNA_AGENT_MAX_TOOL_CALLS_TOTAL')
                    ?? parsePositiveIntEnv('AGENT_MAX_TOOL_CALLS_TOTAL')
                    ?? 250,
                maxRunMs:
                    parsePositiveIntEnv('TUNA_AGENT_MAX_RUN_MS')
                    ?? parsePositiveIntEnv('AGENT_MAX_RUN_MS')
                    ?? 600_000,
            },
        });
        // Pass chat history so the agent can see prior context even if
        // disk-backed state isn't available (e.g., serverless runtimes).
        const result = await coordinator.processMessage(userMessage, { history });

        const openArtifactId = result.ui?.openArtifactId;

        return {
            content: result.content,
            toolCall: openArtifactId ? { name: "open_artifact", args: { id: openArtifactId } } : undefined,
            ui: result.ui ? { openArtifactId, upserts: result.ui.upserts } : undefined,
            status: result.status,
        };
    } catch (error) {
        console.error("Error in submitUserMessage:", error);
        return {
            content: "I'm sorry, I'm having trouble connecting to the AI service right now. Please try again.",
        };
    }
}

function sanitizeGeneratedTitle(raw: string): string {
    const cleaned = (raw || "").trim();
    if (!cleaned) return "New chat";

    const lines = cleaned
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    // Prefer first non-code-fence line.
    let title = (lines.find((l) => !l.startsWith("```")) || lines[0] || "").trim();

    // Strip wrapping quotes.
    title = title.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();

    // Strip common prefixes like "Title:".
    title = title.replace(/^(title|workload)\s*:\s*/i, "").trim();

    // Collapse whitespace + remove trailing punctuation.
    title = title.replace(/\s+/g, " ").replace(/[.?!:;,\s]+$/, "").trim();

    const MAX = 80;
    if (title.length > MAX) title = title.slice(0, MAX).trim();

    return title || "New chat";
}

export async function generateChatTitle(input: {
    prompt: string;
    files?: string[];
    chatId?: string;
}): Promise<{ title: string }> {
    'use server';
    const prompt = (input?.prompt || "").trim();
    if (!prompt) return { title: "New chat" };

    const supabase = await createClient();
    const authedUserId = (await supabase.auth.getUser()).data.user?.id;
    let userProfile: ProjectContext["userProfile"] | undefined;
    let preferredMode: ProjectMode | null = null;
    let skillPreferences: ProjectContext["skillPreferences"] | undefined;
    if (authedUserId) {
        const { data: profile, error: profileErr } = await supabase
            .from("profiles")
            .select("full_name, preferences")
            .eq("id", authedUserId)
            .maybeSingle();
        if (profileErr) {
            console.error("Failed to load user profile:", profileErr.message);
        } else if (profile) {
            const parsed = parseProfileContext(profile);
            preferredMode = parsed.preferredMode;
            skillPreferences = parsed.skillPreferences;
            userProfile = parsed.userProfile;
        }
    }
    const context: ProjectContext = {
        projectId: input.chatId || randomUUID(),
        userId: authedUserId || "demo-user",
        mode: resolvePreferredMode(preferredMode),
        createdAt: new Date(),
        userProfile,
        skillPreferences,
        dataContext: null,
        edaContext: null,
        goalContext: null,
        preparationContext: null,
        providerContext: null,
        trainingContext: null,
        exportContext: null,
    };

    const fileList =
        Array.isArray(input.files) && input.files.length > 0
            ? `\n\nAttached files:\n- ${input.files.slice(0, 8).join("\n- ")}`
            : "";

    const titlePrompt = [
        "Generate a concise workload title for this chat.",
        "Rules:",
        "- 3 to 7 words",
        "- Title Case",
        "- No quotes",
        "- No trailing punctuation",
        "- Output ONLY the title text",
        "",
        "User request:",
        prompt.slice(0, 1200),
        fileList,
    ]
        .filter(Boolean)
        .join("\n");

    const llm = getLlmRuntime(getConfiguredLlmProvider());
    const raw = await llm.chat(
        [{ role: "user", content: titlePrompt }],
        context,
        { temperature: 0.2, maxTokens: 32 }
    );

    return { title: sanitizeGeneratedTitle(raw) };
}
