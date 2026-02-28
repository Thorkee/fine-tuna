import type { AgentArtifact, AgentContext, AgentState, ArtifactType, ToolExecutionResult, ToolSideEffect } from './types';
import { registry } from './registry';
import { normalizeArtifactId } from './artifact-mapping';
import { appendCanvasTimelineEvent } from './canvas-timeline';
import { uploadStorageObject } from '@/lib/supabase/storage';
import { parseMcpToolName } from '../mcp/naming';
import {
    detectDiscoveryIntent,
    evaluateDesktopEscalationGuard,
    isDomainAllowed,
    sourcePolicyFromConstraintConfig,
    type SourceFallbackReason,
    type SourceTier,
} from './source-policy';
import { getDisabledToolsFromSkillPreferences } from './skill-preferences';

// ============= Security gates =============

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
}

function isMcpToolAllowedForSkill(skillId: string, toolName: string): boolean {
    const skill = registry.getSkill(skillId);
    if (!skill) return false;
    if (skill.tools.includes('mcp_tools')) return true;
    if (skill.tools.includes(toolName)) return true;
    return false;
}

const DESKTOP_ESCALATION_TOOLS = new Set(['sandbox_browser', 'desktop_start']);
const SOURCE_POLICY_ARTIFACT_KINDS = new Set([
    'dataset_candidates_v1',
    'dataset_candidates_v2',
    'model_candidates_v1',
    'model_candidates_v2',
]);

function normalizeFallbackReasons(value: unknown): SourceFallbackReason[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const allowed = new Set<SourceFallbackReason>([
        'insufficient_results',
        'insufficient_viable_candidates',
        'insufficient_quality',
        'tier_exhausted',
    ]);
    const out = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter((item): item is SourceFallbackReason => allowed.has(item as SourceFallbackReason));
    return out.length > 0 ? out : undefined;
}

function parseAttemptTier(value: unknown): SourceTier | null {
    if (value === 'tier1' || value === 'tier2' || value === 'tier3') return value;
    return null;
}

function getLatestSourcePolicyAttempts(state: AgentState): Array<{
    tier: SourceTier;
    fallbackReasons?: SourceFallbackReason[];
    escalated?: boolean;
}> {
    const artifacts = Array.isArray(state.artifacts) ? [...state.artifacts].reverse() : [];
    for (const artifact of artifacts) {
        const content = artifact?.content;
        if (!isRecord(content)) continue;
        const kind = typeof content.kind === 'string' ? content.kind : '';
        if (!SOURCE_POLICY_ARTIFACT_KINDS.has(kind)) continue;
        const attemptsRaw = Array.isArray(content.attempts) ? content.attempts : [];
        const parsedAttempts: Array<{
            tier: SourceTier;
            fallbackReasons?: SourceFallbackReason[];
            escalated?: boolean;
        }> = [];
        for (const item of attemptsRaw) {
            if (!isRecord(item)) continue;
            const tier = parseAttemptTier(item.tier);
            if (!tier) continue;
            const fallbackReasons = normalizeFallbackReasons(item.fallbackReasons);
            const escalated = typeof item.escalated === 'boolean' ? item.escalated : undefined;
            parsedAttempts.push({ tier, fallbackReasons, escalated });
        }
        if (parsedAttempts.length > 0) return parsedAttempts;
    }
    return [];
}

function validateSourcePolicyForTool(
    toolName: string,
    args: unknown,
    context: AgentContext,
    state: AgentState
): ToolExecutionResult | null {
    if (!isRecord(args)) return null;
    const sourcePolicy = sourcePolicyFromConstraintConfig(context.constraints?.sourcePolicy);
    if (sourcePolicy.strictness === 'off') return null;

    if (DESKTOP_ESCALATION_TOOLS.has(toolName)) {
        const intent = detectDiscoveryIntent([
            typeof state.goal === 'string' ? state.goal : '',
            typeof state.memory?.summary === 'string' ? state.memory.summary : '',
            typeof args.query === 'string' ? args.query : '',
        ]);
        if (intent === 'general') return null;

        const attempts = getLatestSourcePolicyAttempts(state);
        const guard = evaluateDesktopEscalationGuard({
            strictness: sourcePolicy.strictness,
            intent,
            attempts,
            requireOpenWebTier: sourcePolicy.fallbackToOpenWeb,
        });
        if (!guard.allowed) {
            return {
                ok: false,
                error: {
                    name: 'PolicyError',
                    message:
                        'Desktop escalation requires prior HF-first fallback evidence. Run dataset_search/model_search (and open-web tier when enabled) before starting desktop tools.',
                },
                data: {
                    intent,
                    strictness: sourcePolicy.strictness,
                    unmetRequirements: guard.unmetRequirements,
                },
            };
        }
    }

    if (toolName === 'web_search') {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const queries = toStringArray(args.queries);
        const intent = detectDiscoveryIntent([query, ...queries]);
        if (intent === 'general') return null;
        if (sourcePolicy.strictness !== 'strict') return null;

        const includeDomains = toStringArray(args.includeDomains);
        if (includeDomains.length === 0) return null;
        const disallowed = includeDomains.filter((domain) => !isDomainAllowed(domain, intent, sourcePolicy));
        if (disallowed.length === 0) return null;
        return {
            ok: false,
            error: {
                name: 'PolicyError',
                message: `Source policy blocked includeDomains for ${intent} search in strict mode.`,
            },
            data: { disallowedDomains: disallowed, intent },
        };
    }

    if (toolName === 'web_fetch') {
        const urls = toStringArray(args.urls);
        if (urls.length === 0) return null;
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const intent = detectDiscoveryIntent(`${query} ${urls.join(' ')}`);
        if (intent === 'general') return null;
        if (sourcePolicy.strictness !== 'strict') return null;
        const blockedUrls = urls.filter((url) => !isDomainAllowed(url, intent, sourcePolicy));
        if (blockedUrls.length === 0) return null;
        return {
            ok: false,
            error: {
                name: 'PolicyError',
                message: `Source policy blocked ${blockedUrls.length} URL(s) for ${intent} fetch in strict mode.`,
            },
            data: { blockedUrls, intent },
        };
    }

    return null;
}

function normalizeRepoPath(input: string): string {
    return input.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function isSensitiveRepoPath(relPath: string): boolean {
    const p = normalizeRepoPath(relPath).toLowerCase();
    if (!p) return false;

    // Block environment files (frequently contain secrets).
    if (p === '.env' || p.startsWith('.env.')) return true;
    if (p.includes('/.env') && (p.endsWith('/.env') || p.includes('/.env.'))) return true;

    // Block git internals.
    if (p === '.git' || p.startsWith('.git/')) return true;
    if (p.includes('/.git/')) return true;

    // Block node_modules (too large + not useful).
    if (p === 'node_modules' || p.startsWith('node_modules/')) return true;
    if (p.includes('/node_modules/')) return true;

    // Block local agent state dirs from being read by the model.
    if (p === '.tuna' || p.startsWith('.tuna/')) return true;
    if (p.includes('/.tuna/')) return true;

    return false;
}

// ============= Transient error detection for MCP retries =============

function isMcpTransientError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    // Network-level errors
    if (lower.includes('timed out') || lower.includes('timeout')) return true;
    if (lower.includes('econnreset') || lower.includes('econnrefused')) return true;
    if (lower.includes('enotfound') || lower.includes('eai_again')) return true;
    if (lower.includes('fetch failed')) return true;
    if (lower.includes('network') && lower.includes('error')) return true;
    if (lower.includes('socket') && (lower.includes('hang up') || lower.includes('error'))) return true;
    if (lower.includes('aborted')) return true;
    if (lower.includes('connection closed') || lower.includes('connection reset')) return true;

    // MCP server-side errors
    if (lower.includes('mcp server unavailable')) return true;
    if (lower.includes('mcp') && lower.includes('transport')) return true;
    if (lower.includes('internal error') || lower.includes('internal server error')) return true;
    if (/\b(500|502|503|504|429)\b/.test(message)) return true;
    if (lower.includes('rate limit') || lower.includes('too many requests')) return true;
    if (lower.includes('server error') || lower.includes('service unavailable')) return true;

    // Error code detection
    const code = (() => {
        if (!err || typeof err !== 'object') return undefined;
        const record = err as { code?: unknown; cause?: unknown };
        if (typeof record.code === 'string') return record.code;
        const cause = record.cause;
        if (cause && typeof cause === 'object') {
            const causeCode = (cause as { code?: unknown }).code;
            if (typeof causeCode === 'string') return causeCode;
        }
        return undefined;
    })();
    if (code) {
        const transientCodes = new Set([
            'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
            'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
        ]);
        if (transientCodes.has(code) || code.startsWith('UND_ERR_')) return true;
    }

    return false;
}

// ============= Tool output normalization =============

function normalizeToolOutput(output: unknown): ToolExecutionResult {
    // Already normalized
    if (typeof output === 'object' && output !== null && 'ok' in output) {
        return output as ToolExecutionResult;
    }

    // Common legacy pattern: { error: string }
    if (isRecord(output) && 'error' in output) {
        const err = output.error;
        if (typeof err === 'string' && err.trim().length > 0) {
            const rest: Record<string, unknown> = { ...output };
            delete rest.error;
            return {
                ok: false,
                error: { message: err },
                data: Object.keys(rest).length > 0 ? rest : undefined,
            };
        }
    }

    return { ok: true, data: output };
}

// ============= Side effects application =============

export interface UiUpsert {
    id: string;
    type: string;
    data: unknown;
    at?: string;
}

export interface UiOpen {
    id: string;
    at?: string;
}

const ARTIFACT_TYPES: readonly ArtifactType[] = [
    'plan',
    'code',
    'dataset',
    'visualization',
    'model_card',
    'markdown',
    'document',
    'spreadsheet',
] as const;
function toArtifactType(value: unknown): ArtifactType {
    return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value)
        ? (value as ArtifactType)
        : 'markdown';
}

const ARTIFACT_STATUSES: readonly AgentArtifact['status'][] = ['draft', 'final', 'executing'] as const;
function toArtifactStatus(value: unknown): AgentArtifact['status'] {
    return typeof value === 'string' && (ARTIFACT_STATUSES as readonly string[]).includes(value)
        ? (value as AgentArtifact['status'])
        : 'draft';
}

function safeStorageSegment(value: string, fallback: string): string {
    const cleaned = value
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned || fallback;
}

function canUseStoragePrefix(value: string): boolean {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    if (!normalized) return false;
    if (normalized.includes('\0')) return false;
    if (normalized.startsWith('/')) return false;
    if (normalized.split('/').includes('..')) return false;
    return true;
}

function shouldMirrorArtifactToRuntime(artifactId: string): boolean {
    const id = artifactId.trim().toLowerCase();
    if (!id) return false;
    // These artifacts are already represented by dedicated runtime files/endpoints.
    if (id === 'sandbox' || id === 'training' || id === 'intent') return false;
    return true;
}

function encodeRuntimeArtifactSnapshot(artifactId: string, artifactType: string, artifactData: unknown): {
    ext: 'md' | 'json';
    contentType: string;
    body: Buffer;
} {
    if (typeof artifactData === 'string') {
        return {
            ext: 'md',
            contentType: 'text/markdown; charset=utf-8',
            body: Buffer.from(artifactData, 'utf-8'),
        };
    }
    let encoded: string;
    try {
        encoded = JSON.stringify(
            {
                artifactId,
                artifactType,
                updatedAt: new Date().toISOString(),
                content: artifactData,
            },
            null,
            2
        );
    } catch {
        encoded = JSON.stringify(
            {
                artifactId,
                artifactType,
                updatedAt: new Date().toISOString(),
                content: String(artifactData),
            },
            null,
            2
        );
    }
    return {
        ext: 'json',
        contentType: 'application/json; charset=utf-8',
        body: Buffer.from(encoded, 'utf-8'),
    };
}

async function mirrorArtifactToRuntimeStorage(
    projectId: string | undefined,
    artifactId: string,
    artifactType: string,
    artifactData: unknown
): Promise<void> {
    if (!shouldMirrorArtifactToRuntime(artifactId)) return;
    const chatId = String(projectId || '').trim();
    if (!canUseStoragePrefix(chatId)) return;
    try {
        const snapshot = encodeRuntimeArtifactSnapshot(artifactId, artifactType, artifactData);
        const fileId = safeStorageSegment(artifactId, 'artifact');
        const storagePath = `runner-outputs/${chatId}/runtime/artifacts/${fileId}.${snapshot.ext}`;
        await uploadStorageObject('artifacts', storagePath, snapshot.body, {
            contentType: snapshot.contentType,
        });
    } catch {
        // Best-effort only; never block tool execution/UI updates on storage mirroring.
    }
}

function upsertArtifact(state: AgentState, artifact: Record<string, unknown>): string | null {
    const now = new Date().toISOString();
    const normalizedId = normalizeArtifactId(
        String(artifact.id ?? ''),
        typeof artifact.type === 'string' ? artifact.type : undefined
    );
    const normalized: AgentArtifact = {
        id: normalizedId,
        type: toArtifactType(artifact.type),
        title: (artifact.title as string | undefined) ?? String(artifact.id ?? 'Artifact'),
        content: artifact.content ?? artifact.data ?? artifact.payload ?? artifact,
        status: toArtifactStatus(artifact.status),
        isCollaborative: (artifact.isCollaborative as boolean | undefined) ?? true,
        createdAt: (artifact.createdAt as string | undefined) ?? now,
        updatedAt: now,
    };

    if (!normalized.id) return null;

    const idx = state.artifacts.findIndex(a => a.id === normalized.id);
    if (idx >= 0) {
        const existing = state.artifacts[idx];
        const createdAt =
            typeof artifact.createdAt === 'string'
                ? artifact.createdAt
                : (typeof existing.createdAt === 'string' ? existing.createdAt : now);
        state.artifacts[idx] = { ...existing, ...normalized, createdAt, updatedAt: now };
    } else {
        state.artifacts.push(normalized);
    }

    return normalized.id;
}

function resolveOpenArtifactId(
    state: AgentState,
    artifactId: string,
    artifactType?: string
): string {
    const rawId = String(artifactId || '').trim();
    if (!rawId) return rawId;

    const normalized = normalizeArtifactId(rawId, artifactType);
    if (state.artifacts.some(a => a.id === normalized)) return normalized;
    if (state.artifacts.some(a => a.id === rawId)) return rawId;

    // If open payload omitted type, try to resolve against already-upserted artifacts.
    const inferred = state.artifacts.find(a => normalizeArtifactId(rawId, a.type) === a.id);
    if (inferred) return inferred.id;

    return normalized;
}

function appendCanvasTimelineFrame(
    state: AgentState,
    frame: Omit<NonNullable<AgentState['ui']['canvasTimeline']>[number], 'seq'> & { seq?: number }
) {
    state.ui.canvasTimeline = Array.isArray(state.ui.canvasTimeline) ? state.ui.canvasTimeline : [];
    appendCanvasTimelineEvent(state.ui.canvasTimeline, {
        at: frame.at,
        kind: frame.kind,
        artifactId: frame.artifactId,
        artifactType: frame.artifactType,
        data: frame.data,
    });
}

export async function applySideEffects(
    state: AgentState,
    sideEffects: ToolSideEffect[] | undefined,
    uiUpserts: UiUpsert[],
    uiOpens?: UiOpen[],
    context?: Pick<AgentContext, 'projectId'>
): Promise<void> {
    if (!sideEffects || sideEffects.length === 0) return;

    for (const eff of sideEffects) {
        switch (eff.type) {
            case 'ui.openArtifact': {
                const payload = isRecord(eff.payload) ? eff.payload : null;
                const id = payload && typeof payload.id === 'string' ? payload.id : undefined;
                if (typeof id === 'string' && id.trim()) {
                    const artifactType =
                        payload && typeof payload.type === 'string'
                            ? payload.type
                            : undefined;
                    const normalizedId = resolveOpenArtifactId(state, id, artifactType);
                    const timelineAt = new Date().toISOString();
                    state.ui.openArtifactId = normalizedId;
                    if (uiOpens) {
                        uiOpens.push({ id: normalizedId, at: timelineAt });
                    }

                    // Record a timeline frame even if this is selection-only.
                    const artifact = state.artifacts.find(a => a.id === normalizedId);
                    appendCanvasTimelineFrame(state, {
                        at: timelineAt,
                        kind: 'open',
                        artifactId: normalizedId,
                        artifactType: artifact?.type ?? 'markdown',
                        data: artifact?.content ?? null,
                    });
                }
                break;
            }
            case 'ui.upsertArtifact': {
                const payload = isRecord(eff.payload) ? eff.payload : null;
                if (!payload || typeof payload.id !== 'string' || typeof payload.type !== 'string') break;
                const normalizedId = upsertArtifact(state, payload);
                if (!normalizedId) break;
                const artifact = state.artifacts.find(a => a.id === normalizedId);
                const timelineAt = new Date().toISOString();
                const artifactType = artifact?.type ?? toArtifactType(payload.type);
                const artifactData = artifact?.content ?? payload.content ?? null;
                uiUpserts.push({
                    id: normalizedId,
                    type: artifactType,
                    data: artifactData,
                    at: timelineAt,
                });
                appendCanvasTimelineFrame(state, {
                    at: timelineAt,
                    kind: 'upsert',
                    artifactId: normalizedId,
                    artifactType,
                    data: artifactData,
                });
                await mirrorArtifactToRuntimeStorage(context?.projectId, normalizedId, artifactType, artifactData);
                break;
            }
            case 'agent.setPlan': {
                const payload = isRecord(eff.payload) ? eff.payload : null;
                if (!payload || typeof payload.goal !== 'string' || !Array.isArray(payload.steps)) break;

                const hadExistingPlan = Array.isArray(state.plan) && state.plan.length > 0;
                state.goal = payload.goal;
                state.successCriteria = Array.isArray(payload.successCriteria) ? payload.successCriteria : state.successCriteria;

                // Normalize steps (ensure ids + initial status).
                state.plan = payload.steps.map((step: unknown, idx: number) => {
                    const s = isRecord(step) ? step : {};
                    const assignedSkillRaw = typeof s.assignedSkillId === 'string' ? s.assignedSkillId : undefined;
                    const assignedSkillId =
                        typeof assignedSkillRaw === 'string' && assignedSkillRaw.trim()
                            ? (registry.resolveSkillId(assignedSkillRaw) ?? assignedSkillRaw.trim())
                            : undefined;
                    return {
                        id: typeof s.id === 'string' && s.id.trim() ? s.id : `step_${idx + 1}`,
                        title: typeof s.title === 'string' && s.title.trim() ? s.title : `Step ${idx + 1}`,
                        description: typeof s.description === 'string' ? s.description : '',
                        status: 'todo' as const,
                        assignedSkillId,
                        toolNeeds: Array.isArray(s.toolNeeds) ? (s.toolNeeds as string[]) : undefined,
                        verification: typeof s.verification === 'string' ? s.verification : undefined,
                        rollback: typeof s.rollback === 'string' ? s.rollback : undefined,
                    };
                });

                const timelineAt = new Date().toISOString();
                const planPayload = {
                    goal: state.goal,
                    successCriteria: state.successCriteria,
                    // Deep-clone steps so the uiUpsert / timeline frame captures the
                    // current snapshot and is not mutated by later updatePlanStep calls.
                    steps: JSON.parse(JSON.stringify(state.plan)),
                    meta: { action: hadExistingPlan ? 'update_plan' : 'set_plan', at: timelineAt },
                };

                // Also publish/update a plan artifact for the UI.
                upsertArtifact(state, {
                    id: 'plan',
                    type: 'plan',
                    title: 'Plan',
                    content: planPayload,
                    status: 'draft',
                    isCollaborative: true,
                });
                uiUpserts.push({ id: 'plan', type: 'plan', data: planPayload, at: timelineAt });
                // Persist a timeline frame so the plan history survives page reloads
                // and appears correctly in shared replays / timeline scrubbing.
                appendCanvasTimelineFrame(state, {
                    at: timelineAt,
                    kind: 'upsert',
                    artifactId: 'plan',
                    artifactType: 'plan',
                    data: planPayload,
                });
                state.ui.openArtifactId = state.ui.openArtifactId ?? 'plan';
                if (uiOpens) {
                    uiOpens.push({ id: state.ui.openArtifactId });
                }
                break;
            }
            case 'agent.updatePlanStep': {
                const payload = isRecord(eff.payload) ? eff.payload : null;
                if (!payload || typeof payload.id !== 'string' || typeof payload.status !== 'string') break;
                const step = state.plan.find(s => s.id === payload.id);
                if (!step) break;
                const status = payload.status;
                if (
                    status === 'todo' ||
                    status === 'doing' ||
                    status === 'blocked' ||
                    status === 'done' ||
                    status === 'failed' ||
                    status === 'skipped'
                ) {
                    step.status = status;
                }
                if (typeof payload.result === 'string') step.result = payload.result;
                if (typeof payload.evidence === 'string') step.evidence = payload.evidence;

                const stepTimelineAt = new Date().toISOString();
                const planPayload = {
                    goal: state.goal,
                    successCriteria: state.successCriteria,
                    // Deep-clone steps so the uiUpsert / timeline frame captures the
                    // current snapshot and is not mutated by later updatePlanStep calls.
                    steps: JSON.parse(JSON.stringify(state.plan)),
                    meta: { action: 'update_plan_step', at: stepTimelineAt },
                };

                // Keep plan artifact in sync.
                upsertArtifact(state, {
                    id: 'plan',
                    type: 'plan',
                    title: 'Plan',
                    content: planPayload,
                    status: 'draft',
                    isCollaborative: true,
                });
                uiUpserts.push({ id: 'plan', type: 'plan', data: planPayload, at: stepTimelineAt });
                // Persist a timeline frame so each step-status change is recorded in
                // the canvas timeline for correct playback ordering.
                appendCanvasTimelineFrame(state, {
                    at: stepTimelineAt,
                    kind: 'upsert',
                    artifactId: 'plan',
                    artifactType: 'plan',
                    data: planPayload,
                });
                state.ui.openArtifactId = state.ui.openArtifactId ?? 'plan';
                if (uiOpens) {
                    uiOpens.push({ id: state.ui.openArtifactId });
                }
                break;
            }
            case 'agent.setReasoningEffort': {
                const level =
                    isRecord(eff.payload) && typeof eff.payload.level === 'string'
                        ? eff.payload.level
                        : undefined;
                if (typeof level === 'string' && level.trim()) {
                    state.llm = state.llm ?? {};
                    if (
                        level === 'none' ||
                        level === 'minimal' ||
                        level === 'low' ||
                        level === 'medium' ||
                        level === 'high' ||
                        level === 'xhigh'
                    ) {
                        state.llm.reasoningEffort = level;
                    }
                }
                break;
            }
            case 'agent.setActiveSkill': {
                const skillId =
                    isRecord(eff.payload) && typeof eff.payload.skillId === 'string'
                        ? eff.payload.skillId
                        : undefined;
                if (typeof skillId === 'string' && skillId.trim()) {
                    const resolved = registry.resolveSkillId(skillId);
                    if (resolved) {
                        state.activeSkillId = resolved;
                    } else {
                        state.activeErrors.push(`Unknown skill requested: ${skillId.trim()}`);
                    }
                }
                break;
            }
            case 'agent.signalCompletion': {
                const payload = isRecord(eff.payload) ? eff.payload : null;
                const summary = payload && typeof payload.summary === 'string' ? payload.summary.trim() : '';
                if (summary) {
                    // Mark completion intent on state so the coordinator loop can exit cleanly.
                    state.completionSignal = {
                        summary,
                        unfinishedItems: Array.isArray(payload?.unfinishedItems)
                            ? (payload.unfinishedItems as unknown[]).filter((item): item is string => typeof item === 'string')
                            : undefined,
                        signalledAt: new Date().toISOString(),
                    };
                }
                break;
            }
            default: {
                // Ignore unknown effects for forward compatibility.
                break;
            }
        }
    }
}

// ============= Tool execution =============

export async function executeToolCall(
    call: unknown,
    skillId: string,
    context: AgentContext,
    state: AgentState,
    uiUpserts: UiUpsert[],
    uiOpens: UiOpen[],
    counters: { toolCallsTotal: number }
): Promise<{ toolName: string; result: ToolExecutionResult }> {
    const toolName = (() => {
        if (!isRecord(call)) return '';
        const fn = call.function;
        if (!isRecord(fn)) return '';
        return typeof fn.name === 'string' ? fn.name : '';
    })();

    // Parse args safely.
    let args: unknown = {};
    try {
        const argsJson = (() => {
            if (!isRecord(call)) return '{}';
            const fn = call.function;
            if (!isRecord(fn)) return '{}';
            return typeof fn.arguments === 'string' ? fn.arguments : '{}';
        })();
        args = JSON.parse(argsJson);
    } catch {
        args = {};
    }

    const mcpInfo = parseMcpToolName(toolName);
    if (mcpInfo) {
        if (!isMcpToolAllowedForSkill(skillId, toolName)) {
            const result: ToolExecutionResult = {
                ok: false,
                error: { message: `Tool not allowed for skill '${skillId}': ${toolName}` },
            };
            return { toolName, result };
        }

        const enabled = new Set(context.constraints?.mcp?.enabledServers ?? []);
        if (!enabled.has(mcpInfo.serverId)) {
            const result: ToolExecutionResult = {
                ok: false,
                error: { message: `MCP server disabled: ${mcpInfo.serverId}` },
            };
            return { toolName, result };
        }

        if (!context.mcpRuntime) {
            const result: ToolExecutionResult = {
                ok: false,
                error: { message: `MCP runtime unavailable for tool: ${toolName}` },
            };
            return { toolName, result };
        }

        counters.toolCallsTotal += 1;
        const start = Date.now();
        let normalized: ToolExecutionResult = {
            ok: false,
            error: { message: `MCP tool '${toolName}' failed after all retry attempts.` },
        };
        // Retry transient MCP tool failures (network issues, server restarts, timeouts).
        const MCP_MAX_RETRIES = 2;
        const MCP_RETRY_BASE_MS = 1_000;
        for (let attempt = 0; attempt <= MCP_MAX_RETRIES; attempt++) {
            try {
                const raw = await context.mcpRuntime.callToolByQualifiedName(toolName, args);
                normalized = normalizeToolOutput(raw);
                break;
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const name = err instanceof Error ? err.name : undefined;
                if (attempt < MCP_MAX_RETRIES && isMcpTransientError(err)) {
                    const backoffMs = MCP_RETRY_BASE_MS * Math.pow(2, attempt);
                    const jitterMs = Math.floor(Math.random() * 300);
                    console.warn(
                        `[ToolRunner] MCP tool '${toolName}' transient failure (attempt ${attempt + 1}/${MCP_MAX_RETRIES + 1}): ${message}. Retrying in ${backoffMs + jitterMs}ms...`
                    );
                    await new Promise<void>(resolve => setTimeout(resolve, backoffMs + jitterMs));
                    continue;
                }
                normalized = { ok: false, error: { message, name } };
                break;
            }
        }
        normalized.meta = { ...(normalized.meta || {}), durationMs: Date.now() - start };
        await applySideEffects(state, normalized.sideEffects, uiUpserts, uiOpens, context);
        return { toolName, result: normalized };
    }

    // Enforce skill allowlist even if the model tries to call something else.
    const allowed = new Set(registry.getToolsForSkill(skillId).map(t => t.definition.name));
    if (!allowed.has(toolName)) {
        const result: ToolExecutionResult = { ok: false, error: { message: `Tool not allowed for skill '${skillId}': ${toolName}` } };
        return { toolName, result };
    }

    const disabledByPref = getDisabledToolsFromSkillPreferences(context.skillPreferences);
    if (disabledByPref.has(toolName)) {
        const result: ToolExecutionResult = { ok: false, error: { message: `Tool disabled by skill preferences: ${toolName}` } };
        return { toolName, result };
    }

    const sourcePolicyViolation = validateSourcePolicyForTool(toolName, args, context, state);
    if (sourcePolicyViolation) {
        return { toolName, result: sourcePolicyViolation };
    }

    // Extra safety: deny reads of sensitive paths.
    if ((toolName === 'read_file' || toolName === 'list_files') && isRecord(args) && typeof args.path === 'string') {
        if (isSensitiveRepoPath(args.path)) {
            const result: ToolExecutionResult = { ok: false, error: { message: `Access denied: sensitive path '${args.path}'` } };
            return { toolName, result };
        }
    }

    const tool = registry.getTool(toolName);
    if (!tool) {
        const result: ToolExecutionResult = { ok: false, error: { message: `Tool not found: ${toolName}` } };
        return { toolName, result };
    }

    counters.toolCallsTotal += 1;
    const start = Date.now();
    let normalized: ToolExecutionResult;
    try {
        const raw = await tool.handler(args, context);
        normalized = normalizeToolOutput(raw);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : undefined;
        normalized = { ok: false, error: { message, name } };
    }
    normalized.meta = { ...(normalized.meta || {}), durationMs: Date.now() - start };

    await applySideEffects(state, normalized.sideEffects, uiUpserts, uiOpens, context);

    return { toolName, result: normalized };
}

