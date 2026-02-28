import type { ProjectContext, Message } from '@/types';
import type { FunctionDefinition } from '@/lib/azure-openai/service';
import type { McpRuntime, McpRuntimeServerConfig } from '@/lib/mcp/runtime';

// ============= Core Identities =============

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentLlmSettings {
    /**
     * Controls how much hidden reasoning effort the model should spend.
     * Passed through to GPT-5.x via provider adapters when supported.
     */
    reasoningEffort?: ReasoningEffort;
}

export interface AgentContext extends ProjectContext {
    sessionId: string;
    activeArtifactId?: string;
    activeSkill?: string;
    inputFiles?: AgentInputFile[];
    /**
     * Optional: per-request budgets/constraints. If omitted, coordinator defaults apply.
     * This must NOT include any secrets; providers are configured via env on server.
     */
    budgets?: AgentBudgets;
    constraints?: AgentConstraints;
    /**
     * Server-only MCP runtime and configured servers for this run.
     * These must never be serialized to the client.
     */
    mcpServers?: McpRuntimeServerConfig[];
    mcpRuntime?: McpRuntime;
}

export interface AgentInputFile {
    id: string;
    name: string;
    size: number;
    mimeType?: string;
    storagePath?: string;
}

export type AgentPhase =
    | 'idle'
    | 'planning'
    | 'executing'
    | 'verifying'
    | 'reflecting'
    | 'blocked'
    | 'done'
    | 'failed';

export type AgentStatusLabel =
    | 'thinking'
    | 'planning'
    | 'executing'
    | 'verifying'
    | 'reflecting'
    | 'web_search'
    | 'reading'
    | 'writing'
    | 'blocked'
    | 'done'
    | 'failed';

export interface AgentStatusEvent {
    label: AgentStatusLabel;
    detail?: string;
    at: string;
}

export interface AgentStatusSummary {
    phase: AgentPhase;
    events: AgentStatusEvent[];
}

export interface AgentBudgets {
    /**
     * Total coordinator iterations allowed per `processMessage` call.
     * (An iteration may include an LLM call + N tool calls.)
     */
    maxIterations: number;
    /**
     * Total tool calls allowed per `processMessage` call.
     */
    maxToolCallsTotal: number;
    /**
     * Safety timeout for a single `processMessage` call.
     */
    maxRunMs: number;
}

export interface AgentConstraints {
    /**
     * Prevent accidental leakage. Enforced by tool gates + server-only execution.
     */
    noClientSecrets: true;
    /**
     * The configured provider family. The coordinator uses this for policy decisions only;
     * actual network calls are handled by provider adapters.
     */
    provider: 'azure_openai' | 'openai' | 'aws_bedrock';
    /**
     * Whether network/web search tools are permitted.
     */
    allowWebSearch?: boolean;
    /**
     * Optional, non-secret policy controls for dataset/model source selection.
     * These settings are advisory at prompt level and enforceable in tool gates.
     */
    sourcePolicy?: AgentSourcePolicy;
    /**
     * MCP (Model Context Protocol) configuration. All configured servers are enabled
     * by default — no gating is applied.
     */
    mcp?: {
        enabledServers?: string[];
    };
}

export type SourcePolicyStrictness = 'off' | 'prefer' | 'strict';

export interface AgentSourcePolicy {
    strictness?: SourcePolicyStrictness;
    fallbackToGovSources?: boolean;
    fallbackToOpenWeb?: boolean;
    benchmarkMaxAgeDays?: number;
    minResultsPerTier?: number;
    preferredBaseModels?: string[];
    datasetTier1Domains?: string[];
    datasetTier2Domains?: string[];
    modelTier1Domains?: string[];
    modelTier2Domains?: string[];
    benchmarkDomains?: string[];
}

export type McpPendingApproval = {
    kind: 'mcp_tool';
    toolName: string;
    toolCall: unknown;
    skillId: string;
    serverId: string;
    userServerId?: string;
    requestedAt: string;
};

export interface AgentState {
    runId: string;
    phase: AgentPhase;
    goal: string | null;
    successCriteria: string[];
    constraints: AgentConstraints;
    budgets: AgentBudgets;
    llm: AgentLlmSettings;
    plan: PlanStep[];
    memory: ConversationMemory;
    artifacts: AgentArtifact[];
    activeSkillId: string;
    ui: AgentUiState;
    activeErrors: string[];
    stopRequested?: { at: string; reason?: string };
    pendingApproval?: McpPendingApproval;
    /**
     * Set by the `signal_completion` tool when the agent explicitly declares it is done.
     * The coordinator checks this after tool execution to trigger a clean exit.
     */
    completionSignal?: {
        summary: string;
        unfinishedItems?: string[];
        signalledAt: string;
    };
}

export type AgentContextUsage = {
    inputTokens: number;
    maxInputTokens?: number;
    usedFraction?: number;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    updatedAt?: string;
};

export interface AgentUiState {
    /**
     * If set, the client should open this artifact id in the Canvas.
     */
    openArtifactId?: string;
    /**
     * Persisted, per-chat timeline of Canvas frames for replay/scrubbing.
     * Stored in agent state so it survives refresh and syncs across devices.
     */
    canvasTimeline?: CanvasTimelineEvent[];
    /**
     * Last known context usage snapshot (for UI display).
     * This is updated opportunistically during runs and persisted with agent state.
     */
    contextUsage?: AgentContextUsage;
}

export type CanvasTimelineEventKind = 'upsert' | 'open';

export interface CanvasTimelineEvent {
    /** Monotonic sequence number (0-based). */
    seq: number;
    /** ISO timestamp when the frame was recorded. */
    at: string;
    /** What produced this frame. */
    kind: CanvasTimelineEventKind;
    /** Normalized artifact id (e.g. plan, research). */
    artifactId: string;
    /** Artifact type string (may be broader than Canvas ids). */
    artifactType: string;
    /** Snapshot payload for rendering this frame. */
    data: unknown;
}

export type PlanStepStatus =
    | 'todo'
    | 'doing'
    | 'blocked'
    | 'done'
    | 'failed'
    | 'skipped';

export interface PlanStep {
    id: string;
    title: string;
    description: string;
    status: PlanStepStatus;
    assignedSkillId?: string;
    toolNeeds?: string[];
    verification?: string;
    rollback?: string;
    result?: string;
    evidence?: string;
}

export interface ConversationMemory {
    shortTerm: Message[]; // Current session
    summary: string;      // Running summary of session
}

// ============= Skills & Tools =============

export interface ToolSideEffect {
    type: string;
    description?: string;
    path?: string;
    payload?: unknown;
}

export interface ToolExecutionResult<T = unknown> {
    ok: boolean;
    data?: T;
    error?: { message: string; name?: string; code?: string };
    evidence?: unknown;
    sideEffects?: ToolSideEffect[];
    meta?: { durationMs?: number };
}

export interface Tool {
    definition: FunctionDefinition;
    handler: (args: unknown, context: AgentContext) => Promise<unknown> | Promise<ToolExecutionResult>;
    category: 'core' | 'filesystem' | 'data' | 'ml' | 'ui';
}

export interface Skill {
    id: string;
    name: string;
    description: string;
    systemPrompt: string; // The specialized persona/instructions
    tools: string[];      // IDs of tools this skill can access
    suggestedArtifacts?: string[]; // Types of artifacts this skill handles
}

// ============= Artifacts (Canvas) =============

export type ArtifactType =
    | 'plan'
    | 'code'
    | 'dataset'
    | 'visualization'
    | 'model_card'
    | 'markdown'
    | 'document'
    | 'spreadsheet';

export interface AgentArtifact {
    id: string;
    type: ArtifactType;
    title: string;
    content: unknown; // content schema depends on type
    status: 'draft' | 'final' | 'executing';
    isCollaborative: boolean; // Can user edit it?
    createdAt: string; // ISO timestamp
    updatedAt: string; // ISO timestamp
}
