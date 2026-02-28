import 'server-only';

import fs from 'fs/promises';
import path from 'path';
import { createClient } from '@/lib/supabase/server';
import {
    getCanvasTimelineEventSignature,
    sortCanvasTimelineEvents,
} from './canvas-timeline';
import type { AgentArtifact, AgentState, CanvasTimelineEvent } from './types';

const STATES_DIR = (() => {
    if (process.env.VERCEL) {
        return path.join('/tmp', 'tuna', 'states');
    }
    return path.resolve(process.cwd(), '.tuna/states');
})();

const shouldFallbackToDisk = () => !process.env.VERCEL && process.env.NODE_ENV !== 'production';

async function getAuthedSupabase() {
    try {
        const supabase = await createClient();
        const { data } = await supabase.auth.getUser();
        if (!data.user?.id) return null;
        return supabase;
    } catch {
        return null;
    }
}

async function saveStateToDisk(projectId: string, state: AgentState): Promise<void> {
    await fs.mkdir(STATES_DIR, { recursive: true });
    const filePath = path.join(STATES_DIR, `${projectId}.json`);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

async function loadStateFromDisk(projectId: string): Promise<AgentState | null> {
    const filePath = path.join(STATES_DIR, `${projectId}.json`);
    await fs.access(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as AgentState;
}

async function clearStateFromDisk(projectId: string): Promise<void> {
    const filePath = path.join(STATES_DIR, `${projectId}.json`);
    await fs.unlink(filePath);
}

function toEpochMs(value: string | undefined): number | null {
    if (typeof value !== 'string') return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

function pickEarlierIso(a: string | undefined, b: string | undefined): string | undefined {
    const ta = toEpochMs(a);
    const tb = toEpochMs(b);
    if (ta !== null && tb !== null) return ta <= tb ? a : b;
    if (ta !== null) return a;
    if (tb !== null) return b;
    return a ?? b;
}

function shouldPreferIncomingByUpdatedAt(existing: AgentArtifact, incoming: AgentArtifact): boolean {
    const existingUpdated = toEpochMs(existing.updatedAt);
    const incomingUpdated = toEpochMs(incoming.updatedAt);
    if (incomingUpdated !== null && existingUpdated !== null) return incomingUpdated >= existingUpdated;
    if (incomingUpdated !== null) return true;
    if (existingUpdated !== null) return false;
    return true;
}

function mergeArtifacts(existing: AgentArtifact[], incoming: AgentArtifact[]): AgentArtifact[] {
    const map = new Map<string, AgentArtifact>();
    const order: string[] = [];
    const pushIfNew = (id: string) => {
        if (!map.has(id)) order.push(id);
    };

    for (const artifact of existing) {
        if (!artifact?.id?.trim()) continue;
        pushIfNew(artifact.id);
        map.set(artifact.id, artifact);
    }

    for (const artifact of incoming) {
        if (!artifact?.id?.trim()) continue;
        const prev = map.get(artifact.id);
        if (!prev) {
            pushIfNew(artifact.id);
            map.set(artifact.id, artifact);
            continue;
        }
        const preferred = shouldPreferIncomingByUpdatedAt(prev, artifact) ? artifact : prev;
        map.set(artifact.id, {
            ...preferred,
            createdAt: pickEarlierIso(prev.createdAt, artifact.createdAt) ?? preferred.createdAt,
        });
    }

    return order
        .map((id) => map.get(id))
        .filter((artifact): artifact is AgentArtifact => Boolean(artifact));
}

function normalizeTimelineEvent(
    raw: CanvasTimelineEvent,
    fallbackSeq: number
): CanvasTimelineEvent | null {
    const artifactId = typeof raw.artifactId === 'string' ? raw.artifactId.trim() : '';
    if (!artifactId) return null;
    const parsedAt = toEpochMs(raw.at);
    return {
        seq: typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? Math.floor(raw.seq) : fallbackSeq,
        at: parsedAt !== null ? raw.at : new Date().toISOString(),
        kind: raw.kind === 'open' ? 'open' : 'upsert',
        artifactId,
        artifactType: typeof raw.artifactType === 'string' && raw.artifactType.trim() ? raw.artifactType : 'markdown',
        data: raw.data,
    };
}

function mergeCanvasTimeline(
    existing: CanvasTimelineEvent[] | undefined,
    incoming: CanvasTimelineEvent[] | undefined
): CanvasTimelineEvent[] | undefined {
    const combined = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
    if (combined.length === 0) return undefined;

    const seen = new Set<string>();
    const deduped: CanvasTimelineEvent[] = [];
    for (let i = 0; i < combined.length; i += 1) {
        const normalized = normalizeTimelineEvent(combined[i], i);
        if (!normalized) continue;
        const signature = getCanvasTimelineEventSignature({
            at: normalized.at,
            kind: normalized.kind,
            artifactId: normalized.artifactId,
            artifactType: normalized.artifactType,
            data: normalized.data,
        });
        if (seen.has(signature)) continue;
        seen.add(signature);
        deduped.push(normalized);
    }
    if (deduped.length === 0) return undefined;
    return sortCanvasTimelineEvents(deduped);
}

function pickLatestContextUsage(
    existing: AgentState['ui']['contextUsage'] | undefined,
    incoming: AgentState['ui']['contextUsage'] | undefined
): AgentState['ui']['contextUsage'] | undefined {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const existingAt = toEpochMs(existing.updatedAt);
    const incomingAt = toEpochMs(incoming.updatedAt);
    if (existingAt !== null && incomingAt !== null) return incomingAt >= existingAt ? incoming : existing;
    if (incomingAt !== null) return incoming;
    if (existingAt !== null) return existing;
    return incoming;
}

function mergeStateForSave(existing: AgentState | null, incoming: AgentState): AgentState {
    if (!existing) return incoming;
    const mergedTimeline = mergeCanvasTimeline(existing.ui?.canvasTimeline, incoming.ui?.canvasTimeline);
    const mergedContextUsage = pickLatestContextUsage(existing.ui?.contextUsage, incoming.ui?.contextUsage);
    const openArtifactId =
        typeof incoming.ui?.openArtifactId === 'string' && incoming.ui.openArtifactId.trim()
            ? incoming.ui.openArtifactId
            : existing.ui?.openArtifactId;

    return {
        ...incoming,
        artifacts: mergeArtifacts(existing.artifacts ?? [], incoming.artifacts ?? []),
        ui: {
            ...(incoming.ui ?? {}),
            ...(openArtifactId ? { openArtifactId } : {}),
            ...(mergedTimeline && mergedTimeline.length > 0 ? { canvasTimeline: mergedTimeline } : {}),
            ...(mergedContextUsage ? { contextUsage: mergedContextUsage } : {}),
        },
    };
}

export class AgentPersistence {
    private static writeQueues = new Map<string, Promise<void>>();

    private static enqueueWrite(projectId: string, task: () => Promise<void>): Promise<void> {
        const previous = AgentPersistence.writeQueues.get(projectId) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(task);
        AgentPersistence.writeQueues.set(projectId, next);
        next.finally(() => {
            if (AgentPersistence.writeQueues.get(projectId) === next) {
                AgentPersistence.writeQueues.delete(projectId);
            }
        });
        return next;
    }

    /**
     * Save the agent state
     */
    static async saveState(projectId: string, state: AgentState): Promise<void> {
        return AgentPersistence.enqueueWrite(projectId, async () => {
            try {
                const existing = await AgentPersistence.loadState(projectId);
                const mergedState = mergeStateForSave(existing, state);
                const supabase = await getAuthedSupabase();
                if (supabase) {
                    const { error } = await supabase
                        .from('agent_states')
                        .upsert({ chat_id: projectId, state: mergedState }, { onConflict: 'chat_id' });
                    if (!error) return;
                    console.error(`[AgentPersistence] Supabase save failed for ${projectId}:`, error.message);
                }

                if (shouldFallbackToDisk()) {
                    await saveStateToDisk(projectId, mergedState);
                }
            } catch (error) {
                console.error(`[AgentPersistence] Failed to save state for ${projectId}:`, error);
            }
        });
    }

    /**
     * Load the agent state
     */
    static async loadState(projectId: string): Promise<AgentState | null> {
        try {
            const supabase = await getAuthedSupabase();
            if (supabase) {
                const { data, error } = await supabase
                    .from('agent_states')
                    .select('state')
                    .eq('chat_id', projectId)
                    .maybeSingle();
                if (!error && data?.state) {
                    return data.state as AgentState;
                }
            }

            if (shouldFallbackToDisk()) {
                return await loadStateFromDisk(projectId);
            }
        } catch {
            // File not found is normal for new projects
            return null;
        }
        return null;
    }

    /**
     * Clear state (e.g. on reset)
     */
    static async clearState(projectId: string): Promise<void> {
        return AgentPersistence.enqueueWrite(projectId, async () => {
            try {
                const supabase = await getAuthedSupabase();
                if (supabase) {
                    await supabase.from('agent_states').delete().eq('chat_id', projectId);
                    return;
                }

                if (shouldFallbackToDisk()) {
                    await clearStateFromDisk(projectId);
                }
            } catch {
                // Ignore error if file doesn't exist
            }
        });
    }
}
