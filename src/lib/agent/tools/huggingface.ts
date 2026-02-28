import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import { getIntegrationToken } from '@/lib/integrations/tokens';

const HF_BASE_URL = 'https://huggingface.co';
const HF_DATASET_SERVER = 'https://datasets-server.huggingface.co';
const HF_TOKEN_ENV_NAMES = ['HUGGINGFACE_TOKEN', 'HF_TOKEN'];

type JsonResult =
    | { ok: true; status: number; data: unknown }
    | { ok: false; status: number; message: string; data?: unknown };

type JsonErrorResult = Extract<JsonResult, { ok: false }>;

type TextResult =
    | { ok: true; status: number; text: string }
    | { ok: false; status: number; message: string; text?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readFirstEnvToken(names: string[]): string | undefined {
    for (const name of names) {
        const value = (process.env[name] || '').trim();
        if (value) return value;
    }
    return undefined;
}

async function resolveHfToken(context: AgentContext): Promise<string | undefined> {
    const userId = String(context.userId || '').trim();
    if (userId) {
        try {
            const token = await getIntegrationToken(userId, 'huggingface');
            if (token) return token;
        } catch {
            // Fall back to env token.
        }
    }
    return readFirstEnvToken(HF_TOKEN_ENV_NAMES);
}

function buildAuthHeaders(token?: string): Record<string, string> {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
}

function clipText(text: string, max = 6000): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max).trimEnd()}…`;
}

async function fetchJsonWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number
): Promise<JsonResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        const rawText = await resp.text();
        let data: unknown = null;
        try {
            data = rawText ? JSON.parse(rawText) : null;
        } catch {
            data = rawText;
        }
        if (!resp.ok) {
            const message = (() => {
                if (isRecord(data)) {
                    const err = data.error;
                    if (typeof err === 'string' && err.trim()) return err.trim();
                    if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
                }
                return `Hugging Face API error: ${resp.status} ${resp.statusText}`.trim();
            })();
            return { ok: false, status: resp.status, message, data };
        }
        return { ok: true, status: resp.status, data };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, message };
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchTextWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number
): Promise<TextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        const text = await resp.text();
        if (!resp.ok) {
            return {
                ok: false,
                status: resp.status,
                message: `Hugging Face API error: ${resp.status} ${resp.statusText}`.trim(),
                text,
            };
        }
        return { ok: true, status: resp.status, text };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, message };
    } finally {
        clearTimeout(timeout);
    }
}

function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    return out.length > 0 ? out : undefined;
}

function trimToUndefined(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function trimStringArrayToUndefined(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    const out = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    return out.length > 0 ? out : undefined;
}

function preprocessSortDirection(value: unknown): unknown {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed) return undefined;
        if (trimmed === 'asc' || trimmed === 'ascending') return 'asc';
        if (trimmed === 'desc' || trimmed === 'descending') return 'desc';
        if (trimmed === '1') return 1;
        if (trimmed === '-1') return -1;
    }
    return value;
}

function looksLikeDatasetRenameMessage(message: string): boolean {
    const m = String(message || '').toLowerCase();
    return m.includes('renamed') || m.includes('moved') || m.includes('redirect');
}

function extractHfDatasetIdFromText(text: string): string | null {
    const raw = String(text || '');
    const urlMatch = raw.match(
        /huggingface\.co\/datasets\/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/i
    );
    if (urlMatch && typeof urlMatch[1] === 'string' && urlMatch[1].trim()) return urlMatch[1].trim();

    const idMatch = raw.match(/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/i);
    if (idMatch && typeof idMatch[1] === 'string' && idMatch[1].trim()) return idMatch[1].trim();

    return null;
}

async function suggestDatasetIds(query: string, headers: Record<string, string>, limit = 5): Promise<string[]> {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams();
    params.set('search', q);
    params.set('limit', String(Math.max(1, Math.min(20, limit))));
    params.set('sort', 'downloads');
    params.set('direction', String(-1));
    const url = `${HF_BASE_URL}/api/datasets?${params.toString()}`;
    const resp = await fetchJsonWithTimeout(url, { headers }, 12_000);
    if (!resp.ok) return [];
    const rows = Array.isArray(resp.data) ? resp.data : [];
    const out: string[] = [];
    for (const row of rows) {
        const normalized = normalizeHubItem(row, 'dataset');
        const id = normalized && typeof normalized.id === 'string' ? normalized.id : '';
        if (id) out.push(id);
    }
    return out;
}

function pickBestDatasetCandidate(originalDataset: string, candidates: string[]): string | undefined {
    if (!candidates || candidates.length === 0) return undefined;
    const name = originalDataset.includes('/')
        ? (originalDataset.split('/').pop() || originalDataset)
        : originalDataset;
    const needle = name.trim().toLowerCase();
    if (!needle) return candidates[0];
    const exactTail = candidates.find((id) => id.toLowerCase().endsWith(`/${needle}`));
    return exactTail ?? candidates[0];
}

function normalizeHubItem(item: unknown, type: 'model' | 'dataset' | 'space'): Record<string, unknown> | null {
    if (!isRecord(item)) return null;
    const id = typeof item.id === 'string'
        ? item.id
        : (typeof item.modelId === 'string' ? item.modelId : (typeof item.datasetId === 'string' ? item.datasetId : ''));
    if (!id) return null;
    return {
        id,
        type,
        sha: typeof item.sha === 'string' ? item.sha : undefined,
        lastModified: typeof item.lastModified === 'string' ? item.lastModified : undefined,
        likes: typeof item.likes === 'number' ? item.likes : undefined,
        downloads: typeof item.downloads === 'number' ? item.downloads : undefined,
        private: typeof item.private === 'boolean' ? item.private : undefined,
        gated: typeof item.gated === 'boolean' ? item.gated : undefined,
        tags: toStringArray(item.tags),
        author: typeof item.author === 'string' ? item.author : undefined,
        pipelineTag: typeof item.pipeline_tag === 'string' ? item.pipeline_tag : undefined,
        sdk: typeof item.sdk === 'string' ? item.sdk : undefined,
    };
}

function truncateValue(value: unknown, maxChars: number, depth = 0): unknown {
    if (typeof value === 'string') return clipText(value, maxChars);
    if (Array.isArray(value)) return value.map((item) => truncateValue(item, maxChars, depth + 1));
    if (isRecord(value) && depth < 6) {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = truncateValue(val, maxChars, depth + 1);
        }
        return out;
    }
    return value;
}

// ================== Canvas helpers ==================

function buildHubItemUrl(id: string, type: 'model' | 'dataset' | 'space'): string {
    if (type === 'dataset') return `${HF_BASE_URL}/datasets/${id}`;
    if (type === 'space') return `${HF_BASE_URL}/spaces/${id}`;
    return `${HF_BASE_URL}/${id}`;
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br />');
}

function toMarkdownInline(value: unknown, maxChars = 160): string {
    if (value === null || value === undefined) return '';
    const raw = typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : (() => {
                try {
                    return JSON.stringify(value);
                } catch {
                    return String(value);
                }
            })();
    const clipped = raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : raw;
    return escapeMarkdownTableCell(clipped);
}

function formatMarkdownTable(headers: string[], rows: unknown[][]): string {
    if (headers.length === 0) return '';
    const headerLine = `| ${headers.map((h) => escapeMarkdownTableCell(h)).join(' | ')} |`;
    const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
    const bodyLines = rows.map((row) => {
        const cells = headers.map((_, idx) => toMarkdownInline(row[idx]));
        return `| ${cells.join(' | ')} |`;
    });
    return [headerLine, separatorLine, ...bodyLines].join('\n');
}

function extractDatasetViewerRows(payload: unknown, maxRows = 10): Array<Record<string, unknown>> {
    if (!isRecord(payload)) return [];
    const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
    const out: Array<Record<string, unknown>> = [];
    for (const item of rawRows.slice(0, Math.max(1, maxRows))) {
        if (!isRecord(item)) continue;
        if (isRecord(item.row)) {
            out.push(item.row);
            continue;
        }
        out.push(item);
    }
    return out;
}

function rowsToMarkdownPreview(rows: Array<Record<string, unknown>>, maxCols = 8): string | null {
    if (rows.length === 0) return null;
    const headers = Object.keys(rows[0] ?? {}).slice(0, Math.max(1, maxCols));
    if (headers.length === 0) return null;
    const body = rows.map((row) => headers.map((h) => row[h]));
    const table = formatMarkdownTable(headers, body);
    return table.trim() ? table : null;
}

const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie)/i;
function redactSensitive(value: unknown, depth = 0): unknown {
    if (depth > 6) return value;
    if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
    if (isRecord(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            if (SENSITIVE_KEY_RE.test(key)) {
                out[key] = '[redacted]';
            } else {
                out[key] = redactSensitive(val, depth + 1);
            }
        }
        return out;
    }
    return value;
}

function normalizeRepoInput(
    repoId: string,
    repoType?: 'model' | 'dataset' | 'space',
): { id: string; type: 'model' | 'dataset' | 'space' } {
    let type: 'model' | 'dataset' | 'space' = repoType === 'dataset' || repoType === 'space' || repoType === 'model'
        ? repoType
        : 'model';
    let id = repoId.trim();
    if (id.startsWith('datasets/')) {
        type = 'dataset';
        id = id.slice('datasets/'.length);
    }
    if (id.startsWith('spaces/')) {
        type = 'space';
        id = id.slice('spaces/'.length);
    }
    return { id, type };
}

function normalizeSpaceId(input: string): string {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const urlMatch = raw.match(
        /huggingface\.co\/spaces\/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/i
    );
    if (urlMatch && typeof urlMatch[1] === 'string' && urlMatch[1].trim()) return urlMatch[1].trim();
    if (raw.startsWith('spaces/')) return raw.slice('spaces/'.length).trim();
    return raw;
}

function normalizeSpaceHost(host: string): string {
    const trimmed = host.trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
}

function formatHfJobsError(status: number, message: string, context: 'run' | 'job'): string {
    if (status === 404) {
        return context === 'run'
            ? 'Hugging Face Jobs API returned 404. Jobs may not be enabled for this account or namespace.'
            : 'Job not found or Jobs API is unavailable for this account.';
    }
    if (status === 401 || status === 403) {
        return 'Not authorized to access Hugging Face Jobs. Connect a token with Jobs permissions and the correct namespace.';
    }
    return message;
}

async function fetchGradioResult(params: {
    host: string;
    apiPrefix: string;
    apiName: string;
    inputs: unknown[];
    token?: string;
    timeoutMs: number;
}): Promise<
    | { ok: true; data: unknown; meta?: Record<string, unknown> }
    | { ok: false; message: string; status?: number; meta?: Record<string, unknown> }
> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(params.token),
    };
    const sessionHash = randomUUID().replace(/-/g, '');
    const payload = { data: params.inputs, session_hash: sessionHash };
    const callUrl = `${params.host}${params.apiPrefix}/call/${params.apiName}`;
    const callResp = await fetchJsonWithTimeout(callUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    }, params.timeoutMs);
    if (callResp.ok && isRecord(callResp.data)) {
        const eventId = typeof callResp.data.event_id === 'string'
            ? callResp.data.event_id
            : (typeof callResp.data.eventId === 'string' ? callResp.data.eventId : '');
        if (eventId) {
            const sseUrl = `${callUrl}/${eventId}`;
            const sseResp = await fetchTextWithTimeout(sseUrl, { headers }, params.timeoutMs);
            if (!sseResp.ok) {
                return { ok: false, message: sseResp.message, status: sseResp.status, meta: { eventId, sseUrl } };
            }
            const events = sseResp.text
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('data:'))
                .map(line => line.replace(/^data:\s?/, ''))
                .filter(Boolean)
                .map((raw) => {
                    try {
                        return JSON.parse(raw);
                    } catch {
                        return raw;
                    }
                });
            const last = events[events.length - 1];
            return { ok: true, data: last ?? events, meta: { eventId, sseUrl } };
        }
        if ('data' in callResp.data) {
            return { ok: true, data: callResp.data };
        }
    }
    if (callResp.ok && callResp.data) {
        return { ok: true, data: callResp.data };
    }

    const directUrl = `${params.host}${params.apiPrefix}/${params.apiName}`;
    const directResp = await fetchJsonWithTimeout(directUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: params.inputs }),
    }, params.timeoutMs);
    if (directResp.ok) {
        return { ok: true, data: directResp.data };
    }
    return { ok: false, message: directResp.message, status: directResp.status, meta: { callUrl, directUrl } };
}

// ================== Search Hub ==================

const hfHubSearchArgsSchema = z.object({
    query: z.preprocess(trimToUndefined, z.string().min(1).max(5000)),
    type: z.enum(['model', 'dataset', 'space', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    author: z.preprocess(trimToUndefined, z.string().min(1).optional()),
    tags: z.preprocess(trimStringArrayToUndefined, z.array(z.string().min(1)).optional()),
    sort: z.preprocess(trimToUndefined, z.string().min(1).optional()),
    direction: z.preprocess(
        preprocessSortDirection,
        z.union([z.enum(['asc', 'desc']), z.number().int().refine((val) => val === 1 || val === -1)]).optional()
    ),
}).strict();

export const hfHubSearchTool: Tool = {
    category: 'data',
    definition: {
        name: 'hf_hub_search',
        description:
            'Search the Hugging Face Hub for models, datasets, or Spaces. Uses server-side Hub APIs and supports optional filters (tags, author, sort). `direction` accepts "asc"/"desc" and is mapped internally to the Hub API numeric direction (1/-1). If `sort` is set and `direction` is omitted, defaults to descending.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                type: { type: 'string', enum: ['model', 'dataset', 'space', 'all'] },
                limit: { type: 'number', description: 'Max results per type (1-50, default 10)' },
                author: { type: 'string', description: 'Filter by author or org name' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters' },
                sort: { type: 'string', description: 'Sort key (e.g. downloads, likes, lastModified)' },
                direction: { type: 'string', enum: ['asc', 'desc'], description: "Sort direction: 'asc' or 'desc'." },
            },
            required: ['query'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfHubSearchArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }

        const token = await resolveHfToken(context);
        const headers = buildAuthHeaders(token);
        const type = parsed.data.type ?? 'all';
        const limit = parsed.data.limit ?? 10;

        const directionValue = (() => {
            if (typeof parsed.data.direction === 'number') return parsed.data.direction;
            if (parsed.data.direction === 'asc') return 1;
            if (parsed.data.direction === 'desc') return -1;
            if (!parsed.data.direction && parsed.data.sort) return -1;
            return undefined;
        })();

        const buildUrl = (kind: 'model' | 'dataset' | 'space') => {
            const endpoint = kind === 'model'
                ? `${HF_BASE_URL}/api/models`
                : kind === 'dataset'
                    ? `${HF_BASE_URL}/api/datasets`
                    : `${HF_BASE_URL}/api/spaces`;
            const params = new URLSearchParams();
            params.set('search', parsed.data.query);
            params.set('limit', String(limit));
            if (parsed.data.author) params.set('author', parsed.data.author);
            if (parsed.data.sort) params.set('sort', parsed.data.sort);
            if (directionValue !== undefined) params.set('direction', String(directionValue));
            if (parsed.data.tags && parsed.data.tags.length > 0) {
                params.set('filter', parsed.data.tags.join(','));
            }
            return `${endpoint}?${params.toString()}`;
        };

        const typesToFetch = type === 'all' ? (['model', 'dataset', 'space'] as const) : [type];
        const results: Array<Record<string, unknown>> = [];

        for (const kind of typesToFetch) {
            const resp = await fetchJsonWithTimeout(buildUrl(kind), { headers }, 12_000);
            if (!resp.ok) {
                return { ok: false, error: { name: 'HfApiError', message: resp.message } };
            }
            const rows = Array.isArray(resp.data) ? resp.data : [];
            for (const row of rows) {
                const normalized = normalizeHubItem(row, kind);
                if (normalized) results.push(normalized);
            }
        }

        const performedAt = new Date().toISOString();
        const resultsByType = (kind: 'model' | 'dataset' | 'space') =>
            results.filter((item) => (typeof item.type === 'string' ? item.type : '') === kind);
        const datasetResults = resultsByType('dataset');
        const modelResults = resultsByType('model');

        const formatHubResultsMarkdown = (kind: 'model' | 'dataset' | 'space', items: Array<Record<string, unknown>>) => {
            const title =
                kind === 'dataset' ? 'Hugging Face Datasets'
                    : kind === 'space' ? 'Hugging Face Spaces'
                        : 'Hugging Face Models';
            const lines: string[] = [];
            lines.push(`## ${title}`, '');
            lines.push(`**Query:** ${parsed.data.query}`, '');
            lines.push(`**Performed at:** ${performedAt}`, '');
            if (items.length === 0) {
                lines.push('_No results found._');
                return lines.join('\n');
            }
            const headers = ['id', 'downloads', 'likes', 'lastModified', 'tags'];
            const rows = items.slice(0, 25).map((item) => {
                const id = typeof item.id === 'string' ? item.id : '';
                const link = id ? `[${id}](${buildHubItemUrl(id, kind)})` : '';
                const downloads = typeof item.downloads === 'number' ? item.downloads : '';
                const likes = typeof item.likes === 'number' ? item.likes : '';
                const lastModified = typeof item.lastModified === 'string' ? item.lastModified : '';
                const tags = Array.isArray(item.tags)
                    ? item.tags.filter((t): t is string => typeof t === 'string').slice(0, 6).join(', ')
                    : '';
                return [link || id, downloads, likes, lastModified, tags];
            });
            lines.push(formatMarkdownTable(headers, rows));
            return lines.join('\n');
        };

        const sideEffects: ToolExecutionResult['sideEffects'] = [];
        let shouldOpen: { id: string; type?: string } | null = null;

        const publishDataset =
            type === 'dataset' || (type === 'all' && datasetResults.length > 0);
        const publishModels =
            type === 'model' || (type === 'all' && modelResults.length > 0);

        if (publishDataset) {
            const markdown = formatHubResultsMarkdown('dataset', datasetResults);
            const content = {
                kind: 'hf_hub_search_canvas_v1',
                performedAt,
                query: parsed.data.query,
                type: 'dataset',
                limit,
                results: datasetResults,
                markdown,
            };
            sideEffects.push({
                type: 'ui.upsertArtifact',
                payload: {
                    id: 'curation',
                    type: 'dataset',
                    title: 'Hugging Face Datasets',
                    content,
                    status: 'final',
                    isCollaborative: true,
                },
            });
            shouldOpen = shouldOpen ?? { id: 'curation', type: 'dataset' };
        }

        if (publishModels) {
            const markdown = formatHubResultsMarkdown('model', modelResults);
            const content = {
                kind: 'hf_hub_search_canvas_v1',
                performedAt,
                query: parsed.data.query,
                type: 'model',
                limit,
                results: modelResults,
                markdown,
            };
            sideEffects.push({
                type: 'ui.upsertArtifact',
                payload: {
                    id: 'export',
                    type: 'model_card',
                    title: 'Hugging Face Models',
                    content,
                    status: 'final',
                    isCollaborative: true,
                },
            });
            shouldOpen = shouldOpen ?? { id: 'export', type: 'model_card' };
        }

        if (shouldOpen) {
            sideEffects.push({ type: 'ui.openArtifact', payload: shouldOpen });
        }

        return {
            ok: true,
            data: {
                kind: 'hf_hub_search_v1',
                performedAt,
                query: parsed.data.query,
                type,
                limit,
                results,
            },
            ...(sideEffects.length > 0 ? { sideEffects } : {}),
        };
    },
};

// ================== Explore Datasets ==================

const hfDatasetExploreArgsSchema = z.object({
    dataset: z.preprocess(trimToUndefined, z.string().min(1)),
    config: z.preprocess(trimToUndefined, z.string().min(1).optional()),
    split: z.preprocess(trimToUndefined, z.string().min(1).optional()),
    includeInfo: z.boolean().optional(),
    includeSplits: z.boolean().optional(),
    includeFirstRows: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(100).optional(),
    maxPreviewRows: z.number().int().min(1).max(100).optional(),
    maxCellChars: z.number().int().min(1).max(4000).optional(),
    maxInfoChars: z.number().int().min(1).max(20000).optional(),
}).strict();

export const hfDatasetExploreTool: Tool = {
    category: 'data',
    definition: {
        name: 'hf_dataset_explore',
        description:
            'Inspect a Hugging Face dataset with datasets-server APIs (info, splits, first rows). Useful for quickly understanding configs and schema. If a dataset was renamed, the tool may auto-resolve to the canonical id.',
        parameters: {
            type: 'object',
            properties: {
                dataset: { type: 'string', description: 'Dataset repo id (e.g. nyu-mll/glue)' },
                config: { type: 'string', description: 'Config/subset name' },
                split: { type: 'string', description: 'Split name (train/test/validation)' },
                includeInfo: { type: 'boolean', description: 'Fetch dataset info (default true)' },
                includeSplits: { type: 'boolean', description: 'Fetch available splits (default true)' },
                includeFirstRows: { type: 'boolean', description: 'Fetch a preview slice (default true)' },
                offset: { type: 'number', description: 'Preview offset (default 0)' },
                length: { type: 'number', description: 'Preview length (1-100, default 10)' },
                maxPreviewRows: { type: 'number', description: 'Alias for length (1-100)' },
                maxCellChars: { type: 'number', description: 'Max chars per cell in preview rows (default 1200)' },
                maxInfoChars: { type: 'number', description: 'Max chars per string field in info/splits payloads (default 6000)' },
            },
            required: ['dataset'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfDatasetExploreArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }

        const token = await resolveHfToken(context);
        const headers = buildAuthHeaders(token);
        const includeInfo = parsed.data.includeInfo ?? true;
        const includeSplits = parsed.data.includeSplits ?? true;
        const includeFirstRows = parsed.data.includeFirstRows ?? true;
        const length = parsed.data.maxPreviewRows ?? parsed.data.length ?? 10;
        const offset = parsed.data.offset ?? 0;
        const maxCellChars = parsed.data.maxCellChars ?? 1200;
        const maxInfoChars = parsed.data.maxInfoChars ?? 6000;

        const requestedDataset = parsed.data.dataset;
        const timing: Record<string, number> = {};
        const hints: string[] = [];

        const maybeAddPerformanceHint = () => {
            const slowCalls = Object.entries(timing)
                .filter(([key, ms]) => key.endsWith('Ms') && typeof ms === 'number' && ms >= 7000)
                .map(([key, ms]) => `${key}=${ms}ms`);
            if (slowCalls.length > 0) {
                hints.push(
                    `Some dataset-server calls were slow (${slowCalls.join(', ')}). Consider reducing length/maxPreviewRows, lowering maxInfoChars/maxCellChars, or disabling includeInfo/includeFirstRows for a smaller/faster response.`
                );
            }
        };

        const attemptExplore = async (datasetId: string): Promise<
            | {
                ok: true;
                dataset: string;
                config: string | null;
                split: string | null;
                info: unknown;
                splits: unknown;
                preview: unknown;
            }
            | { ok: false; dataset: string; endpoint: string; resp: JsonErrorResult }
        > => {
            let info: unknown = null;
            let splits: unknown = null;

            if (includeInfo) {
                const url = `${HF_DATASET_SERVER}/info?dataset=${encodeURIComponent(datasetId)}`;
                const t0 = Date.now();
                const resp = await fetchJsonWithTimeout(url, { headers }, 12_000);
                timing.infoMs = Date.now() - t0;
                if (!resp.ok) return { ok: false, dataset: datasetId, endpoint: 'info', resp };
                info = truncateValue(resp.data, maxInfoChars);
            }

            if (includeSplits) {
                const url = `${HF_DATASET_SERVER}/splits?dataset=${encodeURIComponent(datasetId)}`;
                const t0 = Date.now();
                const resp = await fetchJsonWithTimeout(url, { headers }, 12_000);
                timing.splitsMs = Date.now() - t0;
                if (!resp.ok) return { ok: false, dataset: datasetId, endpoint: 'splits', resp };
                splits = truncateValue(resp.data, maxInfoChars);
            }

            let preview: unknown = null;
            let effectiveConfig = parsed.data.config;
            let effectiveSplit = parsed.data.split;
            if (includeFirstRows) {
                if (!effectiveConfig || !effectiveSplit) {
                    const splitItems = (() => {
                        if (!isRecord(splits)) return [];
                        const raw = splits.splits;
                        return Array.isArray(raw) ? raw : [];
                    })();
                    if (splitItems.length > 0) {
                        const first = splitItems[0];
                        if (isRecord(first)) {
                            if (!effectiveConfig && typeof first.config === 'string') effectiveConfig = first.config;
                            if (!effectiveSplit && typeof first.split === 'string') effectiveSplit = first.split;
                        }
                    }
                }
                if (effectiveConfig && effectiveSplit) {
                    const params = new URLSearchParams({
                        dataset: datasetId,
                        config: effectiveConfig,
                        split: effectiveSplit,
                        offset: String(offset),
                        length: String(length),
                    });
                    const url = `${HF_DATASET_SERVER}/first-rows?${params.toString()}`;
                    const t0 = Date.now();
                    const resp = await fetchJsonWithTimeout(url, { headers }, 12_000);
                    timing.previewMs = Date.now() - t0;
                    if (!resp.ok) return { ok: false, dataset: datasetId, endpoint: 'first-rows', resp };
                    const rawPreview = resp.data;
                    if (isRecord(rawPreview) && Array.isArray(rawPreview.rows)) {
                        preview = { ...rawPreview, rows: rawPreview.rows.map((row) => truncateValue(row, maxCellChars)) };
                    } else {
                        preview = truncateValue(rawPreview, maxCellChars);
                    }
                }
            }

            return {
                ok: true,
                dataset: datasetId,
                config: effectiveConfig ?? null,
                split: effectiveSplit ?? null,
                info,
                splits,
                preview,
            };
        };

        let renamedTo: string | null = null;
        let resolvedBy: 'redirect' | 'hub_search' | null = null;

        const first = await attemptExplore(requestedDataset);
        if (!first.ok) {
            const explicitTarget = looksLikeDatasetRenameMessage(first.resp.message)
                ? extractHfDatasetIdFromText(first.resp.message)
                : null;
            if (explicitTarget && explicitTarget !== requestedDataset) {
                renamedTo = explicitTarget;
                resolvedBy = 'redirect';
            } else {
                const t0 = Date.now();
                const candidates = await suggestDatasetIds(requestedDataset, headers, 8);
                timing.renameSearchMs = Date.now() - t0;
                const best = pickBestDatasetCandidate(requestedDataset, candidates);
                if (best && !requestedDataset.includes('/') && best.toLowerCase().endsWith(`/${requestedDataset.toLowerCase()}`)) {
                    renamedTo = best;
                    resolvedBy = 'hub_search';
                }
            }

            if (renamedTo) {
                const second = await attemptExplore(renamedTo);
                if (second.ok) {
                    maybeAddPerformanceHint();
                    const performedAt = new Date().toISOString();
                    const previewRows = extractDatasetViewerRows(second.preview, Math.max(1, Math.min(20, length)));
                    const previewTable = rowsToMarkdownPreview(previewRows);
                    const datasetUrl = buildHubItemUrl(second.dataset, 'dataset');
                    const markdownLines: string[] = [
                        '## Hugging Face Dataset Explore',
                        '',
                        `**Dataset:** [${second.dataset}](${datasetUrl})`,
                        `**Requested:** ${requestedDataset}`,
                        `**Resolved by:** ${resolvedBy ?? 'unknown'}`,
                        second.config ? `**Config:** ${second.config}` : '**Config:** (auto)',
                        second.split ? `**Split:** ${second.split}` : '**Split:** (auto)',
                        `**Performed at:** ${performedAt}`,
                        '',
                    ];
                    if (previewTable) {
                        markdownLines.push('### Preview', '', previewTable, '');
                    }
                    if (hints.length > 0) {
                        markdownLines.push('### Hints', '', ...hints.map((h) => `- ${h}`), '');
                    }
                    const markdown = markdownLines.join('\n');
                    const canvasData = {
                        kind: 'hf_dataset_explore_v1',
                        performedAt,
                        requestedDataset,
                        dataset: second.dataset,
                        renamedFrom: requestedDataset,
                        renamedTo,
                        resolvedBy,
                        config: second.config,
                        split: second.split,
                        info: second.info,
                        splits: second.splits,
                        preview: second.preview,
                        hints: hints.length > 0 ? hints : null,
                        timing,
                        markdown,
                    };
                    return {
                        ok: true,
                        data: canvasData,
                        sideEffects: [
                            {
                                type: 'ui.upsertArtifact',
                                payload: {
                                    id: 'curation',
                                    type: 'dataset',
                                    title: 'HF Dataset Explore',
                                    content: canvasData,
                                    status: 'final',
                                    isCollaborative: true,
                                },
                            },
                            { type: 'ui.openArtifact', payload: { id: 'curation', type: 'dataset' } },
                        ],
                    };
                }
            }

            const t1 = Date.now();
            const suggestions = await suggestDatasetIds(requestedDataset, headers, 8);
            timing.suggestionsMs = Date.now() - t1;
            const hint = suggestions.length > 0 ? ` Try one of: ${suggestions.slice(0, 5).join(', ')}` : '';
            const renameHint = renamedTo ? ` Dataset appears renamed to '${renamedTo}'.` : '';
            return {
                ok: false,
                error: {
                    name: renamedTo ? 'DatasetRenamed' : 'HfApiError',
                    message: `${first.resp.message}${renameHint}${hint}`.trim(),
                },
                data: {
                    requestedDataset,
                    endpoint: first.endpoint,
                    status: first.resp.status,
                    renamedTo,
                    suggestions,
                    timing,
                },
            };
        }

        maybeAddPerformanceHint();
        const performedAt = new Date().toISOString();
        const previewRows = extractDatasetViewerRows(first.preview, Math.max(1, Math.min(20, length)));
        const previewTable = rowsToMarkdownPreview(previewRows);
        const datasetUrl = buildHubItemUrl(first.dataset, 'dataset');
        const markdownLines: string[] = [
            '## Hugging Face Dataset Explore',
            '',
            `**Dataset:** [${first.dataset}](${datasetUrl})`,
            `**Requested:** ${requestedDataset}`,
            first.config ? `**Config:** ${first.config}` : '**Config:** (auto)',
            first.split ? `**Split:** ${first.split}` : '**Split:** (auto)',
            `**Performed at:** ${performedAt}`,
            '',
        ];
        if (previewTable) {
            markdownLines.push('### Preview', '', previewTable, '');
        }
        if (hints.length > 0) {
            markdownLines.push('### Hints', '', ...hints.map((h) => `- ${h}`), '');
        }
        const markdown = markdownLines.join('\n');
        const canvasData = {
            kind: 'hf_dataset_explore_v1',
            performedAt,
            requestedDataset,
            dataset: first.dataset,
            config: first.config,
            split: first.split,
            info: first.info,
            splits: first.splits,
            preview: first.preview,
            hints: hints.length > 0 ? hints : null,
            timing,
            markdown,
        };
        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: 'curation',
                        type: 'dataset',
                        title: 'HF Dataset Explore',
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: 'curation', type: 'dataset' } },
            ],
        };
    },
};

// ================== Query Dataset ==================

const hfDatasetQueryArgsSchema = z.object({
    dataset: z.preprocess(trimToUndefined, z.string().min(1)),
    config: z.preprocess(trimToUndefined, z.string().min(1)),
    split: z.preprocess(trimToUndefined, z.string().min(1)),
    query: z.preprocess(trimToUndefined, z.string().min(1).optional()),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(100).optional(),
    maxCellChars: z.number().int().min(1).max(4000).optional(),
    includeFallbackPreview: z.boolean().optional(),
}).strict();

export const hfDatasetQueryTool: Tool = {
    category: 'data',
    definition: {
        name: 'hf_dataset_query',
        description:
            'Query a Hugging Face dataset via datasets-server. Uses /search when a non-empty query is provided; otherwise uses /rows. Note: /search is indexed and may return 0 results for very common tokens/stopwords—try a longer phrase or inspect rows.',
        parameters: {
            type: 'object',
            properties: {
                dataset: { type: 'string', description: 'Dataset repo id (e.g. nyu-mll/glue)' },
                config: { type: 'string', description: 'Config/subset name' },
                split: { type: 'string', description: 'Split name (train/test/validation)' },
                query: { type: 'string', description: 'Optional text query to search within the dataset (empty/omitted lists rows)' },
                offset: { type: 'number', description: 'Row offset (default 0)' },
                length: { type: 'number', description: 'Row count (1-100, default 10)' },
                maxCellChars: { type: 'number', description: 'Max chars per cell (default 1200)' },
                includeFallbackPreview: { type: 'boolean', description: 'If /search yields 0, include a small /rows preview (default true)' },
            },
            required: ['dataset', 'config', 'split'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfDatasetQueryArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }

        const token = await resolveHfToken(context);
        const headers = buildAuthHeaders(token);
        const length = parsed.data.length ?? 10;
        const offset = parsed.data.offset ?? 0;
        const maxCellChars = parsed.data.maxCellChars ?? 1200;
        const includeFallbackPreview = parsed.data.includeFallbackPreview ?? true;
        const requestedDataset = parsed.data.dataset;
        const timing: Record<string, number> = {};

        const runQuery = async (datasetId: string) => {
            const params = new URLSearchParams({
                dataset: datasetId,
                config: parsed.data.config,
                split: parsed.data.split,
                offset: String(offset),
                length: String(length),
            });
            if (parsed.data.query) params.set('query', parsed.data.query);
            const endpoint = parsed.data.query ? 'search' : 'rows';
            const url = `${HF_DATASET_SERVER}/${endpoint}?${params.toString()}`;
            const t0 = Date.now();
            const resp = await fetchJsonWithTimeout(url, { headers }, 15_000);
            timing.primaryMs = Date.now() - t0;
            return { resp, endpoint, url, datasetId };
        };

        let renamedTo: string | null = null;
        let resolvedBy: 'redirect' | 'hub_search' | null = null;

        const primary = await runQuery(requestedDataset);
        let resp = primary.resp;
        let endpoint = primary.endpoint;
        let effectiveDataset = primary.datasetId;
        if (!resp.ok) {
            const explicitTarget = looksLikeDatasetRenameMessage(resp.message)
                ? extractHfDatasetIdFromText(resp.message)
                : null;
            if (explicitTarget && explicitTarget !== requestedDataset) {
                renamedTo = explicitTarget;
                resolvedBy = 'redirect';
            } else {
                const t0 = Date.now();
                const candidates = await suggestDatasetIds(requestedDataset, headers, 8);
                timing.renameSearchMs = Date.now() - t0;
                const best = pickBestDatasetCandidate(requestedDataset, candidates);
                if (best && !requestedDataset.includes('/') && best.toLowerCase().endsWith(`/${requestedDataset.toLowerCase()}`)) {
                    renamedTo = best;
                    resolvedBy = 'hub_search';
                }
            }
            if (renamedTo) {
                const retry = await runQuery(renamedTo);
                resp = retry.resp;
                endpoint = retry.endpoint;
                effectiveDataset = retry.datasetId;
            }
        }

        if (!resp.ok) {
            const t1 = Date.now();
            const suggestions = await suggestDatasetIds(requestedDataset, headers, 8);
            timing.suggestionsMs = Date.now() - t1;
            const hint = suggestions.length > 0 ? ` Try one of: ${suggestions.slice(0, 5).join(', ')}` : '';
            const renameHint = renamedTo ? ` Dataset appears renamed to '${renamedTo}'.` : '';
            return {
                ok: false,
                error: {
                    name: renamedTo ? 'DatasetRenamed' : 'HfApiError',
                    message: `${resp.message}${renameHint}${hint}`.trim(),
                },
                data: {
                    requestedDataset,
                    dataset: effectiveDataset,
                    endpoint,
                    status: resp.status,
                    renamedTo,
                    resolvedBy,
                    suggestions,
                    timing,
                },
            };
        }

        const data = resp.data;
        const rows = (() => {
            if (!isRecord(data) || !Array.isArray(data.rows)) return null;
            return data.rows.map((row: unknown) => truncateValue(row, maxCellChars));
        })();

        const hints: string[] = [];
        let fallbackPreview: unknown = null;
        if (typeof timing.primaryMs === 'number' && timing.primaryMs >= 7000) {
            hints.push(
                `This ${endpoint} request was slow (${timing.primaryMs}ms). Consider reducing length or using a more specific query.`
            );
        }
        if (endpoint === 'search' && isRecord(data) && typeof data.num_rows_total === 'number' && data.num_rows_total === 0) {
            hints.push(
                'Search returned 0 matches. Try a longer/more specific phrase, or omit query to list rows (rows mode).'
            );
            if (includeFallbackPreview) {
                const params = new URLSearchParams({
                    dataset: effectiveDataset,
                    config: parsed.data.config,
                    split: parsed.data.split,
                    offset: '0',
                    length: String(Math.min(5, length)),
                });
                const url = `${HF_DATASET_SERVER}/rows?${params.toString()}`;
                const t0 = Date.now();
                const fallbackResp = await fetchJsonWithTimeout(url, { headers }, 15_000);
                timing.fallbackRowsMs = Date.now() - t0;
                if (fallbackResp.ok) {
                    const raw = fallbackResp.data;
                    if (isRecord(raw) && Array.isArray(raw.rows)) {
                        fallbackPreview = { ...raw, rows: raw.rows.map((row) => truncateValue(row, maxCellChars)) };
                    } else {
                        fallbackPreview = raw;
                    }
                }
            }
        }

        const performedAt = new Date().toISOString();
        const normalizedResults = rows
            ? (isRecord(data) ? { ...data, rows } : { rows })
            : data;
        const previewRows = extractDatasetViewerRows(
            normalizedResults,
            Math.max(1, Math.min(20, length)),
        );
        const previewTable = rowsToMarkdownPreview(previewRows);
        const datasetUrl = buildHubItemUrl(effectiveDataset, 'dataset');
        const markdownLines: string[] = [
            '## Hugging Face Dataset Query',
            '',
            `**Dataset:** [${effectiveDataset}](${datasetUrl})`,
            `**Requested:** ${requestedDataset}`,
            renamedTo ? `**Renamed to:** ${renamedTo}` : '',
            `**Config:** ${parsed.data.config}`,
            `**Split:** ${parsed.data.split}`,
            parsed.data.query ? `**Query:** ${parsed.data.query}` : '**Query:** (rows)',
            `**Endpoint:** ${endpoint}`,
            `**Performed at:** ${performedAt}`,
            '',
        ].filter(Boolean);
        if (previewTable) {
            markdownLines.push('### Preview', '', previewTable, '');
        }
        if (fallbackPreview) {
            const fallbackRows = extractDatasetViewerRows(fallbackPreview, 5);
            const fallbackTable = rowsToMarkdownPreview(fallbackRows);
            if (fallbackTable) {
                markdownLines.push('### Fallback rows preview', '', fallbackTable, '');
            }
        }
        if (hints.length > 0) {
            markdownLines.push('### Hints', '', ...hints.map((h) => `- ${h}`), '');
        }
        const markdown = markdownLines.join('\n');
        const canvasData = {
            kind: 'hf_dataset_query_v1',
            performedAt,
            requestedDataset,
            dataset: effectiveDataset,
            renamedFrom: renamedTo ? requestedDataset : null,
            renamedTo,
            resolvedBy,
            config: parsed.data.config,
            split: parsed.data.split,
            query: parsed.data.query ?? null,
            endpoint,
            results: normalizedResults,
            fallbackPreview,
            hints: hints.length > 0 ? hints : null,
            timing,
            markdown,
        };
        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: 'curation',
                        type: 'dataset',
                        title: 'HF Dataset Query',
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: 'curation', type: 'dataset' } },
            ],
        };
    },
};

// ================== Get Documentation ==================

const hfGetDocumentationArgsSchema = z.object({
    repoId: z.string().min(1),
    repoType: z.enum(['model', 'dataset', 'space']).optional(),
    revision: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    includeReadme: z.boolean().optional(),
    includeMetadata: z.boolean().optional(),
    maxChars: z.number().int().min(500).max(20000).optional(),
}).strict();

export const hfGetDocumentationTool: Tool = {
    category: 'data',
    definition: {
        name: 'hf_get_documentation',
        description:
            'Fetch documentation from a Hugging Face model/dataset/space (README + metadata). Uses server-side Hub APIs.',
        parameters: {
            type: 'object',
            properties: {
                repoId: { type: 'string', description: 'Repo id (e.g. Qwen/Qwen2.5-7B)' },
                repoType: { type: 'string', enum: ['model', 'dataset', 'space'] },
                revision: { type: 'string', description: 'Branch, tag, or commit (default main)' },
                file: { type: 'string', description: 'Doc file path (default README.md)' },
                includeReadme: { type: 'boolean', description: 'Fetch README content (default true)' },
                includeMetadata: { type: 'boolean', description: 'Fetch Hub metadata (default true)' },
                maxChars: { type: 'number', description: 'Max README chars to return (default 6000)' },
            },
            required: ['repoId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfGetDocumentationArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }

        const token = await resolveHfToken(context);
        const headers = buildAuthHeaders(token);
        const { id, type } = normalizeRepoInput(parsed.data.repoId, parsed.data.repoType);
        const revision = parsed.data.revision ?? 'main';
        const file = parsed.data.file ?? 'README.md';
        const includeReadme = parsed.data.includeReadme ?? true;
        const includeMetadata = parsed.data.includeMetadata ?? true;
        const maxChars = parsed.data.maxChars ?? 6000;

        let metadata: unknown = null;
        if (includeMetadata) {
            const metaUrl = `${HF_BASE_URL}/api/${type === 'model' ? 'models' : type === 'dataset' ? 'datasets' : 'spaces'}/${id}`;
            const resp = await fetchJsonWithTimeout(metaUrl, { headers }, 12_000);
            if (!resp.ok) {
                return { ok: false, error: { name: 'HfApiError', message: resp.message } };
            }
            if (isRecord(resp.data)) {
                metadata = {
                    id: resp.data.id,
                    sha: resp.data.sha,
                    lastModified: resp.data.lastModified,
                    likes: resp.data.likes,
                    downloads: resp.data.downloads,
                    private: resp.data.private,
                    gated: resp.data.gated,
                    tags: toStringArray(resp.data.tags),
                    pipelineTag: resp.data.pipeline_tag,
                    cardData: resp.data.cardData,
                };
            } else {
                metadata = resp.data;
            }
        }

        let readme: string | null = null;
        if (includeReadme) {
            const prefix = type === 'dataset' ? 'datasets' : type === 'space' ? 'spaces' : '';
            const basePath = prefix ? `${HF_BASE_URL}/${prefix}/${id}` : `${HF_BASE_URL}/${id}`;
            const readmeUrl = `${basePath}/raw/${revision}/${file}`;
            const resp = await fetchTextWithTimeout(readmeUrl, { headers }, 12_000);
            if (resp.ok) {
                readme = clipText(resp.text, maxChars);
            } else {
                return { ok: false, error: { name: 'HfApiError', message: resp.message } };
            }
        }

        const performedAt = new Date().toISOString();
        const repoUrl = buildHubItemUrl(id, type);
        const metaObj = isRecord(metadata) ? metadata : {};
        const likes = typeof metaObj.likes === 'number' ? metaObj.likes : null;
        const downloads = typeof metaObj.downloads === 'number' ? metaObj.downloads : null;
        const lastModified = typeof metaObj.lastModified === 'string' ? metaObj.lastModified : null;
        const tags = Array.isArray(metaObj.tags)
            ? metaObj.tags.filter((t): t is string => typeof t === 'string').slice(0, 12)
            : [];
        const markdownLines: string[] = [
            '## Hugging Face Documentation',
            '',
            `**Repo:** [${id}](${repoUrl})`,
            `**Type:** ${type}`,
            `**Revision:** ${revision}`,
            `**File:** ${file}`,
            `**Performed at:** ${performedAt}`,
            '',
        ];
        if (likes !== null || downloads !== null || lastModified || tags.length > 0) {
            markdownLines.push('### Metadata', '');
            if (likes !== null) markdownLines.push(`- likes: ${likes}`);
            if (downloads !== null) markdownLines.push(`- downloads: ${downloads}`);
            if (lastModified) markdownLines.push(`- lastModified: ${lastModified}`);
            if (tags.length > 0) markdownLines.push(`- tags: ${tags.join(', ')}`);
            markdownLines.push('');
        }
        if (typeof readme === 'string' && readme.trim()) {
            markdownLines.push('---', '', readme.trim());
        } else {
            markdownLines.push('_No README fetched._');
        }
        const markdown = markdownLines.join('\n');
        const canvasData = {
            kind: 'hf_documentation_v1',
            performedAt,
            repoId: id,
            repoType: type,
            revision,
            file,
            metadata,
            readme,
            markdown,
        };
        const target = type === 'dataset'
            ? { id: 'curation', type: 'dataset' as const, title: 'HF Dataset Docs' }
            : { id: 'export', type: 'model_card' as const, title: 'HF Model/Space Docs' };

        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: target.id,
                        type: target.type,
                        title: target.title,
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: target.id, type: target.type } },
            ],
        };
    },
};

// ================== Run Spaces ==================

const hfSpaceRunArgsSchema = z.object({
    spaceId: z.preprocess(trimToUndefined, z.string().min(1)),
    inputs: z.array(z.unknown()),
    apiName: z.preprocess(trimToUndefined, z.string().min(1).optional()),
    timeoutSeconds: z.number().int().min(5).max(300).optional(),
}).strict();

export const hfSpaceRunTool: Tool = {
    category: 'ml',
    definition: {
        name: 'hf_space_run',
        description:
            'Run a Hugging Face Space (Gradio). Fetches Space metadata/config to locate the public API and executes it server-side.',
        parameters: {
            type: 'object',
            properties: {
                spaceId: { type: 'string', description: 'Space repo id (e.g. org/space-name)' },
                inputs: { type: 'array', items: {}, description: 'Inputs array matching the Space API signature' },
                apiName: { type: 'string', description: 'Optional Gradio api_name (default: first public)' },
                timeoutSeconds: { type: 'number', description: 'Timeout for the call (5-300s, default 90)' },
            },
            required: ['spaceId', 'inputs'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfSpaceRunArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }

        const spaceId = normalizeSpaceId(parsed.data.spaceId);
        if (!spaceId) {
            return { ok: false, error: { name: 'ValidationError', message: 'spaceId must not be empty.' } };
        }

        const token = await resolveHfToken(context);
        const headers = buildAuthHeaders(token);
        const timeoutMs = (parsed.data.timeoutSeconds ?? 90) * 1000;

        const infoUrl = `${HF_BASE_URL}/api/spaces/${spaceId}`;
        const infoResp = await fetchJsonWithTimeout(infoUrl, { headers }, 12_000);
        if (!infoResp.ok) {
            const message = (() => {
                if (infoResp.status === 404) {
                    return `Space '${spaceId}' was not found. Use the "org/space" id and ensure it is public or your token has access.`;
                }
                if (infoResp.status === 401 || infoResp.status === 403) {
                    return `Access denied for Space '${spaceId}'. Connect an HF token with access.`;
                }
                return infoResp.message;
            })();
            return { ok: false, error: { name: 'HfApiError', message } };
        }

        const info = infoResp.data;
        const sdk = isRecord(info) && typeof info.sdk === 'string' ? info.sdk.trim() : '';
        if (sdk && sdk.toLowerCase() !== 'gradio') {
            return {
                ok: false,
                error: {
                    name: 'HfApiError',
                    message: `Space '${spaceId}' uses ${sdk}. hf_space_run supports Gradio spaces only.`,
                },
            };
        }
        const isPrivate = isRecord(info) && info.private === true;
        const isGated = isRecord(info) && info.gated === true;
        if ((isPrivate || isGated) && !token) {
            return {
                ok: false,
                error: {
                    name: 'AuthenticationError',
                    message: `Space '${spaceId}' is private or gated. Connect a Hugging Face token with access.`,
                },
            };
        }
        const runtimeStage = isRecord(info) && isRecord(info.runtime) && typeof info.runtime.stage === 'string'
            ? info.runtime.stage.trim()
            : '';
        const host = (() => {
            if (isRecord(info) && typeof info.host === 'string' && info.host.trim()) {
                return normalizeSpaceHost(info.host.trim());
            }
            const runtimeDomains = isRecord(info) && isRecord(info.runtime) && Array.isArray(info.runtime.domains)
                ? info.runtime.domains
                : [];
            const domain = runtimeDomains.find((item) => isRecord(item) && typeof item.domain === 'string');
            if (domain && isRecord(domain)) {
                const d = String(domain.domain || '').trim();
                if (d) return `https://${d}`;
            }
            return `https://${spaceId.replace('/', '-')}.hf.space`;
        })();

        const configUrl = `${host}/config`;
        let configResp = await fetchJsonWithTimeout(configUrl, { headers }, 12_000);
        if (!configResp.ok && [404, 502, 503, 504].includes(configResp.status)) {
            await fetchTextWithTimeout(`${HF_BASE_URL}/spaces/${spaceId}`, { headers }, 10_000);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            configResp = await fetchJsonWithTimeout(configUrl, { headers }, 12_000);
        }
        if (!configResp.ok) {
            const hints: string[] = [];
            if (configResp.status === 404) {
                hints.push('Space config not found; the Space may be sleeping or not exposing a Gradio API.');
            } else if (configResp.status >= 500) {
                hints.push('The Space may be sleeping or starting up.');
            }
            if (runtimeStage) hints.push(`Runtime stage: ${runtimeStage}.`);
            const message = [
                `Failed to fetch Space config for '${spaceId}'.`,
                hints.length > 0 ? hints.join(' ') : '',
                configResp.message,
            ].filter(Boolean).join(' ');
            return { ok: false, error: { name: 'HfApiError', message } };
        }
        const config = configResp.data;
        const apiPrefix = (isRecord(config) && typeof config.api_prefix === 'string' && config.api_prefix.trim())
            ? config.api_prefix.trim()
            : '/gradio_api';

        const deps = isRecord(config) && Array.isArray(config.dependencies)
            ? config.dependencies.filter((dep) => isRecord(dep) && typeof dep.api_name === 'string')
            : [];
        const availableApiNames = Array.from(new Set(
            deps
                .map((dep) => (isRecord(dep) && typeof dep.api_name === 'string' ? dep.api_name.trim() : ''))
                .filter(Boolean)
        ));
        const apiName = (() => {
            if (parsed.data.apiName) return parsed.data.apiName;
            if (deps.length === 0) return 'predict';
            const publicDep = deps.find((dep) => {
                const visibility = String((dep as Record<string, unknown>).api_visibility || '').toLowerCase();
                return visibility !== 'private' && visibility !== 'undocumented';
            });
            if (publicDep && isRecord(publicDep) && typeof publicDep.api_name === 'string') {
                return publicDep.api_name;
            }
            if (deps[0] && isRecord(deps[0]) && typeof deps[0].api_name === 'string') return deps[0].api_name;
            return 'predict';
        })();

        const call = await fetchGradioResult({
            host,
            apiPrefix,
            apiName,
            inputs: parsed.data.inputs,
            token,
            timeoutMs,
        });
        if (!call.ok) {
            const hints: string[] = [];
            if (call.status === 404) {
                hints.push(`The apiName '${apiName}' may be incorrect.`);
            }
            if (call.status === 400 || call.status === 422) {
                hints.push('Inputs may not match the Space API signature.');
            }
            const lowerMessage = call.message.toLowerCase();
            if (lowerMessage.includes('abort') || lowerMessage.includes('timeout')) {
                hints.push('The Space may be queued or sleeping. Try again or increase timeoutSeconds.');
            }
            if (availableApiNames.length > 0) {
                hints.push(`Available api_name values: ${availableApiNames.join(', ')}`);
            }
            const message = [call.message, ...hints].filter(Boolean).join(' ');
            return { ok: false, error: { name: 'HfApiError', message } };
        }

        return {
            ok: true,
            data: {
                kind: 'hf_space_run_v1',
                spaceId,
                host,
                apiPrefix,
                apiName,
                output: call.data,
                meta: call.meta ?? null,
            },
        };
    },
};

// ================== Jobs ==================

/** Accept a JSON string or a plain object for map-type parameters. */
function jsonOrStringRecord<V extends z.ZodTypeAny>(valueSchema: V) {
    return z.preprocess((val) => {
        if (typeof val === 'string') {
            try { return JSON.parse(val); } catch { return val; }
        }
        return val;
    }, z.record(z.string(), valueSchema).optional());
}

const hfJobRunArgsSchema = z.object({
    payload: z.preprocess((val) => {
        if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
        return val;
    }, z.record(z.string(), z.unknown()).optional()),
    image: z.string().min(1).optional(),
    command: z.array(z.string().min(1)).optional(),
    arguments: z.array(z.string().min(1)).optional(),
    env: jsonOrStringRecord(z.string()),
    secrets: jsonOrStringRecord(z.string()),
    flavor: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    timeout: z.union([z.string(), z.number()]).optional(),
    labels: jsonOrStringRecord(z.string()),
}).strict().refine((value) => Boolean(value.payload || (value.image && value.command)), {
    message: 'Provide payload or (image + command).',
});

export const hfJobRunTool: Tool = {
    category: 'ml',
    definition: {
        name: 'hf_job_run',
        description:
            'Run a Hugging Face Job (compute). Requires an HF token with Jobs access. Provide either a raw payload or image+command.',
        parameters: {
            type: 'object',
            properties: {
                payload: { type: 'string', description: 'Raw Jobs API payload as a JSON string (advanced).' },
                image: { type: 'string', description: 'Docker image (e.g. python:3.12 or hf.co/spaces/org/space)' },
                command: { type: 'array', items: { type: 'string' }, description: 'Command array (e.g. ["python","-c","print(1)"])' },
                arguments: { type: 'array', items: { type: 'string' }, description: 'Optional command args' },
                env: { type: 'string', description: 'Environment variables as a JSON object string, e.g. {"KEY":"value"}.' },
                secrets: { type: 'string', description: 'Secret env vars as a JSON object string, e.g. {"HF_TOKEN":"..."}.' },
                flavor: { type: 'string', description: 'Hardware flavor (e.g. cpu-basic, a10g-small)' },
                namespace: { type: 'string', description: 'Run under a specific namespace (org)' },
                timeout: { type: 'string', description: 'Timeout (seconds or string like "2h")' },
                labels: { type: 'string', description: 'Labels as a JSON object string, e.g. {"team":"ml"}.' },
            },
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfJobRunArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }
        const token = await resolveHfToken(context);
        if (!token) {
            return {
                ok: false,
                error: {
                    name: 'AuthenticationError',
                    message: 'Hugging Face token is not configured. Add it under Integrations first.',
                },
            };
        }

        const payload = parsed.data.payload ?? {
            image: parsed.data.image,
            command: parsed.data.command,
            arguments: parsed.data.arguments,
            env: parsed.data.env,
            secrets: parsed.data.secrets,
            flavor: parsed.data.flavor,
            namespace: parsed.data.namespace,
            timeout: parsed.data.timeout,
            labels: parsed.data.labels,
        };

        const resp = await fetchJsonWithTimeout(`${HF_BASE_URL}/api/jobs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...buildAuthHeaders(token),
            },
            body: JSON.stringify(payload),
        }, 20_000);

        if (!resp.ok) {
            return {
                ok: false,
                error: { name: 'HfApiError', message: formatHfJobsError(resp.status, resp.message, 'run') },
            };
        }

        const performedAt = new Date().toISOString();
        const safeJob = redactSensitive(resp.data);
        const jobId =
            isRecord(safeJob) && typeof safeJob.id === 'string'
                ? safeJob.id
                : (isRecord(safeJob) && typeof safeJob.jobId === 'string' ? safeJob.jobId : null);
        let jobJson = '';
        try {
            jobJson = JSON.stringify(safeJob, null, 2);
        } catch {
            jobJson = String(safeJob);
        }
        const markdown = [
            '## Hugging Face Job Submitted',
            '',
            jobId ? `**Job ID:** \`${jobId}\`` : '',
            `**Performed at:** ${performedAt}`,
            '',
            '```json',
            clipText(jobJson, 8000),
            '```',
        ].filter(Boolean).join('\n');
        const canvasData = { kind: 'hf_job_run_v1', performedAt, job: safeJob, markdown };

        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: 'training',
                        type: 'markdown',
                        title: 'Hugging Face Jobs',
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: 'training', type: 'markdown' } },
            ],
        };
    },
};

const hfJobIdSchema = z.object({
    jobId: z.string().min(1),
}).strict();

export const hfJobStatusTool: Tool = {
    category: 'ml',
    definition: {
        name: 'hf_job_status',
        description: 'Fetch the status/details for a Hugging Face Job by id.',
        parameters: {
            type: 'object',
            properties: {
                jobId: { type: 'string', description: 'Job id' },
            },
            required: ['jobId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfJobIdSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }
        const token = await resolveHfToken(context);
        if (!token) {
            return { ok: false, error: { name: 'AuthenticationError', message: 'Hugging Face token is not configured.' } };
        }

        const resp = await fetchJsonWithTimeout(`${HF_BASE_URL}/api/jobs/${parsed.data.jobId}`, {
            headers: buildAuthHeaders(token),
        }, 12_000);
        if (!resp.ok) {
            return {
                ok: false,
                error: { name: 'HfApiError', message: formatHfJobsError(resp.status, resp.message, 'job') },
            };
        }
        const performedAt = new Date().toISOString();
        const safeJob = redactSensitive(resp.data);
        let jobJson = '';
        try {
            jobJson = JSON.stringify(safeJob, null, 2);
        } catch {
            jobJson = String(safeJob);
        }
        const markdown = [
            '## Hugging Face Job Status',
            '',
            `**Job ID:** \`${parsed.data.jobId}\``,
            `**Performed at:** ${performedAt}`,
            '',
            '```json',
            clipText(jobJson, 8000),
            '```',
        ].join('\n');
        const canvasData = { kind: 'hf_job_status_v1', performedAt, job: safeJob, markdown };
        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: 'training',
                        type: 'markdown',
                        title: 'Hugging Face Jobs',
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: 'training', type: 'markdown' } },
            ],
        };
    },
};

export const hfJobLogsTool: Tool = {
    category: 'ml',
    definition: {
        name: 'hf_job_logs',
        description: 'Fetch logs for a Hugging Face Job by id.',
        parameters: {
            type: 'object',
            properties: {
                jobId: { type: 'string', description: 'Job id' },
            },
            required: ['jobId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfJobIdSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }
        const token = await resolveHfToken(context);
        if (!token) {
            return { ok: false, error: { name: 'AuthenticationError', message: 'Hugging Face token is not configured.' } };
        }

        const resp = await fetchTextWithTimeout(`${HF_BASE_URL}/api/jobs/${parsed.data.jobId}/logs`, {
            headers: buildAuthHeaders(token),
        }, 20_000);
        if (!resp.ok) {
            return {
                ok: false,
                error: { name: 'HfApiError', message: formatHfJobsError(resp.status, resp.message, 'job') },
            };
        }
        const performedAt = new Date().toISOString();
        const logs = clipText(resp.text, 8000);
        const markdown = [
            '## Hugging Face Job Logs',
            '',
            `**Job ID:** \`${parsed.data.jobId}\``,
            `**Performed at:** ${performedAt}`,
            '',
            '```text',
            logs,
            '```',
        ].join('\n');
        const canvasData = { kind: 'hf_job_logs_v1', performedAt, jobId: parsed.data.jobId, logs, markdown };
        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: 'training',
                        type: 'markdown',
                        title: 'Hugging Face Jobs',
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: 'training', type: 'markdown' } },
            ],
        };
    },
};

export const hfJobCancelTool: Tool = {
    category: 'ml',
    definition: {
        name: 'hf_job_cancel',
        description: 'Cancel a Hugging Face Job by id.',
        parameters: {
            type: 'object',
            properties: {
                jobId: { type: 'string', description: 'Job id' },
            },
            required: ['jobId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = hfJobIdSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { name: 'ValidationError', message: parsed.error.message } };
        }
        const token = await resolveHfToken(context);
        if (!token) {
            return { ok: false, error: { name: 'AuthenticationError', message: 'Hugging Face token is not configured.' } };
        }

        const resp = await fetchJsonWithTimeout(`${HF_BASE_URL}/api/jobs/${parsed.data.jobId}/cancel`, {
            method: 'POST',
            headers: buildAuthHeaders(token),
        }, 12_000);
        if (!resp.ok) {
            return {
                ok: false,
                error: { name: 'HfApiError', message: formatHfJobsError(resp.status, resp.message, 'job') },
            };
        }
        const performedAt = new Date().toISOString();
        const safeResult = redactSensitive(resp.data);
        let resultJson = '';
        try {
            resultJson = JSON.stringify(safeResult, null, 2);
        } catch {
            resultJson = String(safeResult);
        }
        const markdown = [
            '## Hugging Face Job Cancelled',
            '',
            `**Job ID:** \`${parsed.data.jobId}\``,
            `**Performed at:** ${performedAt}`,
            '',
            '```json',
            clipText(resultJson, 8000),
            '```',
        ].join('\n');
        const canvasData = { kind: 'hf_job_cancel_v1', performedAt, jobId: parsed.data.jobId, result: safeResult, markdown };
        return {
            ok: true,
            data: canvasData,
            sideEffects: [
                {
                    type: 'ui.upsertArtifact',
                    payload: {
                        id: 'training',
                        type: 'markdown',
                        title: 'Hugging Face Jobs',
                        content: canvasData,
                        status: 'final',
                        isCollaborative: true,
                    },
                },
                { type: 'ui.openArtifact', payload: { id: 'training', type: 'markdown' } },
            ],
        };
    },
};
