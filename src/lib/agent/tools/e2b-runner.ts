import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'crypto';
import path from 'path';

import type { AgentContext, Tool, ToolExecutionResult } from '../types';
import { AgentPersistence } from '../persistence';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    createStorageSignedUrl,
    deleteStoragePrefix,
    uploadStorageObject,
    uploadStorageObjectStream,
} from '@/lib/supabase/storage';
import { getIntegrationToken, type IntegrationProvider } from '@/lib/integrations/tokens';
import { findBlockedCommandReason } from '@/lib/security/command-guard';
import {
    ensureGithubPullRequest,
    getGithubRepoConnectionForUser,
    normalizeGithubRepoFullName,
    type GithubPublishMode,
    type GithubRepoConnection,
} from '@/lib/integrations/github';
import {
    addMinutesIso,
    getE2bSessionCreditsPerMinute,
    getE2bTrainingCreditsPerMinute,
    isInsufficientCreditsError,
    isUuid,
} from '@/lib/billing/e2b';
import { maybeBillSandboxSession as maybeBillSandboxSessionMetered } from '@/lib/billing/e2b-session-billing';
import {
    type SandboxStateV2,
    type SandboxEvent,
    type SandboxFile,
    type SandboxBrowserSnapshot,
    emptySandboxState,
    mergeSandboxState,
    normalizeSandboxState,
} from '@/lib/sandbox/sandbox-state';
import {
    type DesktopRecording,
    type DesktopStateV1,
    type DesktopEvent,
    emptyDesktopState,
    mergeDesktopState,
    normalizeDesktopState,
} from '@/lib/desktop/desktop-state';

type RunnerConfig = {
    baseUrl: string;
    token?: string;
    timeoutMs: number;
};

function parseIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCreditBalance(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function parseCreditSummaryTotal(value: unknown): number | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const total = parseCreditBalance(record.total_credits);
    if (typeof total === 'number') return total;
    const base = parseCreditBalance(record.credits_balance);
    const daily = parseCreditBalance(record.daily_credits_balance);
    if (typeof base === 'number' && typeof daily === 'number') return base + daily;
    return null;
}

async function billSandboxSessionIfNeeded(context: AgentContext, sessionId: string): Promise<void> {
    if (!getE2bSessionCreditsPerMinute()) return;
    if (!isUuid(sessionId)) return;
    const { userId, chatId } = requireContextIds(context);
    if (!isUuid(userId) || !isUuid(chatId)) return;
    try {
        const supabase = await createClient();
        const authed = (await supabase.auth.getUser()).data.user;
        if (!authed || authed.id !== userId) return;
        await maybeBillSandboxSessionMetered({ userId, chatId, sessionId });
    } catch {
        // Best-effort only.
    }
}

function getRunnerConfig(): RunnerConfig {
    const baseUrl = (process.env.E2B_RUNNER_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
        throw new Error('E2B_RUNNER_URL is not configured on the server.');
    }
    const token = (process.env.E2B_RUNNER_TOKEN || '').trim() || undefined;
    const timeoutMs = parseIntEnv('E2B_RUNNER_TIMEOUT_MS', 30_000);
    return { baseUrl, token, timeoutMs };
}

function buildRunnerHeaders(token?: string, extra?: Record<string, string>) {
    const headers: Record<string, string> = {
        ...(extra ?? {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function runnerFetchJson<T>(
    urlPath: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; status: number; data?: T; errorText?: string }> {
    const { baseUrl, token, timeoutMs } = getRunnerConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? timeoutMs);
    try {
        const resp = await fetch(`${baseUrl}${urlPath}`, {
            ...init,
            headers: buildRunnerHeaders(token, { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) }),
            signal: controller.signal,
        });
        const text = await resp.text();
        let data: T | undefined = undefined;
        if (text) {
            try {
                data = JSON.parse(text) as T;
            } catch {
                data = undefined;
            }
        }
        if (!resp.ok) {
            return { ok: false, status: resp.status, data, errorText: text };
        }
        return { ok: true, status: resp.status, data };
    } finally {
        clearTimeout(timeout);
    }
}

async function runnerFetchBinary(
    urlPath: string
): Promise<{ ok: boolean; status: number; headers: Headers; body?: ArrayBuffer; errorText?: string }> {
    const { baseUrl, token, timeoutMs } = getRunnerConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(`${baseUrl}${urlPath}`, {
            headers: buildRunnerHeaders(token),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, status: resp.status, headers: resp.headers, errorText: text };
        }
        const body = await resp.arrayBuffer();
        return { ok: true, status: resp.status, headers: resp.headers, body };
    } finally {
        clearTimeout(timeout);
    }
}

function isMissingSessionMessage(message?: string): boolean {
    const text = String(message || '').toLowerCase();
    return text.includes('session not found')
        || text.includes('sandbox session expired')
        || text.includes('sandbox was not found')
        || text.includes('expired');
}

function isMissingSessionResponse(resp: { ok: boolean; status: number; errorText?: string }): boolean {
    if (resp.ok) return false;
    if (resp.status === 404 || resp.status === 410) return true;
    return isMissingSessionMessage(resp.errorText);
}

async function createReplacementSession(workdir?: string): Promise<{ sessionId: string; workdir: string }> {
    const created = await runnerFetchJson<{ session_id: string; workdir: string }>('/sessions', {
        method: 'POST',
        body: JSON.stringify({ workdir }),
    });
    if (!created.ok || !created.data?.session_id) {
        throw new Error(created.errorText || 'Failed to recover sandbox session.');
    }
    return {
        sessionId: created.data.session_id,
        workdir: created.data.workdir || workdir || '/code',
    };
}

async function withSessionRecoveryJson<T>(args: {
    initialSessionId: string;
    workdir?: string;
    request: (sessionId: string) => Promise<{ ok: boolean; status: number; data?: T; errorText?: string }>;
}): Promise<{
    sessionId: string;
    result: { ok: boolean; status: number; data?: T; errorText?: string };
    recovered: boolean;
    recoveredWorkdir?: string;
}> {
    const first = await args.request(args.initialSessionId);
    if (!isMissingSessionResponse(first)) {
        return { sessionId: args.initialSessionId, result: first, recovered: false };
    }
    const replacement = await createReplacementSession(args.workdir);
    const second = await args.request(replacement.sessionId);
    return {
        sessionId: replacement.sessionId,
        result: second,
        recovered: true,
        recoveredWorkdir: replacement.workdir,
    };
}

function requireContextIds(context: AgentContext): { chatId: string; userId: string } {
    const chatId = String(context.projectId || '').trim();
    const userId = String(context.userId || '').trim();
    if (!chatId || !userId) {
        throw new Error('Missing chat or user context.');
    }
    return { chatId, userId };
}

function readFirstEnvToken(names: string[]): string | undefined {
    for (const name of names) {
        const value = (process.env[name] || '').trim();
        if (value) return value;
    }
    return undefined;
}

async function resolveUserIntegrationToken(
    userId: string,
    provider: IntegrationProvider,
    envNames: string[]
): Promise<string | undefined> {
    try {
        const userToken = await getIntegrationToken(userId, provider);
        if (userToken) return userToken;
    } catch {
        // Fall back to server env when integration storage is unavailable.
    }
    return readFirstEnvToken(envNames);
}

const GITHUB_TOKEN_ENV_NAMES = ['GITHUB_TOKEN', 'GITHUB_PAT', 'GITHUB_PERSONAL_ACCESS_TOKEN'];

function safeFileName(value: string, fallback: string): string {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const cleaned = trimmed.replace(/[^a-z0-9._-]+/gi, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || fallback;
}

function inferNameFromUrl(url: string, fallback: string): string {
    try {
        const u = new URL(url);
        const name = path.basename(u.pathname);
        return safeFileName(name, fallback);
    } catch {
        return fallback;
    }
}

function parseContentDispositionFilename(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = /filename\*?=(?:UTF-8''|")?([^;\r\n"]+)/i.exec(value);
    if (!match?.[1]) return null;
    const raw = match[1].trim();
    try {
        return decodeURIComponent(raw.replace(/^"+|"+$/g, ''));
    } catch {
        return raw.replace(/^"+|"+$/g, '');
    }
}

async function resolveTrainingExpectedOutputName(chatId: string, taskId: string): Promise<string | null> {
    try {
        const state = await AgentPersistence.loadState(chatId);
        const artifacts = Array.isArray(state?.artifacts) ? state!.artifacts : [];
        const training = artifacts.find((artifact) => {
            if (!artifact || artifact.id !== 'training') return false;
            const content = artifact.content;
            return typeof content === 'object' && content !== null && (content as { taskId?: unknown }).taskId === taskId;
        });
        const content = training?.content as { expectedOutputName?: unknown } | undefined;
        return typeof content?.expectedOutputName === 'string' ? content.expectedOutputName.trim() : null;
    } catch {
        return null;
    }
}

function assertNoParentSegments(value: string, label: string): string {
    const normalized = value.replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) {
        throw new Error(`${label} cannot include ".." segments.`);
    }
    return normalized;
}

function normalizeSandboxWorkdir(workdir?: string): string | undefined {
    const raw = String(workdir ?? '').trim();
    if (!raw) return undefined;
    const normalized = assertNoParentSegments(raw, 'workdir');
    const parts = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (normalized.startsWith('/')) {
        return parts.length > 0 ? `/${parts.join('/')}` : '/';
    }
    if (parts.length === 0) return '/code';
    return `/code/${parts.join('/')}`;
}

function resolveSandboxPath(inputPath: string, workdir?: string): string {
    const raw = String(inputPath ?? '').trim();
    if (!raw) return raw;
    const normalizedPath = assertNoParentSegments(raw, 'path');
    if (normalizedPath.startsWith('/')) {
        return path.posix.normalize(normalizedPath);
    }
    const base = String(workdir ?? '').trim();
    if (!base) {
        return path.posix.normalize(path.posix.join('/code', normalizedPath));
    }
    const normalizedBase = assertNoParentSegments(base, 'workdir');
    return path.posix.normalize(path.posix.join(normalizedBase, normalizedPath));
}

function normalizeGitBranch(value: string | undefined, fallback: string): string {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    if (raw.includes(' ') || raw.includes('..')) return fallback;
    return raw;
}

function pickGithubPublishMode(mode: unknown, fallback: GithubPublishMode): GithubPublishMode {
    return mode === 'direct' ? 'direct' : fallback;
}

function createFallbackGithubConnection(userId: string, repoFullName: string): GithubRepoConnection {
    return {
        id: `fallback-${repoFullName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}`,
        userId,
        repoFullName,
        isPrivate: true,
        baseBranch: 'main',
        workBranch: 'tuna',
        defaultPublishMode: 'pr',
    };
}

function isRepoConnectionStoreUnavailable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('integration_repo_connections')
        || message.includes('relation "integration_repo_connections" does not exist')
        || message.includes('schema cache')
    );
}

async function resolveGithubConnectionForTool(
    context: AgentContext,
    args: { connectionId?: string; repoFullName?: string }
): Promise<GithubRepoConnection> {
    const { userId } = requireContextIds(context);
    const connectionId = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
    const repoFullName = normalizeGithubRepoFullName(args.repoFullName ?? '');

    try {
        const connection = await getGithubRepoConnectionForUser({
            userId,
            connectionId: connectionId || undefined,
            repoFullName: repoFullName || undefined,
        });
        if (connection) return connection;
    } catch (error) {
        // Some environments do not have repo-connection tables available. Allow PAT-only flows with repoFullName.
        if (repoFullName && isRepoConnectionStoreUnavailable(error)) {
            return createFallbackGithubConnection(userId, repoFullName);
        }
        throw error;
    }

    if (repoFullName) {
        return createFallbackGithubConnection(userId, repoFullName);
    }
    if (connectionId) {
        throw new Error(
            'GitHub repo connection not found. Provide repoFullName in owner/repo format, or connect the repo in Integrations.'
        );
    }
    throw new Error('GitHub repo connection not found. Provide connectionId or repoFullName in owner/repo format.');
}

function isSafeSandboxPersistPath(value: string): boolean {
    return value === '/code' || value.startsWith('/code/') || value === '/pipelines' || value.startsWith('/pipelines/');
}

function normalizeStoragePrefixParts(value: string): string {
    const raw = value.trim().replace(/^\/+|\/+$/g, '');
    if (!raw) return '';
    const parts = raw.split('/').filter(Boolean);
    if (parts.includes('..')) {
        throw new Error('targetPrefix cannot include ".."');
    }
    return parts.map((segment) => safeFileName(segment, 'segment')).filter(Boolean).join('/');
}

function isDirItemType(value: unknown): boolean {
    const t = typeof value === 'string' ? value.toLowerCase() : '';
    return t.includes('dir');
}

async function listSandboxTreeFiles(args: {
    sessionId: string;
    rootPath: string;
    maxFiles: number;
    skipDirNames?: string[];
}): Promise<Array<{ sandboxPath: string; relativePath: string; size?: number }>> {
    const queue = [args.rootPath];
    const visited = new Set<string>();
    const files: Array<{ sandboxPath: string; relativePath: string; size?: number }> = [];
    const skipDirNames = new Set(
        (args.skipDirNames ?? [])
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean)
    );

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        if (visited.has(current)) continue;
        visited.add(current);

        const listed = await runnerFetchJson<{ items?: Array<{ path?: string; type?: string; size?: number }> }>(
            `/sessions/${encodeURIComponent(args.sessionId)}/files?path=${encodeURIComponent(current)}`,
            { method: 'GET' }
        );
        if (!listed.ok) {
            throw new Error(listed.errorText || `Failed to list sandbox directory: ${current}`);
        }
        const items = Array.isArray(listed.data?.items) ? listed.data!.items! : [];
        for (const item of items) {
            const p = typeof item.path === 'string' ? item.path.trim() : '';
            if (!p) continue;
            if (!isSafeSandboxPersistPath(p)) continue;
            if (isDirItemType(item.type)) {
                const dirName = path.posix.basename(p).trim().toLowerCase();
                if (skipDirNames.has(dirName)) continue;
                if (!visited.has(p)) queue.push(p);
                continue;
            }
            const relRaw = p.startsWith(`${args.rootPath}/`) ? p.slice(args.rootPath.length + 1) : path.posix.basename(p);
            const relParts = relRaw
                .split('/')
                .filter(Boolean)
                .map((segment) => safeFileName(segment, 'file'))
                .filter(Boolean);
            const relativePath = relParts.length > 0
                ? relParts.join('/')
                : safeFileName(path.posix.basename(p) || 'file', 'file');
            files.push({
                sandboxPath: p,
                relativePath,
                size: typeof item.size === 'number' ? item.size : undefined,
            });
            if (files.length > args.maxFiles) {
                throw new Error(`Too many files in tree (max ${args.maxFiles}).`);
            }
        }
    }

    return files;
}

type SandboxUploadContentChoice = {
    source: 'text' | 'base64';
    contentText?: string;
    contentBase64?: string;
    expectedBytes: number;
};

function pickSandboxUploadContent(input: { contentText?: string; contentBase64?: string }): SandboxUploadContentChoice {
    const rawText = typeof input.contentText === 'string' ? input.contentText : undefined;
    const rawBase64 = typeof input.contentBase64 === 'string' ? input.contentBase64 : undefined;
    if (rawBase64 && rawBase64.length > 0) {
        const expectedBytes = Buffer.from(rawBase64, 'base64').byteLength;
        if (expectedBytes > 0 || rawText === undefined) {
            return { source: 'base64', contentBase64: rawBase64, expectedBytes };
        }
    }
    if (rawText !== undefined) {
        return { source: 'text', contentText: rawText, expectedBytes: Buffer.byteLength(rawText, 'utf8') };
    }
    if (rawBase64 !== undefined) {
        const expectedBytes = Buffer.from(rawBase64, 'base64').byteLength;
        return { source: 'base64', contentBase64: rawBase64, expectedBytes };
    }
    return { source: 'text', contentText: '', expectedBytes: 0 };
}

async function fetchSandboxFileSize(sessionId: string, sandboxPath: string): Promise<number | null> {
    const parent = path.posix.dirname(sandboxPath);
    if (!parent || parent === '/' || parent === '.') return null;
    const listed = await runnerFetchJson<{ items?: Array<{ path?: string; size?: number }> }>(
        `/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(parent)}`,
        { method: 'GET' }
    );
    if (!listed.ok) return null;
    const items = Array.isArray(listed.data?.items) ? listed.data!.items! : [];
    const match = items.find((item) => typeof item.path === 'string' && item.path.trim() === sandboxPath);
    return typeof match?.size === 'number' ? match.size : null;
}

function normalizeBase64ChunkSize(value: number): number {
    const raw = Number.isFinite(value) ? Math.floor(value) : 120_000;
    const adjusted = raw - (raw % 4);
    return adjusted >= 4 ? adjusted : 4;
}

function chunkBase64String(value: string, chunkChars: number): string[] {
    const cleaned = value.replace(/\s+/g, '');
    if (!cleaned) return [];
    const size = normalizeBase64ChunkSize(chunkChars);
    const chunks: string[] = [];
    for (let offset = 0; offset < cleaned.length; offset += size) {
        chunks.push(cleaned.slice(offset, offset + size));
    }
    return chunks;
}

async function writeSandboxFileViaExec(args: {
    sessionId: string;
    filePath: string;
    base64: string;
    workdir?: string;
}): Promise<{ ok: boolean; sessionId: string; recoveredEvents: SandboxEvent[]; errorText?: string }> {
    const chunkChars = normalizeBase64ChunkSize(parseIntEnv('RUNNER_SANDBOX_UPLOAD_CHUNK_CHARS', 120_000));
    const maxChunks = parseIntEnv('RUNNER_SANDBOX_UPLOAD_MAX_CHUNKS', 400);
    const chunks = chunkBase64String(args.base64, chunkChars);
    if (chunks.length === 0) {
        return { ok: false, sessionId: args.sessionId, recoveredEvents: [], errorText: 'No base64 content to write.' };
    }
    if (chunks.length > maxChunks) {
        return {
            ok: false,
            sessionId: args.sessionId,
            recoveredEvents: [],
            errorText: `File too large for exec fallback (${chunks.length} chunks).`,
        };
    }
    const recoveredEvents: SandboxEvent[] = [];
    let currentSessionId = args.sessionId;
    const workdir = args.workdir ?? '/code';
    const fileDir = path.posix.dirname(args.filePath) || '/';
    for (let i = 0; i < chunks.length; i += 1) {
        const mode = i === 0 ? 'wb' : 'ab';
        const script = [
            'import base64, os',
            `path = ${JSON.stringify(args.filePath)}`,
            `os.makedirs(${JSON.stringify(fileDir)}, exist_ok=True)`,
            `data = base64.b64decode(${JSON.stringify(chunks[i])})`,
            `with open(path, ${JSON.stringify(mode)}) as f:`,
            '    f.write(data)',
        ].join('\n');
        const command = `python - <<'PY'\n${script}\nPY`;
        const execBody: Record<string, unknown> = { command, cwd: workdir };
        const attemptedSessionId = currentSessionId;
        const call = await withSessionRecoveryJson<Record<string, unknown>>({
            initialSessionId: currentSessionId,
            workdir,
            request: (sessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${sessionId}/exec`, {
                method: 'POST',
                body: JSON.stringify(execBody),
            }),
        });
        currentSessionId = call.sessionId;
        if (call.recovered) {
            recoveredEvents.push({
                id: randomUUID(),
                kind: 'session',
                label: 'Session auto-recovered',
                status: 'completed',
                startedAt: nowIso(),
                finishedAt: nowIso(),
                meta: {
                    previousSessionId: attemptedSessionId,
                    recoveredSessionId: currentSessionId,
                },
            });
        }
        const result = call.result;
        if (!result.ok || !result.data) {
            return {
                ok: false,
                sessionId: currentSessionId,
                recoveredEvents,
                errorText: result.errorText || 'Sandbox exec fallback failed.',
            };
        }
        const exitCode = typeof result.data.exit_code === 'number' ? result.data.exit_code : undefined;
        const timedOut = Boolean(result.data.timed_out);
        if (exitCode !== 0 || timedOut) {
            return {
                ok: false,
                sessionId: currentSessionId,
                recoveredEvents,
                errorText: 'Sandbox exec fallback failed.',
            };
        }
    }
    return { ok: true, sessionId: currentSessionId, recoveredEvents };
}

async function mirrorRepoTreeToFileManager(args: {
    chatId: string;
    sessionId: string;
    repoFullName: string;
    rootPath: string;
}): Promise<{ basePrefix: string; count: number; totalBytes: number }> {
    if (!isSafeSandboxPersistPath(args.rootPath)) {
        throw new Error('Repo path must stay under /code or /pipelines.');
    }

    const maxFiles = parseIntEnv('RUNNER_REPO_SNAPSHOT_MAX_FILES', parseIntEnv('RUNNER_PERSIST_TREE_MAX_FILES', 2000));
    const files = await listSandboxTreeFiles({
        sessionId: args.sessionId,
        rootPath: args.rootPath,
        maxFiles,
        skipDirNames: ['.git'],
    });
    if (files.length === 0) {
        throw new Error(`No files found under ${args.rootPath} to mirror into Files.`);
    }

    const maxSingleBytes = parseIntEnv('RUNNER_MAX_FILE_BYTES', 20_000_000);
    const maxTotalBytes = parseIntEnv(
        'RUNNER_REPO_SNAPSHOT_MAX_BYTES',
        parseIntEnv('RUNNER_PERSIST_TREE_MAX_BYTES', 100_000_000)
    );
    const repoSlug = safeFileName(args.repoFullName.replace('/', '-'), 'repo');
    const basePrefix = `runner-outputs/${args.chatId}/runtime/repos/${repoSlug}/${args.sessionId}`;
    await deleteStoragePrefix('artifacts', `${basePrefix}/`).catch(() => undefined);
    let totalBytes = 0;
    let count = 0;

    for (const file of files) {
        const binary = await runnerFetchBinary(
            `/sessions/${encodeURIComponent(args.sessionId)}/files/content?path=${encodeURIComponent(file.sandboxPath)}`
        );
        if (!binary.ok || !binary.body) {
            throw new Error(binary.errorText || `Failed to read ${file.sandboxPath}`);
        }
        const buffer = Buffer.from(binary.body);
        if (buffer.byteLength > maxSingleBytes) {
            throw new Error(`File too large: ${file.sandboxPath} (max ${maxSingleBytes} bytes).`);
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > maxTotalBytes) {
            throw new Error(`Repo snapshot exceeded max total bytes (${maxTotalBytes}).`);
        }
        const storagePath = `${basePrefix}/${file.relativePath}`;
        await uploadStorageObject('artifacts', storagePath, buffer, {
            contentType: 'application/octet-stream',
        });
        count += 1;
    }

    return { basePrefix, count, totalBytes };
}

function parseLeadingCd(command: string): string | null {
    const trimmed = String(command ?? '').trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^cd\s+(.+?)(?:\s*(?:&&|;)\s*|$)/);
    if (!match) return null;
    let target = match[1]?.trim() ?? '';
    if (!target) return null;
    if (
        (target.startsWith('"') && target.endsWith('"') && target.length >= 2) ||
        (target.startsWith("'") && target.endsWith("'") && target.length >= 2)
    ) {
        target = target.slice(1, -1);
    }
    return target.trim() || null;
}

type InputRef = {
    name?: string;
    url?: string;
    storagePath?: string;
    bucket?: 'uploads' | 'artifacts';
    text?: string;
    base64?: string;
    mimeType?: string;
};

type HfPrefetchRef = {
    repo: string;
    revision?: string;
    allowPatterns?: string[];
    ignorePatterns?: string[];
};

type GithubPrefetchRef = {
    repo: string;
    ref?: string;
    subdir?: string;
    includePaths?: string[];
    excludePaths?: string[];
};

type KaggleDatasetPrefetchRef = {
    dataset: string;
    targetDir?: string;
    unzip?: boolean;
};

type TrainingBackend = 'e2b' | 'sagemaker';

type WandbTrackingRef = {
    project?: string;
    entity?: string;
    runName?: string;
    tags?: string[];
    notes?: string;
    mode?: 'online' | 'offline' | 'disabled';
    config?: Record<string, unknown>;
};

type SageMakerExecutionRef = {
    trainingJobName?: string;
    executionRoleArn?: string;
    imageUri?: string;
    instanceType?: string;
    instanceCount?: number;
    volumeSizeGb?: number;
    maxRuntimeSeconds?: number;
    outputS3Uri?: string;
    hyperparameters?: Record<string, string>;
};

const inputRefToolSchema = {
    type: 'object',
    description:
        'File reference. Provide at least one of: url, storagePath, text, base64. Optionally set name/bucket/mimeType.',
    properties: {
        name: { type: 'string', description: 'Optional filename override.' },
        url: { type: 'string', description: 'Publicly reachable URL (https://...) to fetch.' },
        storagePath: {
            type: 'string',
            description:
                'Supabase Storage object path. If bucket=uploads, must be scoped to the current chat (userId/chatId prefix).',
        },
        bucket: { type: 'string', enum: ['uploads', 'artifacts'], description: 'Storage bucket for storagePath.' },
        text: { type: 'string', description: 'Inline UTF-8 content.' },
        base64: { type: 'string', description: 'Inline base64-encoded content.' },
        mimeType: { type: 'string', description: 'Optional MIME type (e.g. text/csv, text/x-python).' },
    },
    // NOTE: removed `anyOf` — it is not supported in Azure Responses API strict mode
    // and was the primary trigger for "model_error: The model produced invalid content".
    // The "at least one of url/storagePath/text/base64" constraint is enforced by the
    // Zod schema at runtime instead.
    additionalProperties: false,
} as const;

const hfPrefetchToolSchema = {
    type: 'object',
    description:
        'Prefetch a Hugging Face repo into the sandbox before training. Use for models or datasets, including private repos when a user token is configured.',
    properties: {
        repo: { type: 'string', description: 'Hugging Face repo id, e.g. "distilbert-base-uncased".' },
        revision: { type: 'string', description: 'Optional branch, tag, or commit sha.' },
        allowPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional include patterns for selective download.' },
        ignorePatterns: { type: 'array', items: { type: 'string' }, description: 'Optional exclude patterns for selective download.' },
    },
    required: ['repo'],
} as const;

const githubPrefetchToolSchema = {
    type: 'object',
    description:
        'Prefetch a GitHub repository into the sandbox before training. Supports private repositories when a user token is configured.',
    properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format.' },
        ref: { type: 'string', description: 'Optional git ref (branch, tag, or sha).' },
        subdir: { type: 'string', description: 'Optional subdirectory to expose as the effective repo root.' },
        includePaths: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist path prefixes within the repo.' },
        excludePaths: { type: 'array', items: { type: 'string' }, description: 'Optional denylist path prefixes within the repo.' },
    },
    required: ['repo'],
} as const;

const kaggleDatasetPrefetchToolSchema = {
    type: 'object',
    description:
        'Prefetch a Kaggle dataset into the sandbox before training. Requires a configured Kaggle token.',
    properties: {
        dataset: { type: 'string', description: 'Kaggle dataset slug in owner/dataset format.' },
        targetDir: { type: 'string', description: 'Optional destination directory in sandbox (default: /code/.kaggle_data/<dataset>).'},
        unzip: { type: 'boolean', description: 'Whether to unzip after download (default true).' },
    },
    required: ['dataset'],
} as const;

const wandbTrackingToolSchema = {
    type: 'object',
    description:
        'Optional Weights & Biases tracking metadata. This metadata is server-side only and should never be placed in client-exposed variables.',
    properties: {
        project: { type: 'string', description: 'W&B project name (defaults to WANDB_PROJECT env when omitted).' },
        entity: { type: 'string', description: 'Optional W&B team/entity override.' },
        runName: { type: 'string', description: 'Optional run display name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional W&B tags.' },
        notes: { type: 'string', description: 'Optional run notes.' },
        mode: { type: 'string', enum: ['online', 'offline', 'disabled'], description: 'Tracking mode (default online).' },
        config: { type: 'object', description: 'Optional free-form config payload for experiment metadata.' },
    },
} as const;

const sageMakerExecutionToolSchema = {
    type: 'object',
    description:
        'Optional SageMaker execution metadata. Use this when requesting backend="sagemaker".',
    properties: {
        trainingJobName: { type: 'string', description: 'Optional explicit SageMaker TrainingJobName.' },
        executionRoleArn: { type: 'string', description: 'Override execution role ARN (server validates permissions).' },
        imageUri: { type: 'string', description: 'Training image URI.' },
        instanceType: { type: 'string', description: 'SageMaker instance type (for example ml.g5.2xlarge).' },
        instanceCount: { type: 'number', description: 'Number of instances (default 1).' },
        volumeSizeGb: { type: 'number', description: 'EBS volume size in GiB.' },
        maxRuntimeSeconds: { type: 'number', description: 'Max runtime for the training job.' },
        outputS3Uri: { type: 'string', description: 'S3 output location for model artifacts.' },
        hyperparameters: {
            type: 'object',
            description: 'Optional SageMaker hyperparameters object (string values).',
            additionalProperties: { type: 'string' },
        },
    },
} as const;

const inputRefSchema = z.object({
    name: z.string().optional(),
    url: z.string().url().optional(),
    storagePath: z.string().min(1).optional(),
    bucket: z.enum(['uploads', 'artifacts']).optional(),
    text: z.string().optional(),
    base64: z.string().optional(),
    mimeType: z.string().optional(),
}).refine((value) => Boolean(value.url || value.storagePath || value.text || value.base64), {
    message: 'Input must include url, storagePath, text, or base64 content.',
});

const hfPrefetchSchema = z.object({
    repo: z.string().min(1),
    revision: z.string().min(1).optional(),
    allowPatterns: z.array(z.string().min(1)).optional(),
    ignorePatterns: z.array(z.string().min(1)).optional(),
}).strict();

const githubPrefetchSchema = z.object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be in "owner/repo" format.'),
    ref: z.string().min(1).optional(),
    subdir: z.string().min(1).optional(),
    includePaths: z.array(z.string().min(1)).optional(),
    excludePaths: z.array(z.string().min(1)).optional(),
}).strict();

const kaggleDatasetPrefetchSchema = z.object({
    dataset: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'dataset must be in "owner/dataset" format.'),
    targetDir: z.string().min(1).optional(),
    unzip: z.boolean().optional(),
}).strict();

const wandbTrackingSchema = z.object({
    project: z.string().min(1).optional(),
    entity: z.string().min(1).optional(),
    runName: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    notes: z.string().min(1).optional(),
    mode: z.enum(['online', 'offline', 'disabled']).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
}).strict();

const sageMakerExecutionSchema = z.object({
    trainingJobName: z.string().min(1).optional(),
    executionRoleArn: z.string().min(1).optional(),
    imageUri: z.string().min(1).optional(),
    instanceType: z.string().min(1).optional(),
    instanceCount: z.number().int().positive().optional(),
    volumeSizeGb: z.number().int().positive().optional(),
    maxRuntimeSeconds: z.number().int().positive().optional(),
    outputS3Uri: z.string().url().optional(),
    hyperparameters: z.record(z.string(), z.string()).optional(),
}).strict();

async function resolveInputRef(
    ref: InputRef,
    context: AgentContext,
    fallbackName: string,
    options?: { requirePy?: boolean }
): Promise<{ name: string; url: string; storagePath?: string }> {
    const { chatId, userId } = requireContextIds(context);
    const ttl = parseIntEnv('RUNNER_SIGNED_URL_TTL_SECONDS', 900);
    const bucket = ref.bucket ?? 'uploads';
    const inferredName = ref.name
        ? safeFileName(ref.name, fallbackName)
        : ref.url
            ? inferNameFromUrl(ref.url, fallbackName)
            : fallbackName;
    const name = options?.requirePy && !inferredName.endsWith('.py')
        ? `${inferredName}.py`
        : inferredName;

    if (ref.url) {
        return { name, url: ref.url };
    }
    if (ref.storagePath) {
        if (bucket === 'uploads') {
            const prefix = `${userId}/${chatId}/`;
            if (!ref.storagePath.startsWith(prefix)) {
                throw new Error(
                    `storagePath "${ref.storagePath}" must be scoped to the current chat ` +
                    `(expected prefix "${prefix}"). If the file was not uploaded in this chat, ` +
                    `use "text" (inline content) or "url" (direct download link) instead of "storagePath".`
                );
            }
        }
        const url = await createStorageSignedUrl(bucket, ref.storagePath, ttl);
        return { name, url, storagePath: ref.storagePath };
    }

    const buffer = ref.base64
        ? Buffer.from(ref.base64, 'base64')
        : Buffer.from(ref.text ?? '', 'utf-8');
    const storagePath = `${userId}/${chatId}/runner-inputs/${randomUUID()}-${name}`;
    const contentType = ref.mimeType || (options?.requirePy ? 'text/x-python' : 'application/octet-stream');
    await uploadStorageObject(bucket, storagePath, buffer, { contentType });
    const url = await createStorageSignedUrl(bucket, storagePath, ttl);
    return { name, url, storagePath };
}

function clip(text: string, max = 4000): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max).trim()}…`;
}

type SandboxOutputClip = {
    text: string;
    truncated: boolean;
    originalChars: number;
};

function clampInt(value: number, min: number, max: number): number {
    const rounded = Math.floor(value);
    if (!Number.isFinite(rounded)) return min;
    return Math.min(max, Math.max(min, rounded));
}

function clipSandboxOutput(text: string): SandboxOutputClip {
    const raw = text ?? '';
    const maxChars = clampInt(parseIntEnv('RUNNER_SANDBOX_OUTPUT_MAX_CHARS', 8000), 1000, 40000);
    if (raw.length <= maxChars) {
        return { text: raw, truncated: false, originalChars: raw.length };
    }
    const headChars = Math.max(200, Math.floor(maxChars * 0.35));
    const tailChars = Math.max(0, maxChars - headChars);
    const head = headChars > 0 ? raw.slice(0, headChars).trimEnd() : '';
    const tail = tailChars > 0 ? raw.slice(-tailChars).trimStart() : '';
    const omitted = Math.max(0, raw.length - headChars - tailChars);
    const marker = `\n\n…[${omitted} chars truncated]…\n\n`;
    return {
        text: head && tail ? `${head}${marker}${tail}` : head || tail,
        truncated: true,
        originalChars: raw.length,
    };
}

function buildRunnerProxyUrl(chatId: string, taskId: string, file: string): string {
    const params = new URLSearchParams({ chatId, taskId, file });
    return `/api/runner/download?${params.toString()}`;
}

function buildDesktopStreamProxyUrl(chatId: string, sessionId: string): string {
    const params = new URLSearchParams({ chatId });
    return `/api/runner/desktop/sessions/${sessionId}/stream?${params.toString()}`;
}

function nowIso(): string {
    return new Date().toISOString();
}

async function loadSandboxState(context: AgentContext): Promise<SandboxStateV2> {
    const { chatId } = requireContextIds(context);
    const state = await AgentPersistence.loadState(chatId);
    const artifact = state?.artifacts?.find((a) => a.id === 'sandbox');
    const normalized = normalizeSandboxState(artifact?.content);
    return normalized ?? emptySandboxState({ status: 'idle' });
}

function appendSandboxEvent(state: SandboxStateV2, event: SandboxEvent): SandboxStateV2 {
    return mergeSandboxState(state, { events: [...state.events, event], updatedAt: nowIso() });
}

async function loadDesktopState(context: AgentContext): Promise<DesktopStateV1> {
    const { chatId } = requireContextIds(context);
    const state = await AgentPersistence.loadState(chatId);
    const artifact = state?.artifacts?.find((a) => a.id === 'desktop');
    const normalized = normalizeDesktopState(artifact?.content);
    return normalized ?? emptyDesktopState({ status: 'idle' });
}

function appendDesktopEvent(state: DesktopStateV1, event: DesktopEvent): DesktopStateV1 {
    return mergeDesktopState(state, { events: [...state.events, event], updatedAt: nowIso() });
}

const trainingSubmitSchema = z.object({
    input: inputRefSchema,
    script: inputRefSchema,
    extraInputs: z.array(inputRefSchema.safeExtend({ name: z.string().min(1) })).optional(),
    hfModels: z.array(hfPrefetchSchema).optional(),
    hfDatasets: z.array(hfPrefetchSchema).optional(),
    github: z.array(githubPrefetchSchema).optional(),
    kaggleDatasets: z.array(kaggleDatasetPrefetchSchema).optional(),
    backend: z.enum(['e2b', 'sagemaker']).optional(),
    sagemaker: sageMakerExecutionSchema.optional(),
    wandb: wandbTrackingSchema.optional(),
    expectedOutputName: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
}).strict();

const trainingStatusSchema = z.object({
    taskId: z.string().min(1),
}).strict();

const trainingDownloadSchema = z.object({
    taskId: z.string().min(1),
    file: z.enum(['model', 'log', 'metadata']).default('model'),
    copyToStorage: z.boolean().optional(),
}).strict();

const sandboxStartSchema = z.object({
    workdir: z.string().optional(),
}).strict();

const sandboxStopSchema = z.object({
    sessionId: z.string().min(1),
}).strict();

/**
 * Zod helper: accept either a plain object or a JSON-encoded string and
 * parse it into `Record<string, V>`. Tool definitions now declare `env`,
 * `viewport`, and `params` as `{ type: 'string' }` for Responses API
 * strict-mode compatibility, so the model may send a JSON string.
 */
function jsonOrRecord<V extends z.ZodTypeAny>(valueSchema: V) {
    return z.preprocess((val) => {
        if (typeof val === 'string') {
            try { return JSON.parse(val); } catch { return val; }
        }
        return val;
    }, z.record(z.string(), valueSchema).optional());
}

const sandboxExecSchema = z.object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    env: jsonOrRecord(z.string()),
}).strict();

const pidSchema = z.preprocess(
    (value) => {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!/^\d+$/.test(trimmed)) return value;
            return Number.parseInt(trimmed, 10);
        }
        return value;
    },
    z.number().int().positive()
);

const sandboxCommandStartSchema = z.object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    env: jsonOrRecord(z.string()),
    background: z.boolean().optional(),
    stream: z.boolean().optional(),
}).strict();

const sandboxCommandStatusSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
}).strict();

const sandboxCommandStdinSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
    data: z.string(),
}).strict();

const sandboxCommandKillSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
}).strict();

const sandboxPtyStartSchema = z.object({
    sessionId: z.string().min(1),
    rows: z.number().int().positive().optional(),
    cols: z.number().int().positive().optional(),
    cwd: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    env: jsonOrRecord(z.string()),
    stream: z.boolean().optional(),
}).strict();

const sandboxPtyStatusSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
    after: z.number().int().nonnegative().optional(),
}).strict();

const sandboxPtyStdinSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
    data: z.string(),
}).strict();

const sandboxPtyResizeSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
}).strict();

const sandboxPtyKillSchema = z.object({
    sessionId: z.string().min(1),
    pid: pidSchema,
}).strict();

const sandboxUploadSchema = z.object({
    sessionId: z.string().min(1),
    path: z.string().min(1),
    contentText: z.string().optional(),
    contentBase64: z.string().optional(),
}).strict().refine(
    (value) => typeof value.contentText === 'string' || typeof value.contentBase64 === 'string',
    { message: 'Provide contentText or contentBase64.' }
);

const sandboxDownloadSchema = z.object({
    sessionId: z.string().min(1),
    path: z.string().min(1),
}).strict();

const sandboxPersistTreeSchema = z.object({
    sessionId: z.string().min(1),
    rootPath: z.string().min(1),
    targetBucket: z.enum(['artifacts', 'uploads']).optional(),
    targetPrefix: z.string().min(1).optional(),
    maxFiles: z.number().int().positive().optional(),
}).strict();

const githubRepoCheckoutSchema = z.object({
    sessionId: z.string().min(1),
    connectionId: z.string().uuid().optional(),
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repoFullName must be in "owner/repo" format.').optional(),
    targetDir: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    workBranch: z.string().min(1).optional(),
}).strict().refine(
    (value) => Boolean(value.connectionId || value.repoFullName),
    { message: 'Provide connectionId or repoFullName.' }
);

const githubRepoPublishSchema = z.object({
    sessionId: z.string().min(1),
    connectionId: z.string().uuid().optional(),
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repoFullName must be in "owner/repo" format.').optional(),
    repoPath: z.string().min(1),
    commitMessage: z.string().min(1),
    publishMode: z.enum(['pr', 'direct']).optional(),
    confirmDirectPush: z.boolean().optional(),
    baseBranch: z.string().min(1).optional(),
    workBranch: z.string().min(1).optional(),
    targetBranch: z.string().min(1).optional(),
    prTitle: z.string().min(1).optional(),
    prBody: z.string().optional(),
    draftPr: z.boolean().optional(),
}).strict().refine(
    (value) => Boolean(value.connectionId || value.repoFullName),
    { message: 'Provide connectionId or repoFullName.' }
);

const kaggleDatasetDownloadSchema = z.object({
    sessionId: z.string().min(1),
    dataset: z.string().min(1),
    targetDir: z.string().optional(),
    unzip: z.boolean().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
}).strict();

const kaggleDatasetUploadSchema = z.object({
    sessionId: z.string().min(1),
    sourceDir: z.string().min(1),
    datasetSlug: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'datasetSlug must be in owner/dataset format.'),
    title: z.string().min(1).optional(),
    private: z.boolean().optional(),
    message: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
}).strict();

const kaggleCompetitionSubmitSchema = z.object({
    sessionId: z.string().min(1),
    competition: z.string().min(1),
    filePath: z.string().min(1),
    message: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
}).strict();

const kaggleKernelPushSchema = z.object({
    sessionId: z.string().min(1),
    sourceDir: z.string().min(1),
    kernelSlug: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'kernelSlug must be in owner/kernel format.'),
    title: z.string().min(1).optional(),
    competition: z.string().min(1).optional(),
    enableGpu: z.boolean().optional(),
    enableInternet: z.boolean().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
}).strict();

const sandboxBrowserSchema = z.object({
    sessionId: z.string().min(1),
    url: z.string().url(),
    action: z.enum(['screenshot', 'html', 'text']).optional(),
    selector: z.string().optional(),
    waitMs: z.number().int().nonnegative().optional(),
    viewport: jsonOrRecord(z.number()),
}).strict();

function normalizeDesktopActionName(action: string): string {
    const raw = String(action || '').trim();
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
    const alias: Record<string, string> = {
        press_keys: 'press',
        press_key: 'press',
        key_press: 'press',
        hotkey: 'press',
        type: 'write',
        type_text: 'write',
        input_text: 'write',
        open_url: 'open',
        navigate: 'open',
        goto: 'open',
        launch_app: 'launch',
        launch_application: 'launch',
        launch_browser: 'launch',
        move: 'move_mouse',
        move_cursor: 'move_mouse',
        leftclick: 'left_click',
        left_click: 'left_click',
    };
    return alias[normalized] ?? normalized;
}

const desktopActionItemSchema = z
    .object({
        action: z.string().min(1),
        params: z.preprocess((val) => {
            if (typeof val === 'string') {
                try { return JSON.parse(val); } catch { return val; }
            }
            return val;
        }, z.record(z.string(), z.unknown()).optional()),
    })
    .passthrough()
    .transform((raw) => {
        const { action, params, ...rest } = raw;
        const mergedParams: Record<string, unknown> = { ...rest, ...(params ?? {}) };
        const normalizedAction = normalizeDesktopActionName(action);

        // Common convenience aliases: allow url at top-level/params.
        if (normalizedAction === 'open') {
            if (mergedParams.target == null && mergedParams.file_or_url == null && mergedParams.url != null) {
                mergedParams.target = mergedParams.url;
            }
        }
        if (normalizedAction === 'launch') {
            if (mergedParams.uri == null && mergedParams.url != null) {
                mergedParams.uri = mergedParams.url;
            }
            // If model used `launch_browser` alias without specifying an application, pick a sensible default.
            const rawName = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (rawName === 'launch_browser' && mergedParams.application == null && mergedParams.app == null) {
                mergedParams.application = 'google-chrome';
            }
        }

        return {
            action: normalizedAction,
            params: Object.keys(mergedParams).length > 0 ? mergedParams : undefined,
        };
    });

const desktopStartSchema = z.object({
    resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    dpi: z.number().int().positive().optional(),
    display: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    env: jsonOrRecord(z.string()),
    startupActions: z.array(desktopActionItemSchema).min(1).optional(),
}).strict();

const desktopActionSchema = z.object({
    sessionId: z.string().min(1),
    actions: z.array(desktopActionItemSchema).min(1),
}).strict();

const desktopScreenshotSchema = z.object({
    sessionId: z.string().min(1),
    copyToStorage: z.boolean().optional(),
}).strict();

const desktopStopSchema = z.object({
    sessionId: z.string().min(1),
}).strict();

const desktopStreamStartSchema = z.object({
    sessionId: z.string().min(1),
    windowId: z.string().optional(),
    requireAuth: z.boolean().optional(),
}).strict();

const desktopStreamStopSchema = z.object({
    sessionId: z.string().min(1),
}).strict();

export const trainingSubmitTool: Tool = {
    category: 'data',
    definition: {
        name: 'training_submit',
        description:
            'Submit a long-running training job (input + Python script). Returns a taskId; poll with `training_status` and fetch outputs with `training_download`.\n\nArgs:\n- input: InputRef (required)\n- script: InputRef (required; treated as a .py file)\n- extraInputs?: InputRef[] (optional)\n- hfModels?: HfPrefetchRef[] (optional)\n- hfDatasets?: HfPrefetchRef[] (optional)\n- github?: GithubPrefetchRef[] (optional)\n- kaggleDatasets?: KaggleDatasetPrefetchRef[] (optional)\n- backend?: "e2b" | "sagemaker" (optional; defaults to "sagemaker" when AWS SageMaker is configured, otherwise "e2b")\n- sagemaker?: SageMakerExecutionRef (optional metadata/contract fields)\n- wandb?: WandbTrackingRef (optional tracking metadata; auto-enabled when WANDB_API_KEY is set)\n- expectedOutputName?: string (optional, default "model.pkl")\n- timeoutSeconds?: number (optional)\n\nInputRef shape:\n{ name?: string, url?: string, storagePath?: string, bucket?: "uploads"|"artifacts", text?: string, base64?: string, mimeType?: string }\nEach InputRef must include at least one of: url | storagePath | text | base64.\n\nInputRef usage guide:\n- "text": Use for inline content (scripts you write, small CSV data). The system auto-uploads to storage. PREFERRED for agent-generated scripts.\n- "url": Use for publicly accessible download links (e.g. raw GitHub URLs, direct file links).\n- "storagePath": ONLY for files the user already uploaded in this chat session. The path MUST start with "{userId}/{chatId}/". Do NOT guess storage paths.\n- "base64": Use for binary content encoded as base64.\n- For Hugging Face datasets, prefer using the "hfDatasets" field instead of downloading and passing as input.\n\nHfPrefetchRef shape:\n{ repo: string, revision?: string, allowPatterns?: string[], ignorePatterns?: string[] }\n\nGithubPrefetchRef shape:\n{ repo: "owner/repo", ref?: string, subdir?: string, includePaths?: string[], excludePaths?: string[] }\n\nKaggleDatasetPrefetchRef shape:\n{ dataset: "owner/dataset", targetDir?: string, unzip?: boolean }\n\nSageMakerExecutionRef shape:\n{ trainingJobName?: string, executionRoleArn?: string, imageUri?: string, instanceType?: string, instanceCount?: number, volumeSizeGb?: number, maxRuntimeSeconds?: number, outputS3Uri?: string, hyperparameters?: Record<string, string> }\n\nWandbTrackingRef shape:\n{ project?: string, entity?: string, runName?: string, tags?: string[], notes?: string, mode?: "online"|"offline"|"disabled", config?: Record<string, unknown> }\n\nMinimal example:\n{ "input": { "name": "input.csv", "text": "x,y\\n1,2\\n" }, "script": { "name": "train.py", "text": "print(\\"hello\\")\\n" }, "backend": "sagemaker", "sagemaker": { "instanceType": "ml.g5.2xlarge" }, "wandb": { "project": "tuna", "tags": ["hackathon"] }, "hfModels": [{ "repo": "mistralai/Mistral-7B-Instruct-v0.3" }], "expectedOutputName": "model.pkl", "timeoutSeconds": 600 }',
        parameters: {
            type: 'object',
            properties: {
                input: inputRefToolSchema,
                script: inputRefToolSchema,
                extraInputs: {
                    type: 'array',
                    description: 'Optional additional files (each is an InputRef). For these, set `name` explicitly.',
                    items: {
                        ...inputRefToolSchema,
                        required: ['name'],
                    },
                },
                hfModels: {
                    type: 'array',
                    description: 'Optional Hugging Face model repos to prefetch inside the sandbox before script execution.',
                    items: hfPrefetchToolSchema,
                },
                hfDatasets: {
                    type: 'array',
                    description: 'Optional Hugging Face dataset repos to prefetch inside the sandbox before script execution.',
                    items: hfPrefetchToolSchema,
                },
                github: {
                    type: 'array',
                    description: 'Optional GitHub repositories to prefetch inside the sandbox before script execution.',
                    items: githubPrefetchToolSchema,
                },
                kaggleDatasets: {
                    type: 'array',
                    description: 'Optional Kaggle datasets to prefetch inside the sandbox before script execution.',
                    items: kaggleDatasetPrefetchToolSchema,
                },
                backend: {
                    type: 'string',
                    enum: ['e2b', 'sagemaker'],
                    description: 'Requested training backend. Defaults to `sagemaker` when AWS SageMaker is configured, otherwise `e2b`. `sagemaker` fields are accepted as metadata/contract even when execution falls back to runner defaults.',
                },
                sagemaker: sageMakerExecutionToolSchema,
                wandb: wandbTrackingToolSchema,
                expectedOutputName: { type: 'string' },
                timeoutSeconds: { type: 'number' },
            },
            required: ['input', 'script'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = trainingSubmitSchema.safeParse(args);
        if (!parsed.success) {
            const hint = `Expected args like: {"input":{"name":"input.csv","text":"x,y\\n1,2\\n"},"script":{"name":"train.py","text":"print(\\"hello\\")\\n"},"expectedOutputName":"model.pkl","timeoutSeconds":600}`;
            return { ok: false, error: { message: `${parsed.error.message}\n${hint}`, name: 'ValidationError' } };
        }
        try {
            const { userId, chatId } = requireContextIds(context);
            const trainingRate = getE2bTrainingCreditsPerMinute();
            if (trainingRate && isUuid(userId) && isUuid(chatId)) {
                try {
                    const supabase = await createClient();
                    const authed = (await supabase.auth.getUser()).data.user;
                    if (authed?.id === userId) {
                        const { data: summaryRaw, error: summaryErr } = await supabase.rpc('get_credit_summary');
                        if (!summaryErr) {
                            const total = parseCreditSummaryTotal(summaryRaw);
                            if (typeof total === 'number' && total < trainingRate) {
                                return {
                                    ok: false,
                                    error: { message: 'Insufficient credits to start a training job.', name: 'InsufficientCredits' },
                                };
                            }
                        }
                    }
                } catch {
                    // Best-effort credit check only.
                }
            }
            const resolvedInput = await resolveInputRef(parsed.data.input, context, 'input.csv');
            const resolvedScript = await resolveInputRef(parsed.data.script, context, 'train.py', { requirePy: true });
            const extras = await Promise.all(
                (parsed.data.extraInputs ?? []).map(async (extra) => {
                    const resolved = await resolveInputRef(extra, context, safeFileName(extra.name, 'extra'));
                    return { name: safeFileName(extra.name, resolved.name), url: resolved.url };
                })
            );
            const hfModels = (parsed.data.hfModels ?? []).map((item: HfPrefetchRef) => ({
                repo: item.repo,
                revision: item.revision,
                allow_patterns: item.allowPatterns && item.allowPatterns.length > 0 ? item.allowPatterns : undefined,
                ignore_patterns: item.ignorePatterns && item.ignorePatterns.length > 0 ? item.ignorePatterns : undefined,
            }));
            const hfDatasets = (parsed.data.hfDatasets ?? []).map((item: HfPrefetchRef) => ({
                repo: item.repo,
                revision: item.revision,
                allow_patterns: item.allowPatterns && item.allowPatterns.length > 0 ? item.allowPatterns : undefined,
                ignore_patterns: item.ignorePatterns && item.ignorePatterns.length > 0 ? item.ignorePatterns : undefined,
            }));
            const githubRepos = (parsed.data.github ?? []).map((item: GithubPrefetchRef) => ({
                repo: item.repo,
                ref: item.ref,
                subdir: item.subdir,
                include_paths: item.includePaths && item.includePaths.length > 0 ? item.includePaths : undefined,
                exclude_paths: item.excludePaths && item.excludePaths.length > 0 ? item.excludePaths : undefined,
            }));
            const kaggleDatasets = (parsed.data.kaggleDatasets ?? []).map((item: KaggleDatasetPrefetchRef) => ({
                dataset: item.dataset,
                target_dir: item.targetDir,
                unzip: item.unzip ?? true,
            }));
            const requestedBackend: TrainingBackend = parsed.data.backend
                ?? ((process.env.SAGEMAKER_EXECUTION_ROLE_ARN || '').trim() ? 'sagemaker' : 'e2b');
            const sagemakerInput: SageMakerExecutionRef | undefined = parsed.data.sagemaker;
            const wandbInput: WandbTrackingRef | undefined = parsed.data.wandb
                ?? ((() => {
                    const hasKey = (process.env.WANDB_API_KEY || '').trim();
                    if (!hasKey) return undefined;
                    return {
                        project: (process.env.WANDB_PROJECT || '').trim() || 'tuna',
                        entity: (process.env.WANDB_ENTITY || '').trim() || undefined,
                        mode: 'online' as const,
                    };
                })());
            const sagemaker = sagemakerInput
                ? {
                    training_job_name: sagemakerInput.trainingJobName,
                    execution_role_arn: sagemakerInput.executionRoleArn,
                    image_uri: sagemakerInput.imageUri,
                    instance_type: sagemakerInput.instanceType,
                    instance_count: sagemakerInput.instanceCount,
                    volume_size_gb: sagemakerInput.volumeSizeGb,
                    max_runtime_seconds: sagemakerInput.maxRuntimeSeconds,
                    output_s3_uri: sagemakerInput.outputS3Uri,
                    hyperparameters: sagemakerInput.hyperparameters
                        ? Object.fromEntries(
                            Object.entries(sagemakerInput.hyperparameters).map(([key, value]) => [key, String(value)])
                        )
                        : undefined,
                }
                : undefined;
            const wandb = wandbInput
                ? {
                    project: wandbInput.project,
                    entity: wandbInput.entity,
                    run_name: wandbInput.runName,
                    tags: wandbInput.tags,
                    notes: wandbInput.notes,
                    mode: wandbInput.mode,
                    config: wandbInput.config,
                }
                : undefined;
            const needsHfToken = hfModels.length > 0 || hfDatasets.length > 0;
            const needsGithubToken = githubRepos.length > 0;
            const needsKaggleToken = kaggleDatasets.length > 0;
            const [hfToken, githubToken, kaggleToken] = await Promise.all([
                needsHfToken
                    ? resolveUserIntegrationToken(userId, 'huggingface', ['HUGGINGFACE_TOKEN', 'HF_TOKEN'])
                    : Promise.resolve(undefined),
                needsGithubToken
                    ? resolveUserIntegrationToken(userId, 'github', GITHUB_TOKEN_ENV_NAMES)
                    : Promise.resolve(undefined),
                needsKaggleToken
                    ? resolveUserIntegrationToken(userId, 'kaggle', ['KAGGLE_TOKEN'])
                    : Promise.resolve(undefined),
            ]);
            const payload = {
                input_url: resolvedInput.url,
                script_url: resolvedScript.url,
                input_name: resolvedInput.name,
                extra_inputs: extras.length > 0 ? extras : undefined,
                hf_models: hfModels.length > 0 ? hfModels : undefined,
                hf_datasets: hfDatasets.length > 0 ? hfDatasets : undefined,
                github_repos: githubRepos.length > 0 ? githubRepos : undefined,
                kaggle_datasets: kaggleDatasets.length > 0 ? kaggleDatasets : undefined,
                hf_token: hfToken,
                github_token: githubToken,
                kaggle_token: kaggleToken,
                backend: requestedBackend,
                sagemaker,
                wandb,
                expected_output_name: parsed.data.expectedOutputName ?? 'model.pkl',
                timeout_seconds: parsed.data.timeoutSeconds,
            };
            const result = await runnerFetchJson<{ task_id: string }>('/tasks/by-reference', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            if (!result.ok || !result.data?.task_id) {
                return { ok: false, error: { message: result.errorText || 'Runner submission failed', name: 'RunnerError' } };
            }
            const now = new Date().toISOString();
            const taskId = result.data.task_id;

            if (isUuid(taskId) && isUuid(userId) && isUuid(chatId)) {
                try {
                    const admin = createAdminClient();
                    await admin.from('e2b_training_task_meters').upsert({
                        task_id: taskId,
                        user_id: userId,
                        chat_id: chatId,
                        submitted_at: now,
                        status: 'pending',
                        billed: false,
                        billed_credits: 0,
                        metadata: {
                            kind: 'e2b_training_v1',
                            requested_backend: requestedBackend,
                            expected_output_name: payload.expected_output_name,
                            timeout_seconds: payload.timeout_seconds ?? null,
                            hf_prefetch_count: hfModels.length + hfDatasets.length,
                            github_prefetch_count: githubRepos.length,
                            kaggle_prefetch_count: kaggleDatasets.length,
                            wandb_project: parsed.data.wandb?.project ?? null,
                        },
                    });
                } catch {
                    // Best-effort only; missing table should not break training.
                }
            }

            const artifactPayload = {
                kind: 'e2b_training_v1',
                taskId,
                status: 'pending',
                inputName: resolvedInput.name,
                scriptName: resolvedScript.name,
                expectedOutputName: payload.expected_output_name,
                hfPrefetchCount: hfModels.length + hfDatasets.length,
                githubPrefetchCount: githubRepos.length,
                kagglePrefetchCount: kaggleDatasets.length,
                requestedBackend,
                wandb: parsed.data.wandb ?? undefined,
                sagemaker: parsed.data.sagemaker ?? undefined,
                submittedAt: now,
            };
            return {
                ok: true,
                data: artifactPayload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'training',
                            type: 'markdown',
                            title: 'Training',
                            content: artifactPayload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'training' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'RunnerError' } };
        }
    },
};

export const trainingStatusTool: Tool = {
    category: 'data',
    definition: {
        name: 'training_status',
        description: 'Poll the current status (pending/running/completed/failed) and truncated stdout/stderr for a training taskId.',
        parameters: {
            type: 'object',
            properties: {
                taskId: { type: 'string' },
            },
            required: ['taskId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = trainingStatusSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(`/tasks/${parsed.data.taskId}/status`, { method: 'GET' });
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Failed to fetch status', name: 'RunnerError' } };
            }
            const statusData = result.data;
            const statusValue = typeof statusData.status === 'string' ? statusData.status : '';
            const taskId = parsed.data.taskId;
            const nowIsoStr = new Date().toISOString();

            const trainingRate = getE2bTrainingCreditsPerMinute();
            const { userId, chatId } = requireContextIds(context);

            if (
                trainingRate &&
                isUuid(taskId) &&
                isUuid(userId) &&
                isUuid(chatId) &&
                (statusValue === 'completed' || statusValue === 'failed')
            ) {
                try {
                    const admin = createAdminClient();
                    const { data: meter, error: meterErr } = await admin
                        .from('e2b_training_task_meters')
                        .select('billed, billed_credits, metadata')
                        .eq('task_id', taskId)
                        .maybeSingle();

                    const alreadyBilled = Boolean((meter as { billed?: unknown } | null)?.billed);
                    if (!meterErr && !alreadyBilled) {
                        const prevBilledRaw = (meter as { billed_credits?: unknown } | null)?.billed_credits;
                        const prevBilledCredits =
                            typeof prevBilledRaw === 'number' && Number.isFinite(prevBilledRaw)
                                ? Math.max(0, Math.floor(prevBilledRaw))
                                : typeof prevBilledRaw === 'string' && prevBilledRaw.trim()
                                    ? Math.max(0, Number.parseInt(prevBilledRaw, 10) || 0)
                                    : 0;
                        const createdAtRaw = typeof statusData.created_at === 'string' ? statusData.created_at : '';
                        const updatedAtRaw = typeof statusData.updated_at === 'string' ? statusData.updated_at : '';
                        const createdAt = new Date(createdAtRaw);
                        const updatedAt = new Date(updatedAtRaw);
                        const runtimeMs =
                            Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())
                                ? null
                                : Math.max(0, updatedAt.getTime() - createdAt.getTime());
                        const runtimeMinutes = runtimeMs === null ? 1 : Math.max(1, Math.ceil(runtimeMs / 60_000));
                        const creditsToChargeTotal = runtimeMinutes * trainingRate;
                        const remainingToCharge = Math.max(0, creditsToChargeTotal - prevBilledCredits);

                        const userSupabase = await createClient();
                        const authed = (await userSupabase.auth.getUser()).data.user;
                        if (authed?.id === userId) {
                            if (remainingToCharge <= 0) {
                                await admin.from('e2b_training_task_meters').upsert({
                                    task_id: taskId,
                                    user_id: userId,
                                    chat_id: chatId,
                                    status: statusValue,
                                    billed: true,
                                    billed_credits: prevBilledCredits,
                                    billed_at: nowIsoStr,
                                    metadata: {
                                        ...(((meter as { metadata?: unknown } | null)?.metadata ?? {}) as Record<string, unknown>),
                                        runtime_ms: runtimeMs,
                                        runtime_minutes: runtimeMinutes,
                                        credits_per_minute: trainingRate,
                                        credits_target_total: creditsToChargeTotal,
                                    },
                                });
                            } else {
                                let availableCredits: number | null = null;
                                try {
                                    const { data: summaryRaw, error: summaryErr } = await userSupabase.rpc('get_credit_summary');
                                    if (!summaryErr) {
                                        availableCredits = parseCreditSummaryTotal(summaryRaw);
                                    }
                                } catch {
                                    availableCredits = null;
                                }

                                const chargeNowRaw =
                                    typeof availableCredits === 'number'
                                        ? Math.min(remainingToCharge, Math.max(0, availableCredits))
                                        : remainingToCharge;
                                const chargeNow = Math.max(0, Math.floor(chargeNowRaw));

                                if (chargeNow <= 0) {
                                    await admin.from('e2b_training_task_meters').upsert({
                                        task_id: taskId,
                                        user_id: userId,
                                        chat_id: chatId,
                                        status: statusValue,
                                        billed: false,
                                        billed_credits: prevBilledCredits,
                                        billed_at: nowIsoStr,
                                        metadata: {
                                            ...(((meter as { metadata?: unknown } | null)?.metadata ?? {}) as Record<string, unknown>),
                                            runtime_ms: runtimeMs,
                                            runtime_minutes: runtimeMinutes,
                                            credits_per_minute: trainingRate,
                                            credits_target_total: creditsToChargeTotal,
                                            billing_error: 'insufficient_credits',
                                            billing_error_at: nowIsoStr,
                                            billing_available_credits: availableCredits,
                                            billing_remaining_target_credits: remainingToCharge,
                                        },
                                    });
                                } else {
                                    const { error: chargeErr } = await userSupabase.rpc('consume_credits', {
                                        p_run_id: null,
                                        p_amount: chargeNow,
                                        p_metadata: {
                                            chat_id: chatId,
                                            source: 'e2b_training',
                                            provider: 'e2b',
                                            model: 'training',
                                            e2b_task_id: taskId,
                                            status: statusValue,
                                            created_at: createdAtRaw || null,
                                            updated_at: updatedAtRaw || null,
                                            runtime_ms: runtimeMs,
                                            runtime_minutes: runtimeMinutes,
                                            credits_per_minute: trainingRate,
                                            charged_credits: chargeNow,
                                            requested_charge_credits: remainingToCharge,
                                            credits_target_total: creditsToChargeTotal,
                                            credits_previously_billed: prevBilledCredits,
                                            credits_remaining_after_charge: Math.max(
                                                0,
                                                creditsToChargeTotal - (prevBilledCredits + chargeNow)
                                            ),
                                            billed_at: nowIsoStr,
                                        },
                                    });

                                    if (!chargeErr) {
                                        const newBilledCredits = prevBilledCredits + chargeNow;
                                        const fullyBilled = newBilledCredits >= creditsToChargeTotal;
                                        await admin.from('e2b_training_task_meters').upsert({
                                            task_id: taskId,
                                            user_id: userId,
                                            chat_id: chatId,
                                            status: statusValue,
                                            billed: fullyBilled,
                                            billed_credits: newBilledCredits,
                                            billed_at: nowIsoStr,
                                            metadata: {
                                                ...(((meter as { metadata?: unknown } | null)?.metadata ?? {}) as Record<
                                                    string,
                                                    unknown
                                                >),
                                                runtime_ms: runtimeMs,
                                                runtime_minutes: runtimeMinutes,
                                                credits_per_minute: trainingRate,
                                                credits_target_total: creditsToChargeTotal,
                                                billing_available_credits: availableCredits,
                                                billing_remaining_target_credits: Math.max(0, creditsToChargeTotal - newBilledCredits),
                                                billing_partially_billed: !fullyBilled,
                                            },
                                        });
                                    } else if (isInsufficientCreditsError(chargeErr)) {
                                        // Record best-effort note so ops can detect partial/unbilled completions.
                                        await admin.from('e2b_training_task_meters').upsert({
                                            task_id: taskId,
                                            user_id: userId,
                                            chat_id: chatId,
                                            status: statusValue,
                                            billed: false,
                                            billed_credits: prevBilledCredits,
                                            billed_at: nowIsoStr,
                                            metadata: {
                                                ...(((meter as { metadata?: unknown } | null)?.metadata ?? {}) as Record<
                                                    string,
                                                    unknown
                                                >),
                                                runtime_ms: runtimeMs,
                                                runtime_minutes: runtimeMinutes,
                                                credits_per_minute: trainingRate,
                                                credits_target_total: creditsToChargeTotal,
                                                billing_error: 'insufficient_credits',
                                                billing_error_at: nowIsoStr,
                                                billing_available_credits: availableCredits,
                                                billing_remaining_target_credits: remainingToCharge,
                                            },
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch {
                    // Best-effort billing only; never block status polling.
                }
            }

            let wandbProject: string | undefined;
            let wandbRunUrl: string | undefined;
            if (statusValue === 'completed' || statusValue === 'failed') {
                try {
                    const metaResp = await runnerFetchJson<Record<string, unknown>>(
                        `/tasks/${taskId}/download?file=metadata`,
                        { method: 'GET' }
                    );
                    if (metaResp.ok && metaResp.data) {
                        const wandbMeta = metaResp.data.wandb;
                        if (wandbMeta && typeof wandbMeta === 'object') {
                            const wandbRecord = wandbMeta as Record<string, unknown>;
                            if (typeof wandbRecord.project === 'string') {
                                wandbProject = wandbRecord.project;
                            }
                            const runUrlCandidate = wandbRecord.run_url ?? wandbRecord.runUrl;
                            if (typeof runUrlCandidate === 'string') {
                                wandbRunUrl = runUrlCandidate;
                            }
                        }
                    }
                } catch {
                    // Best-effort metadata fetch only.
                }
            }

            const artifactPayload = {
                kind: 'e2b_training_v1',
                taskId,
                status: statusData.status,
                updatedAt: nowIsoStr,
                stdout: typeof statusData.stdout === 'string' ? clip(statusData.stdout) : undefined,
                stderr: typeof statusData.stderr === 'string' ? clip(statusData.stderr) : undefined,
                error: statusData.error_message,
                outputModelKey: statusData.output_model_key,
                runLogKey: statusData.run_log_key,
                requestedBackend:
                    typeof statusData.requested_backend === 'string' ? statusData.requested_backend : undefined,
                executionBackend:
                    typeof statusData.execution_backend === 'string' ? statusData.execution_backend : undefined,
                backendJobId:
                    typeof statusData.backend_job_id === 'string' ? statusData.backend_job_id : undefined,
                backendStatus:
                    typeof statusData.backend_status === 'string' ? statusData.backend_status : undefined,
                wandbProject,
                wandbRunUrl,
            };
            return {
                ok: true,
                data: artifactPayload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'training',
                            type: 'markdown',
                            title: 'Training',
                            content: artifactPayload,
                            status: statusData.status === 'completed' ? 'final' : 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'training' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const trainingDownloadTool: Tool = {
    category: 'data',
    definition: {
        name: 'training_download',
        description: 'Download training outputs (model/log/metadata) for a taskId and return a download URL. Use after `training_status` reports completion.',
        parameters: {
            type: 'object',
            properties: {
                taskId: { type: 'string' },
                file: { type: 'string', enum: ['model', 'log', 'metadata'] },
                copyToStorage: { type: 'boolean' },
            },
            required: ['taskId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = trainingDownloadSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const { chatId } = requireContextIds(context);
            const file = parsed.data.file;
            const proxyUrl = buildRunnerProxyUrl(chatId, parsed.data.taskId, file);
            const copyToStorage = parsed.data.copyToStorage ?? true;

            if (file === 'model') {
                if (!copyToStorage) {
                    return {
                        ok: true,
                        data: { taskId: parsed.data.taskId, downloadUrl: proxyUrl },
                        sideEffects: [
                            {
                                type: 'ui.upsertArtifact',
                                payload: {
                                    id: 'training',
                                    type: 'markdown',
                                    title: 'Training',
                                    content: { kind: 'e2b_training_v1', taskId: parsed.data.taskId, downloadUrl: proxyUrl },
                                    status: 'final',
                                    isCollaborative: false,
                                },
                            },
                            { type: 'ui.openArtifact', payload: { id: 'training' } },
                        ],
                    };
                }
                const { baseUrl, token, timeoutMs } = getRunnerConfig();
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const resp = await fetch(`${baseUrl}/tasks/${parsed.data.taskId}/download?file=model`, {
                        headers: buildRunnerHeaders(token),
                        signal: controller.signal,
                    });
                    if (!resp.ok) {
                        const errText = await resp.text().catch(() => '');
                        return { ok: false, error: { message: errText || 'Model download failed', name: 'RunnerError' } };
                    }
                    const expectedName = await resolveTrainingExpectedOutputName(chatId, parsed.data.taskId);
                    const headerName = parseContentDispositionFilename(resp.headers.get('content-disposition'));
                    const fallbackName = safeFileName(expectedName || 'model.bin', 'model.bin');
                    const fileName = safeFileName(headerName || fallbackName, fallbackName);
                    const storagePath = `runner-outputs/${chatId}/${parsed.data.taskId}/${fileName}`;
                    if (!resp.body) {
                        return { ok: false, error: { message: 'Model download stream unavailable', name: 'RunnerError' } };
                    }
                    await uploadStorageObjectStream('artifacts', storagePath, resp.body, {
                        contentType: resp.headers.get('content-type') || 'application/octet-stream',
                    });
                    const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 600);
                    return {
                        ok: true,
                        data: {
                            taskId: parsed.data.taskId,
                            downloadUrl: signedUrl,
                            modelStoragePath: storagePath,
                            modelFileName: fileName,
                        },
                        sideEffects: [
                            {
                                type: 'ui.upsertArtifact',
                                payload: {
                                    id: 'training',
                                    type: 'markdown',
                                    title: 'Training',
                                    content: {
                                        kind: 'e2b_training_v1',
                                        taskId: parsed.data.taskId,
                                        downloadUrl: signedUrl,
                                        modelStoragePath: storagePath,
                                        modelFileName: fileName,
                                    },
                                    status: 'final',
                                    isCollaborative: false,
                                },
                            },
                            { type: 'ui.openArtifact', payload: { id: 'training' } },
                        ],
                    };
                } finally {
                    clearTimeout(timeout);
                }
            }

            if (file === 'log') {
                const result = await runnerFetchBinary(`/tasks/${parsed.data.taskId}/download?file=log`);
                if (!result.ok || !result.body) {
                    return { ok: false, error: { message: result.errorText || 'Log download failed', name: 'RunnerError' } };
                }
                const storagePath = `runner-outputs/${chatId}/${parsed.data.taskId}/run.log`;
                await uploadStorageObject('artifacts', storagePath, Buffer.from(result.body), { contentType: 'text/plain' });
                const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 600);
                const logSnippet = clip(Buffer.from(result.body).toString('utf-8'));
                return {
                    ok: true,
                    data: { taskId: parsed.data.taskId, logUrl: signedUrl, logStoragePath: storagePath },
                    sideEffects: [
                        {
                            type: 'ui.upsertArtifact',
                            payload: {
                                id: 'training',
                                type: 'markdown',
                                title: 'Training',
                                content: {
                                    kind: 'e2b_training_v1',
                                    taskId: parsed.data.taskId,
                                    logUrl: signedUrl,
                                    logSnippet,
                                    logStoragePath: storagePath,
                                },
                                status: 'executing',
                                isCollaborative: false,
                            },
                        },
                        { type: 'ui.openArtifact', payload: { id: 'training' } },
                    ],
                };
            }

            const meta = await runnerFetchJson<Record<string, unknown>>(`/tasks/${parsed.data.taskId}/download?file=metadata`, { method: 'GET' });
            if (!meta.ok || !meta.data) {
                return { ok: false, error: { message: meta.errorText || 'Metadata download failed', name: 'RunnerError' } };
            }
            const metaBuffer = Buffer.from(JSON.stringify(meta.data, null, 2), 'utf-8');
            const metaPath = `runner-outputs/${chatId}/${parsed.data.taskId}/metadata.json`;
            await uploadStorageObject('artifacts', metaPath, metaBuffer, { contentType: 'application/json' });
            const metaUrl = await createStorageSignedUrl('artifacts', metaPath, 600);
            return {
                ok: true,
                data: { taskId: parsed.data.taskId, metadataUrl: metaUrl, metadataStoragePath: metaPath },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'training',
                            type: 'markdown',
                            title: 'Training',
                            content: {
                                kind: 'e2b_training_v1',
                                taskId: parsed.data.taskId,
                                metadata: meta.data,
                                metadataUrl: metaUrl,
                                metadataStoragePath: metaPath,
                            },
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'training' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxStartTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_start',
        description: 'Start an interactive sandbox session for command execution and file I/O. Returns a sessionId used by sandbox_exec/upload/download/browser.',
        parameters: {
            type: 'object',
            properties: { workdir: { type: 'string' } },
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxStartSchema.safeParse(args ?? {});
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        let requestedWorkdir: string | undefined;
        try {
            requestedWorkdir = normalizeSandboxWorkdir(parsed.data.workdir);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        try {
            const { userId, chatId } = requireContextIds(context);
            const sessionRate = getE2bSessionCreditsPerMinute();
            let sessionBillingAllowed = Boolean(sessionRate && isUuid(userId) && isUuid(chatId));
            let userSupabase: Awaited<ReturnType<typeof createClient>> | null = null;
            if (sessionBillingAllowed) {
                try {
                    userSupabase = await createClient();
                    const authed = (await userSupabase.auth.getUser()).data.user;
                    if (!authed || authed.id !== userId) {
                        sessionBillingAllowed = false;
                        userSupabase = null;
                    }
                } catch {
                    sessionBillingAllowed = false;
                    userSupabase = null;
                }
            }
            if (sessionBillingAllowed && userSupabase && sessionRate) {
                try {
                    const { data: summaryRaw, error: summaryErr } = await userSupabase.rpc('get_credit_summary');
                    if (!summaryErr) {
                        const total = parseCreditSummaryTotal(summaryRaw);
                        if (typeof total === 'number' && total < sessionRate) {
                            return {
                                ok: false,
                                error: { message: 'Insufficient credits to start a sandbox session.', name: 'InsufficientCredits' },
                            };
                        }
                    }
                } catch {
                    // Best-effort check only.
                }
            }

            const result = await runnerFetchJson<{ session_id: string; workdir: string }>('/sessions', {
                method: 'POST',
                body: JSON.stringify({ workdir: requestedWorkdir }),
            });
            if (!result.ok || !result.data?.session_id) {
                return { ok: false, error: { message: result.errorText || 'Failed to start session', name: 'RunnerError' } };
            }
            const base = await loadSandboxState(context);
            const effectiveWorkdir = result.data.workdir || requestedWorkdir || '/code';
            const startedAt = nowIso();

            if (sessionBillingAllowed && userSupabase && sessionRate && isUuid(result.data.session_id)) {
                const sessionId = result.data.session_id;
                let billedMinutes = 0;
                try {
                    const chargeCredits = sessionRate;
                    const { error: chargeErr } = await userSupabase.rpc('consume_credits', {
                        p_run_id: null,
                        p_amount: chargeCredits,
                        p_metadata: {
                            chat_id: chatId,
                            source: 'e2b_sandbox',
                            provider: 'e2b',
                            model: 'sandbox',
                            e2b_session_id: sessionId,
                            started_at: startedAt,
                            billed_minutes_delta: 1,
                            billed_minutes_total: 1,
                            credits_per_minute: sessionRate,
                            charged_credits: chargeCredits,
                            billed_at: startedAt,
                            reason: 'session_start',
                        },
                    });
                    if (!chargeErr) {
                        billedMinutes = 1;
                    } else if (isInsufficientCreditsError(chargeErr)) {
                        // Session was created, but the user can't afford it; let TTL cleanup handle it.
                        billedMinutes = 0;
                    }
                } catch {
                    billedMinutes = 0;
                }

                if (isUuid(userId) && isUuid(chatId)) {
                    try {
                        const admin = createAdminClient();
                        const billedThroughAt = addMinutesIso(startedAt, billedMinutes);
                        await admin.from('e2b_session_meters').upsert({
                            session_id: sessionId,
                            user_id: userId,
                            chat_id: chatId,
                            started_at: startedAt,
                            billed_minutes: billedMinutes,
                            billed_through_at: billedThroughAt ?? startedAt,
                        });
                    } catch {
                        // Best-effort only.
                    }
                }
            }

            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'session',
                label: 'Session ready',
                status: 'completed',
                startedAt,
                finishedAt: startedAt,
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'idle',
                sessionId: result.data.session_id,
                workdir: effectiveWorkdir,
                startedAt,
                updatedAt: startedAt,
                events: [...base.events, event],
                summary: {
                    headline: 'Sandbox ready',
                    detail: 'You can run commands, upload files, or open a browser task.',
                    nextAction: 'Run a command or upload input files.',
                },
            });
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxStopTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_stop',
        description: 'Close a sandbox session and release resources.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxStopSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(`/sessions/${parsed.data.sessionId}`, {
                method: 'DELETE',
            });
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Failed to stop sandbox session', name: 'RunnerError' } };
            }
            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'session',
                label: 'Session closed',
                status: 'cancelled',
                startedAt: now,
                finishedAt: now,
            };
            const shouldClear = base.sessionId === parsed.data.sessionId;
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: shouldClear ? 'cancelled' : base.status,
                sessionId: shouldClear ? undefined : base.sessionId,
                workdir: base.workdir,
                updatedAt: now,
                events: [...base.events, event],
                summary: {
                    headline: 'Sandbox closed',
                    detail: 'Session resources were released.',
                    nextAction: 'Start a new sandbox if you need more execution.',
                },
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxExecTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_exec',
        description: 'Run a shell command inside a sandbox session (returns stdout/stderr/exitCode). Use for reproducible execution and evidence.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                command: { type: 'string' },
                cwd: { type: 'string' },
                timeoutSeconds: { type: 'number' },
                env: { type: 'string', description: 'Optional environment variables as a JSON object string, e.g. {"KEY":"value"}.' },
            },
            required: ['sessionId', 'command'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxExecSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const blockedReason = findBlockedCommandReason(parsed.data.command);
        if (blockedReason) {
            return { ok: false, error: { message: blockedReason, name: 'PolicyError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
        let resolvedCwd: string | undefined;
        let resolvedCdTarget: string | undefined;
        try {
            resolvedCwd = parsed.data.cwd ? resolveSandboxPath(parsed.data.cwd, stateWorkdir) : undefined;
            const requestedCd = parseLeadingCd(parsed.data.command);
            const effectiveStartCwd = resolvedCwd ?? stateWorkdir;
            if (requestedCd) {
                resolvedCdTarget = resolveSandboxPath(requestedCd, effectiveStartCwd);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        try {
            const effectiveCwd = resolvedCwd ?? stateWorkdir;
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${sessionId}/exec`, {
                    method: 'POST',
                    body: JSON.stringify({
                        command: parsed.data.command,
                        cwd: effectiveCwd,
                        timeout_seconds: parsed.data.timeoutSeconds,
                        env: parsed.data.env,
                    }),
                }),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Sandbox exec failed', name: 'RunnerError' } };
            }
            const exitCode = typeof result.data.exit_code === 'number' ? result.data.exit_code : undefined;
            const timedOut = Boolean(result.data.timed_out);
            const success = exitCode === 0 && !timedOut;
            const startedAt = nowIso();
            const stdoutClip = typeof result.data.stdout === 'string' ? clipSandboxOutput(result.data.stdout) : null;
            const stderrClip = typeof result.data.stderr === 'string' ? clipSandboxOutput(result.data.stderr) : null;
            const eventMeta: Record<string, unknown> = {
                cwd: effectiveCwd,
                exitCode,
                timedOut,
            };
            if (stdoutClip) {
                eventMeta.stdoutChars = stdoutClip.originalChars;
                if (stdoutClip.truncated) eventMeta.stdoutTruncated = true;
            }
            if (stderrClip) {
                eventMeta.stderrChars = stderrClip.originalChars;
                if (stderrClip.truncated) eventMeta.stderrTruncated = true;
            }
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'exec',
                label: parsed.data.command,
                status: success ? 'completed' : 'failed',
                startedAt,
                finishedAt: nowIso(),
                durationMs: typeof result.data.duration_ms === 'number' ? result.data.duration_ms : undefined,
                stdout: stdoutClip ? stdoutClip.text : undefined,
                stderr: stderrClip ? stderrClip.text : undefined,
                meta: eventMeta,
            };
            const nextWorkdir = resolvedCdTarget && success ? resolvedCdTarget : effectiveCwd;
            const recoveryEvent = call.recovered ? {
                id: randomUUID(),
                kind: 'session',
                label: 'Session auto-recovered',
                status: 'completed' as const,
                startedAt,
                finishedAt: startedAt,
                meta: {
                    previousSessionId: parsed.data.sessionId,
                    recoveredSessionId: effectiveSessionId,
                },
            } : null;
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: success ? 'idle' : 'failed',
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? nextWorkdir,
                lastCommand: parsed.data.command,
                updatedAt: nowIso(),
                events: [...base.events, ...(recoveryEvent ? [recoveryEvent] : []), event],
                summary: success
                    ? {
                        headline: 'Command completed',
                        detail: parsed.data.command,
                        nextAction: 'Run another command or inspect outputs.',
                    }
                    : {
                        headline: 'Command failed',
                        detail: 'Check the error output for details.',
                        nextAction: 'Review stderr or retry with fixes.',
                    },
            });

            await billSandboxSessionIfNeeded(context, effectiveSessionId);

            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxCommandStartTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_command_start',
        description:
            'Run a command via the sandbox commands API (supports background execution + streaming output). `stream` defaults to true for live terminal output. Returns pid when background=true.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                command: { type: 'string' },
                cwd: { type: 'string' },
                timeoutSeconds: { type: 'number' },
                env: { type: 'string', description: 'Optional environment variables as a JSON object string, e.g. {"KEY":"value"}.' },
                background: { type: 'boolean' },
                stream: { type: 'boolean' },
            },
            required: ['sessionId', 'command'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxCommandStartSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const blockedReason = findBlockedCommandReason(parsed.data.command);
        if (blockedReason) {
            return { ok: false, error: { message: blockedReason, name: 'PolicyError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
        let resolvedCwd: string | undefined;
        let resolvedCdTarget: string | undefined;
        try {
            resolvedCwd = parsed.data.cwd ? resolveSandboxPath(parsed.data.cwd, stateWorkdir) : undefined;
            const requestedCd = parseLeadingCd(parsed.data.command);
            const effectiveStartCwd = resolvedCwd ?? stateWorkdir;
            if (requestedCd) {
                resolvedCdTarget = resolveSandboxPath(requestedCd, effectiveStartCwd);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        try {
            const effectiveCwd = resolvedCwd ?? stateWorkdir;
            const stream = parsed.data.stream ?? true;
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${sessionId}/commands`, {
                    method: 'POST',
                    body: JSON.stringify({
                        command: parsed.data.command,
                        cwd: effectiveCwd,
                        timeout_seconds: parsed.data.timeoutSeconds,
                        env: parsed.data.env,
                        background: parsed.data.background,
                        stream,
                    }),
                }),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Sandbox command failed', name: 'RunnerError' } };
            }

            const isBackground = Boolean(parsed.data.background);
            const startedAt = nowIso();
            const recoveryEvent = call.recovered ? {
                id: randomUUID(),
                kind: 'session',
                label: 'Session auto-recovered',
                status: 'completed' as const,
                startedAt,
                finishedAt: startedAt,
                meta: {
                    previousSessionId: parsed.data.sessionId,
                    recoveredSessionId: effectiveSessionId,
                },
            } : null;
            if (isBackground) {
                const pid = typeof result.data.pid === 'number' ? result.data.pid : undefined;
                if (!pid) {
                    return { ok: false, error: { message: 'Runner did not return a pid', name: 'RunnerError' } };
                }
                const event: SandboxEvent = {
                    id: `command-${pid}`,
                    kind: 'command',
                    label: parsed.data.command,
                    status: 'running',
                    startedAt,
                    meta: { pid, cwd: effectiveCwd, background: true, stream },
                };
                const payload = mergeSandboxState(base, {
                    kind: 'sandbox_state_v2',
                    status: 'running',
                    sessionId: effectiveSessionId,
                    workdir: call.recoveredWorkdir ?? stateWorkdir ?? effectiveCwd,
                    lastCommand: parsed.data.command,
                    updatedAt: nowIso(),
                    events: [...base.events, ...(recoveryEvent ? [recoveryEvent] : []), event],
                    summary: {
                        headline: 'Command started',
                        detail: parsed.data.command,
                        nextAction: 'Poll for output or send stdin.',
                    },
                });
                await billSandboxSessionIfNeeded(context, effectiveSessionId);
                return {
                    ok: true,
                    data: { ...payload, pid },
                    sideEffects: [
                        {
                            type: 'ui.upsertArtifact',
                            payload: {
                                id: 'sandbox',
                                type: 'markdown',
                                title: 'Sandbox',
                                content: payload,
                                status: 'executing',
                                isCollaborative: false,
                            },
                        },
                        { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                    ],
                };
            }

            const exitCode = typeof result.data.exit_code === 'number' ? result.data.exit_code : undefined;
            const timedOut = Boolean(result.data.timed_out);
            const success = exitCode === 0 && !timedOut;
            const stdoutClip = typeof result.data.stdout === 'string' ? clipSandboxOutput(result.data.stdout) : null;
            const stderrClip = typeof result.data.stderr === 'string' ? clipSandboxOutput(result.data.stderr) : null;
            const eventMeta: Record<string, unknown> = { cwd: effectiveCwd, exitCode, timedOut };
            if (stdoutClip) {
                eventMeta.stdoutChars = stdoutClip.originalChars;
                if (stdoutClip.truncated) eventMeta.stdoutTruncated = true;
            }
            if (stderrClip) {
                eventMeta.stderrChars = stderrClip.originalChars;
                if (stderrClip.truncated) eventMeta.stderrTruncated = true;
            }
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: parsed.data.command,
                status: success ? 'completed' : 'failed',
                startedAt,
                finishedAt: nowIso(),
                durationMs: typeof result.data.duration_ms === 'number' ? result.data.duration_ms : undefined,
                stdout: stdoutClip ? stdoutClip.text : undefined,
                stderr: stderrClip ? stderrClip.text : undefined,
                meta: eventMeta,
            };
            const nextWorkdir = resolvedCdTarget && success ? resolvedCdTarget : effectiveCwd;
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: success ? 'idle' : 'failed',
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? nextWorkdir,
                lastCommand: parsed.data.command,
                updatedAt: nowIso(),
                events: [...base.events, ...(recoveryEvent ? [recoveryEvent] : []), event],
                summary: success
                    ? {
                        headline: 'Command completed',
                        detail: parsed.data.command,
                        nextAction: 'Run another command or inspect outputs.',
                    }
                    : {
                        headline: 'Command failed',
                        detail: 'Check the error output for details.',
                        nextAction: 'Review stderr or retry with fixes.',
                    },
            });
            await billSandboxSessionIfNeeded(context, effectiveSessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxCommandStatusTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_command_status',
        description: 'Fetch status/output for a background command started via sandbox_command_start.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
            },
            required: ['sessionId', 'pid'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxCommandStatusSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/commands/${parsed.data.pid}`,
                { method: 'GET' }
            );
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Sandbox command status failed', name: 'RunnerError' } };
            }
            const statusRaw = typeof result.data.status === 'string' ? result.data.status : undefined;
            const exitCode = typeof result.data.exit_code === 'number' ? result.data.exit_code : undefined;
            const eventStatus =
                statusRaw === 'running'
                    ? 'running'
                    : statusRaw === 'cancelled'
                        ? 'cancelled'
                        : exitCode === 0
                            ? 'completed'
                            : 'failed';
            const startedAt = typeof result.data.started_at === 'string' ? result.data.started_at : nowIso();
            const finishedAt = typeof result.data.finished_at === 'string' ? result.data.finished_at : undefined;
            const stdoutClip = typeof result.data.stdout === 'string' ? clipSandboxOutput(result.data.stdout) : null;
            const stderrClip = typeof result.data.stderr === 'string' ? clipSandboxOutput(result.data.stderr) : null;
            const eventMeta: Record<string, unknown> = {
                pid: parsed.data.pid,
                cwd: result.data.cwd,
                exitCode,
                timedOut: Boolean(result.data.timed_out),
            };
            if (stdoutClip) {
                eventMeta.stdoutChars = stdoutClip.originalChars;
                if (stdoutClip.truncated) eventMeta.stdoutTruncated = true;
            }
            if (stderrClip) {
                eventMeta.stderrChars = stderrClip.originalChars;
                if (stderrClip.truncated) eventMeta.stderrTruncated = true;
            }
            const event: SandboxEvent = {
                id: `command-${parsed.data.pid}`,
                kind: 'command',
                label: typeof result.data.command === 'string' ? result.data.command : `command ${parsed.data.pid}`,
                status: eventStatus,
                startedAt,
                finishedAt,
                stdout: stdoutClip ? stdoutClip.text : undefined,
                stderr: stderrClip ? stderrClip.text : undefined,
                meta: eventMeta,
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: eventStatus === 'running' ? 'running' : eventStatus === 'failed' ? 'failed' : 'idle',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxCommandStdinTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_command_send',
        description: 'Send stdin to a running background command.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
                data: { type: 'string' },
            },
            required: ['sessionId', 'pid', 'data'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxCommandStdinSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const blockedReason = findBlockedCommandReason(parsed.data.data);
        if (blockedReason) {
            return { ok: false, error: { message: blockedReason, name: 'PolicyError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/commands/${parsed.data.pid}/stdin`,
                {
                    method: 'POST',
                    body: JSON.stringify({ data: parsed.data.data }),
                }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Sandbox command stdin failed', name: 'RunnerError' } };
            }
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `stdin → ${parsed.data.pid}`,
                status: 'completed',
                startedAt: nowIso(),
                finishedAt: nowIso(),
                meta: { pid: parsed.data.pid },
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: base.status ?? 'running',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxCommandKillTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_command_kill',
        description: 'Kill a running background command.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
            },
            required: ['sessionId', 'pid'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxCommandKillSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/commands/${parsed.data.pid}/kill`,
                { method: 'POST' }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Sandbox command kill failed', name: 'RunnerError' } };
            }
            const event: SandboxEvent = {
                id: `command-${parsed.data.pid}`,
                kind: 'command',
                label: `command ${parsed.data.pid}`,
                status: 'cancelled',
                startedAt: nowIso(),
                finishedAt: nowIso(),
                meta: { pid: parsed.data.pid },
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'idle',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxPtyStartTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_pty_start',
        description: 'Create a PTY (interactive terminal) in the sandbox. `stream` defaults to true for live output. Returns pid.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                rows: { type: 'number' },
                cols: { type: 'number' },
                cwd: { type: 'string' },
                timeoutSeconds: { type: 'number' },
                env: { type: 'string', description: 'Optional environment variables as a JSON object string, e.g. {"KEY":"value"}.' },
                stream: { type: 'boolean' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxPtyStartSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
        let resolvedCwd: string | undefined;
        try {
            resolvedCwd = parsed.data.cwd ? resolveSandboxPath(parsed.data.cwd, stateWorkdir) : undefined;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        try {
            const effectiveCwd = resolvedCwd ?? stateWorkdir;
            const stream = parsed.data.stream ?? true;
            const result = await runnerFetchJson<Record<string, unknown>>(`/sessions/${parsed.data.sessionId}/pty`, {
                method: 'POST',
                body: JSON.stringify({
                    rows: parsed.data.rows,
                    cols: parsed.data.cols,
                    cwd: effectiveCwd,
                    timeout_seconds: parsed.data.timeoutSeconds,
                    env: parsed.data.env,
                    stream,
                }),
            });
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Sandbox PTY failed', name: 'RunnerError' } };
            }
            const pid = typeof result.data.pid === 'number' ? result.data.pid : undefined;
            if (!pid) {
                return { ok: false, error: { message: 'Runner did not return a pid', name: 'RunnerError' } };
            }
            const event: SandboxEvent = {
                id: `pty-${pid}`,
                kind: 'pty',
                label: `PTY ${pid}`,
                status: 'running',
                startedAt: nowIso(),
                meta: { pid, rows: parsed.data.rows, cols: parsed.data.cols, cwd: effectiveCwd, stream },
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'running',
                sessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? effectiveCwd,
                updatedAt: nowIso(),
                events: [...base.events, event],
                summary: {
                    headline: 'PTY started',
                    detail: `PTY ${pid} ready for input.`,
                    nextAction: 'Send stdin or poll for output.',
                },
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: { ...payload, pid },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxPtyStatusTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_pty_status',
        description: 'Fetch PTY output/status for an interactive terminal.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
                after: { type: 'number' },
            },
            required: ['sessionId', 'pid'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxPtyStatusSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const qp = parsed.data.after !== undefined ? `?after=${parsed.data.after}` : '';
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/pty/${parsed.data.pid}${qp}`,
                { method: 'GET' }
            );
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Sandbox PTY status failed', name: 'RunnerError' } };
            }
            const statusRaw = typeof result.data.status === 'string' ? result.data.status : undefined;
            const eventStatus = statusRaw === 'running' ? 'running' : statusRaw === 'cancelled' ? 'cancelled' : 'completed';
            const startedAt = typeof result.data.started_at === 'string' ? result.data.started_at : nowIso();
            const finishedAt = typeof result.data.finished_at === 'string' ? result.data.finished_at : undefined;
            const outputClip = typeof result.data.output === 'string' ? clipSandboxOutput(result.data.output) : null;
            const eventMeta: Record<string, unknown> = {
                pid: parsed.data.pid,
                rows: result.data.rows,
                cols: result.data.cols,
                cwd: result.data.cwd,
                nextAfter: result.data.next_after,
            };
            if (outputClip) {
                eventMeta.outputChars = outputClip.originalChars;
                if (outputClip.truncated) eventMeta.outputTruncated = true;
            }
            const event: SandboxEvent = {
                id: `pty-${parsed.data.pid}`,
                kind: 'pty',
                label: `PTY ${parsed.data.pid}`,
                status: eventStatus,
                startedAt,
                finishedAt,
                stdout: outputClip ? outputClip.text : undefined,
                meta: eventMeta,
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: eventStatus === 'running' ? 'running' : 'idle',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxPtySendTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_pty_send',
        description: 'Send stdin to a PTY.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
                data: { type: 'string' },
            },
            required: ['sessionId', 'pid', 'data'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxPtyStdinSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const blockedReason = findBlockedCommandReason(parsed.data.data);
        if (blockedReason) {
            return { ok: false, error: { message: blockedReason, name: 'PolicyError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/pty/${parsed.data.pid}/stdin`,
                {
                    method: 'POST',
                    body: JSON.stringify({ data: parsed.data.data }),
                }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Sandbox PTY stdin failed', name: 'RunnerError' } };
            }
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'pty',
                label: `stdin → ${parsed.data.pid}`,
                status: 'completed',
                startedAt: nowIso(),
                finishedAt: nowIso(),
                meta: { pid: parsed.data.pid },
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: base.status ?? 'running',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxPtyResizeTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_pty_resize',
        description: 'Resize a PTY.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
                rows: { type: 'number' },
                cols: { type: 'number' },
            },
            required: ['sessionId', 'pid', 'rows', 'cols'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxPtyResizeSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/pty/${parsed.data.pid}/resize`,
                {
                    method: 'POST',
                    body: JSON.stringify({ rows: parsed.data.rows, cols: parsed.data.cols }),
                }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Sandbox PTY resize failed', name: 'RunnerError' } };
            }
            const event: SandboxEvent = {
                id: `pty-${parsed.data.pid}`,
                kind: 'pty',
                label: `PTY ${parsed.data.pid}`,
                status: 'running',
                startedAt: nowIso(),
                meta: { pid: parsed.data.pid, rows: parsed.data.rows, cols: parsed.data.cols },
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'running',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxPtyKillTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_pty_kill',
        description: 'Kill a PTY.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                pid: { type: 'number' },
            },
            required: ['sessionId', 'pid'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxPtyKillSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/sessions/${parsed.data.sessionId}/pty/${parsed.data.pid}/kill`,
                { method: 'POST' }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Sandbox PTY kill failed', name: 'RunnerError' } };
            }
            const event: SandboxEvent = {
                id: `pty-${parsed.data.pid}`,
                kind: 'pty',
                label: `PTY ${parsed.data.pid}`,
                status: 'cancelled',
                startedAt: nowIso(),
                finishedAt: nowIso(),
                meta: { pid: parsed.data.pid },
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'idle',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxUploadTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_upload',
        description: 'Write a file into the sandbox session at a path from text/base64 content (use before sandbox_exec).',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                path: { type: 'string' },
                contentText: { type: 'string' },
                contentBase64: { type: 'string' },
            },
            required: ['sessionId', 'path'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxUploadSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
        let resolvedPath: string;
        try {
            resolvedPath = resolveSandboxPath(parsed.data.path, stateWorkdir);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        try {
            const rawText = typeof parsed.data.contentText === 'string' ? parsed.data.contentText : undefined;
            const rawBase64 = typeof parsed.data.contentBase64 === 'string' ? parsed.data.contentBase64 : undefined;
            const picked = pickSandboxUploadContent({ contentText: rawText, contentBase64: rawBase64 });
            const expectedBytes = picked.expectedBytes;
            const uploadSource = picked.source;
            const fallbackSteps: string[] = [];

            const buildRecoveryEvent = (previousSessionId: string, recoveredSessionId: string): SandboxEvent => ({
                id: randomUUID(),
                kind: 'session',
                label: 'Session auto-recovered',
                status: 'completed' as const,
                startedAt: nowIso(),
                finishedAt: nowIso(),
                meta: { previousSessionId, recoveredSessionId },
            });

            const uploadFile = async (sessionId: string, contentText?: string, contentBase64?: string) => {
                const filePayload: Record<string, unknown> = { path: resolvedPath };
                if (typeof contentText === 'string') filePayload.content_text = contentText;
                if (typeof contentBase64 === 'string') filePayload.content_base64 = contentBase64;
                return withSessionRecoveryJson<Record<string, unknown>>({
                    initialSessionId: sessionId,
                    workdir: stateWorkdir ?? '/code',
                    request: (nextSessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${nextSessionId}/files`, {
                        method: 'POST',
                        body: JSON.stringify({ files: [filePayload] }),
                    }),
                });
            };

            const tryFetchSize = async (sessionId: string) => {
                try {
                    return await fetchSandboxFileSize(sessionId, resolvedPath);
                } catch {
                    return null;
                }
            };

            const recoveryEvents: SandboxEvent[] = [];
            let effectiveSessionId = parsed.data.sessionId;
            let resultData: Record<string, unknown> | undefined;
            const startedAt = nowIso();

            const firstAttemptSessionId = effectiveSessionId;
            const firstCall = await uploadFile(effectiveSessionId, picked.contentText, picked.contentBase64);
            effectiveSessionId = firstCall.sessionId;
            if (!firstCall.result.ok) {
                return { ok: false, error: { message: firstCall.result.errorText || 'Sandbox upload failed', name: 'RunnerError' } };
            }
            resultData = firstCall.result.data;
            if (firstCall.recovered) {
                recoveryEvents.push(buildRecoveryEvent(firstAttemptSessionId, effectiveSessionId));
            }

            let verifiedSize: number | null = expectedBytes > 0 ? await tryFetchSize(effectiveSessionId) : null;
            const fallbackBase64 = rawBase64 && rawBase64.length > 0
                ? rawBase64
                : rawText !== undefined
                    ? Buffer.from(rawText, 'utf8').toString('base64')
                    : undefined;

            if (expectedBytes > 0 && verifiedSize === 0) {
                if (uploadSource !== 'base64' && fallbackBase64) {
                    const retryAttemptSessionId = effectiveSessionId;
                    const retryCall = await uploadFile(effectiveSessionId, undefined, fallbackBase64);
                    effectiveSessionId = retryCall.sessionId;
                    if (!retryCall.result.ok) {
                        return {
                            ok: false,
                            error: { message: retryCall.result.errorText || 'Sandbox upload retry failed', name: 'RunnerError' },
                        };
                    }
                    resultData = retryCall.result.data ?? resultData;
                    if (retryCall.recovered) {
                        recoveryEvents.push(buildRecoveryEvent(retryAttemptSessionId, effectiveSessionId));
                    }
                    fallbackSteps.push('base64');
                    verifiedSize = await tryFetchSize(effectiveSessionId);
                }
                if (expectedBytes > 0 && verifiedSize === 0 && fallbackBase64) {
                    const execResult = await writeSandboxFileViaExec({
                        sessionId: effectiveSessionId,
                        filePath: resolvedPath,
                        base64: fallbackBase64,
                        workdir: stateWorkdir ?? '/code',
                    });
                    effectiveSessionId = execResult.sessionId;
                    if (!execResult.ok) {
                        return {
                            ok: false,
                            error: { message: execResult.errorText || 'Sandbox exec fallback failed', name: 'RunnerError' },
                        };
                    }
                    if (execResult.recoveredEvents.length > 0) {
                        recoveryEvents.push(...execResult.recoveredEvents);
                    }
                    fallbackSteps.push('exec');
                    verifiedSize = await tryFetchSize(effectiveSessionId);
                }
            }

            if (expectedBytes > 0 && verifiedSize === 0) {
                return {
                    ok: false,
                    error: {
                        message: 'Sandbox upload produced an empty file after retry. Try smaller parts or sandbox_exec.',
                        name: 'RunnerError',
                    },
                };
            }

            const finishedAt = nowIso();
            const uploadMeta: Record<string, unknown> = { source: uploadSource };
            if (expectedBytes > 0) uploadMeta.expectedBytes = expectedBytes;
            if (typeof verifiedSize === 'number') uploadMeta.writtenBytes = verifiedSize;
            if (fallbackSteps.length > 0) uploadMeta.fallback = fallbackSteps.join('->');

            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'upload',
                label: resolvedPath,
                status: 'completed',
                startedAt,
                finishedAt,
                meta: Object.keys(uploadMeta).length > 0 ? uploadMeta : undefined,
            };
            const file: SandboxFile = {
                path: resolvedPath,
                name: safeFileName(path.basename(resolvedPath), 'file'),
                updatedAt: finishedAt,
                size: typeof verifiedSize === 'number' ? verifiedSize : undefined,
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'idle',
                sessionId: effectiveSessionId,
                updatedAt: finishedAt,
                events: [...base.events, ...recoveryEvents, event],
                files: [...(base.files ?? []), file],
                summary: {
                    headline: 'File uploaded',
                    detail: file.name ?? parsed.data.path,
                    nextAction: 'Run a command that uses this file.',
                },
            });

            await billSandboxSessionIfNeeded(context, effectiveSessionId);

            return {
                ok: true,
                data: resultData,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxDownloadTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_download',
        description: 'Persist a file from the sandbox session to artifacts storage and return a download URL.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                path: { type: 'string' },
            },
            required: ['sessionId', 'path'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxDownloadSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
        let resolvedPath: string;
        try {
            resolvedPath = resolveSandboxPath(parsed.data.path, stateWorkdir);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        try {
            const { chatId } = requireContextIds(context);
            const result = await runnerFetchBinary(`/sessions/${parsed.data.sessionId}/files/content?path=${encodeURIComponent(resolvedPath)}`);
            if (!result.ok || !result.body) {
                return { ok: false, error: { message: result.errorText || 'Sandbox download failed', name: 'RunnerError' } };
            }
            const filename = safeFileName(path.basename(resolvedPath), 'sandbox-file');
            const storagePath = `runner-outputs/${chatId}/sandbox/${filename}`;
            await uploadStorageObject('artifacts', storagePath, Buffer.from(result.body), { contentType: 'application/octet-stream' });
            const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 600);
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'download',
                label: resolvedPath,
                status: 'completed',
                startedAt: nowIso(),
                finishedAt: nowIso(),
            };
            const file: SandboxFile = {
                path: resolvedPath,
                name: filename,
                downloadUrl: signedUrl,
                updatedAt: nowIso(),
            };
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'idle',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                events: [...base.events, event],
                files: [...(base.files ?? []), file],
                summary: {
                    headline: 'File ready',
                    detail: filename,
                    nextAction: 'Download or share this output.',
                },
            });

            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);

            return {
                ok: true,
                data: { downloadUrl: signedUrl },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxPersistTreeTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_persist_tree',
        description:
            'Persist an entire folder tree from sandbox to storage so generated scaffolds survive session expiry. Defaults to artifacts under runner-outputs/{chatId}/scaffolds/.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                rootPath: { type: 'string', description: 'Sandbox folder path (e.g. /code/my-project).' },
                targetBucket: { type: 'string', enum: ['artifacts', 'uploads'] },
                targetPrefix: {
                    type: 'string',
                    description: 'Optional storage prefix (relative). For artifacts this is under runner-outputs/{chatId}/.',
                },
                maxFiles: { type: 'number', description: 'Optional per-call cap for number of files to persist.' },
            },
            required: ['sessionId', 'rootPath'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxPersistTreeSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadSandboxState(context).catch(() => emptySandboxState());
        const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
        let resolvedRoot: string;
        try {
            resolvedRoot = resolveSandboxPath(parsed.data.rootPath, stateWorkdir);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ValidationError' } };
        }
        if (!isSafeSandboxPersistPath(resolvedRoot)) {
            return {
                ok: false,
                error: { message: 'rootPath must stay under /code or /pipelines.', name: 'ValidationError' },
            };
        }
        try {
            const { chatId, userId } = requireContextIds(context);
            const targetBucket = parsed.data.targetBucket ?? 'artifacts';
            const stamp = Date.now();
            const rootName = safeFileName(path.posix.basename(resolvedRoot) || 'scaffold', 'scaffold');
            const maxFiles = parsed.data.maxFiles ?? parseIntEnv('RUNNER_PERSIST_TREE_MAX_FILES', 1000);
            const normalizedPrefix = parsed.data.targetPrefix
                ? normalizeStoragePrefixParts(parsed.data.targetPrefix)
                : '';
            const basePrefix = targetBucket === 'uploads'
                ? normalizedPrefix
                    ? `${userId}/${chatId}/${normalizedPrefix}`
                    : `${userId}/${chatId}/sandbox-outputs/${parsed.data.sessionId}/${stamp}-${rootName}`
                : normalizedPrefix
                    ? `runner-outputs/${chatId}/${normalizedPrefix}`
                    : `runner-outputs/${chatId}/scaffolds/${rootName}-${stamp}`;

            const files = await listSandboxTreeFiles({
                sessionId: parsed.data.sessionId,
                rootPath: resolvedRoot,
                maxFiles,
            });
            if (files.length === 0) {
                return { ok: false, error: { message: 'No files found under rootPath.', name: 'RunnerError' } };
            }

            const maxSingleBytes = parseIntEnv('RUNNER_MAX_FILE_BYTES', 20_000_000);
            const maxTotalBytes = parseIntEnv('RUNNER_PERSIST_TREE_MAX_BYTES', 100_000_000);
            let totalBytes = 0;
            const persisted: Array<{ sandboxPath: string; storagePath: string; size: number }> = [];
            for (const file of files) {
                const binary = await runnerFetchBinary(
                    `/sessions/${encodeURIComponent(parsed.data.sessionId)}/files/content?path=${encodeURIComponent(file.sandboxPath)}`
                );
                if (!binary.ok || !binary.body) {
                    throw new Error(binary.errorText || `Failed to read ${file.sandboxPath}`);
                }
                const buffer = Buffer.from(binary.body);
                if (buffer.byteLength > maxSingleBytes) {
                    throw new Error(`File too large: ${file.sandboxPath} (max ${maxSingleBytes} bytes).`);
                }
                totalBytes += buffer.byteLength;
                if (totalBytes > maxTotalBytes) {
                    throw new Error(`Persist tree exceeded max total bytes (${maxTotalBytes}).`);
                }
                const storagePath = `${basePrefix}/${file.relativePath}`;
                await uploadStorageObject(targetBucket, storagePath, buffer, {
                    contentType: 'application/octet-stream',
                });
                persisted.push({ sandboxPath: file.sandboxPath, storagePath, size: buffer.byteLength });
            }

            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'download',
                label: `Persisted tree ${resolvedRoot}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: {
                    rootPath: resolvedRoot,
                    count: persisted.length,
                    totalBytes,
                    targetBucket,
                    basePrefix,
                },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                summary: {
                    headline: 'Sandbox tree persisted',
                    detail: `${persisted.length} files from ${resolvedRoot}`,
                    nextAction: 'Check Outputs in Files drawer or publish to GitHub.',
                },
            });

            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);

            return {
                ok: true,
                data: {
                    bucket: targetBucket,
                    rootPath: resolvedRoot,
                    basePrefix,
                    count: persisted.length,
                    totalBytes,
                    persisted: persisted.slice(0, 200),
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const githubRepoCheckoutTool: Tool = {
    category: 'data',
    definition: {
        name: 'github_repo_checkout',
        description:
            'Checkout a connected GitHub repository inside an existing sandbox session. It syncs the configured base branch, then checks out the working branch (default: tuna).',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                connectionId: { type: 'string', description: 'Connected repo id from /api/integrations/github/repos.' },
                repoFullName: { type: 'string', description: 'Connected repo in owner/repo format (used when connectionId is omitted).' },
                targetDir: { type: 'string', description: 'Sandbox directory path to clone/sync into (relative paths are resolved in workdir).' },
                baseBranch: { type: 'string', description: 'Override base branch for this checkout.' },
                workBranch: { type: 'string', description: 'Override work branch for this checkout.' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = githubRepoCheckoutSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }

        try {
            const { userId, chatId } = requireContextIds(context);
            const connection = await resolveGithubConnectionForTool(context, {
                connectionId: parsed.data.connectionId,
                repoFullName: parsed.data.repoFullName ? normalizeGithubRepoFullName(parsed.data.repoFullName) : undefined,
            });
            const token = await resolveUserIntegrationToken(userId, 'github', GITHUB_TOKEN_ENV_NAMES);
            if (!token) {
                return {
                    ok: false,
                    error: {
                        message: 'GitHub token is not configured. Add it in Integrations before checking out private repos.',
                        name: 'AuthenticationError',
                    },
                };
            }

            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const defaultTargetDir = `repos/${path.posix.basename(connection.repoFullName)}`;
            const targetPath = resolveSandboxPath(parsed.data.targetDir ?? defaultTargetDir, stateWorkdir ?? '/code');
            const baseBranch = normalizeGitBranch(parsed.data.baseBranch, connection.baseBranch || 'main');
            const workBranch = normalizeGitBranch(parsed.data.workBranch, connection.workBranch || 'tuna');

            const command = [
                'set -euo pipefail',
                "cat > /tmp/tuna_git_askpass.sh <<'EOF'",
                '#!/bin/sh',
                'case "$1" in',
                '  *Username*) echo "x-access-token" ;;',
                '  *Password*) echo "$GITHUB_TOKEN" ;;',
                '  *) echo "" ;;',
                'esac',
                'EOF',
                'chmod 700 /tmp/tuna_git_askpass.sh',
                'export GIT_ASKPASS=/tmp/tuna_git_askpass.sh',
                'export GIT_TERMINAL_PROMPT=0',
                "trap 'rm -f /tmp/tuna_git_askpass.sh' EXIT",
                'mkdir -p "$(dirname "$TARGET_PATH")"',
                'if [ -d "$TARGET_PATH/.git" ]; then',
                '  git -C "$TARGET_PATH" remote set-url origin "https://github.com/$REPO_FULL_NAME.git"',
                '  git -C "$TARGET_PATH" fetch origin --prune',
                'else',
                '  git clone "https://github.com/$REPO_FULL_NAME.git" "$TARGET_PATH"',
                'fi',
                'if git -C "$TARGET_PATH" show-ref --verify --quiet "refs/remotes/origin/$BASE_BRANCH"; then',
                '  git -C "$TARGET_PATH" checkout -B "$BASE_BRANCH" "origin/$BASE_BRANCH"',
                'else',
                '  git -C "$TARGET_PATH" checkout -B "$BASE_BRANCH"',
                'fi',
                'if git -C "$TARGET_PATH" show-ref --verify --quiet "refs/remotes/origin/$WORK_BRANCH"; then',
                '  git -C "$TARGET_PATH" checkout -B "$WORK_BRANCH" "origin/$WORK_BRANCH"',
                'else',
                '  git -C "$TARGET_PATH" checkout -B "$WORK_BRANCH" "$BASE_BRANCH"',
                'fi',
                'echo "__CHECKOUT_READY__"',
                'git -C "$TARGET_PATH" rev-parse --short HEAD',
                'git -C "$TARGET_PATH" status --short',
            ].join('\n');

            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${sessionId}/exec`, {
                    method: 'POST',
                    body: JSON.stringify({
                        command,
                        timeout_seconds: 240,
                        env: {
                            GITHUB_TOKEN: token,
                            REPO_FULL_NAME: connection.repoFullName,
                            TARGET_PATH: targetPath,
                            BASE_BRANCH: baseBranch,
                            WORK_BRANCH: workBranch,
                        },
                    }),
                }),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'GitHub checkout failed', name: 'RunnerError' } };
            }

            const stdout = typeof result.data?.stdout === 'string' ? result.data.stdout : '';
            let repoMirror: { basePrefix: string; count: number; totalBytes: number } | null = null;
            let repoMirrorWarning: string | null = null;
            try {
                repoMirror = await mirrorRepoTreeToFileManager({
                    chatId,
                    sessionId: effectiveSessionId,
                    repoFullName: connection.repoFullName,
                    rootPath: targetPath,
                });
            } catch (error) {
                repoMirrorWarning = error instanceof Error ? error.message : String(error);
            }
            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `GitHub checkout ${connection.repoFullName}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: {
                    repo: connection.repoFullName,
                    targetPath,
                    baseBranch,
                    workBranch,
                    fileManagerPrefix: repoMirror?.basePrefix,
                    fileManagerCount: repoMirror?.count,
                    fileManagerTotalBytes: repoMirror?.totalBytes,
                    fileManagerWarning: repoMirrorWarning || undefined,
                },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? base.workdir,
                summary: {
                    headline: 'GitHub repo ready',
                    detail: `${connection.repoFullName} -> ${targetPath}`,
                    nextAction: repoMirror
                        ? 'Edit files, run tests, then publish with github_repo_publish. Snapshot is in Files > Outputs.'
                        : 'Edit files, run tests, then publish with github_repo_publish.',
                },
            });

            await billSandboxSessionIfNeeded(context, effectiveSessionId);

            return {
                ok: true,
                data: {
                    repoFullName: connection.repoFullName,
                    targetPath,
                    baseBranch,
                    workBranch,
                    stdout: clip(stdout, 1200),
                    fileManagerPrefix: repoMirror?.basePrefix ?? null,
                    fileManagerFileCount: repoMirror?.count ?? null,
                    fileManagerTotalBytes: repoMirror?.totalBytes ?? null,
                    fileManagerWarning: repoMirrorWarning,
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const githubRepoPublishTool: Tool = {
    category: 'data',
    definition: {
        name: 'github_repo_publish',
        description:
            'Commit and publish sandbox repo changes to a connected GitHub repo. Defaults to PR flow on branch "tuna". Direct push is only allowed when publishMode="direct" and confirmDirectPush=true.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                connectionId: { type: 'string' },
                repoFullName: { type: 'string' },
                repoPath: { type: 'string', description: 'Path to the checked-out git repo in the sandbox.' },
                commitMessage: { type: 'string' },
                publishMode: { type: 'string', enum: ['pr', 'direct'] },
                confirmDirectPush: {
                    type: 'boolean',
                    description: 'Must be true to allow direct push mode. Use only when user explicitly requests direct push.',
                },
                baseBranch: { type: 'string' },
                workBranch: { type: 'string' },
                targetBranch: { type: 'string', description: 'Required for direct mode when pushing to a non-base branch.' },
                prTitle: { type: 'string' },
                prBody: { type: 'string' },
                draftPr: { type: 'boolean' },
            },
            required: ['sessionId', 'repoPath', 'commitMessage'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = githubRepoPublishSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const { userId, chatId } = requireContextIds(context);
            const connection = await resolveGithubConnectionForTool(context, {
                connectionId: parsed.data.connectionId,
                repoFullName: parsed.data.repoFullName ? normalizeGithubRepoFullName(parsed.data.repoFullName) : undefined,
            });
            const token = await resolveUserIntegrationToken(userId, 'github', GITHUB_TOKEN_ENV_NAMES);
            if (!token) {
                return {
                    ok: false,
                    error: { message: 'GitHub token is not configured.', name: 'AuthenticationError' },
                };
            }

            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const repoPath = resolveSandboxPath(parsed.data.repoPath, stateWorkdir);
            const baseBranch = normalizeGitBranch(parsed.data.baseBranch, connection.baseBranch || 'main');
            const workBranch = normalizeGitBranch(parsed.data.workBranch, connection.workBranch || 'tuna');
            const defaultMode = pickGithubPublishMode(connection.defaultPublishMode, 'pr');
            const publishMode = pickGithubPublishMode(parsed.data.publishMode, defaultMode);
            if (publishMode === 'direct' && parsed.data.confirmDirectPush !== true) {
                return {
                    ok: false,
                    error: {
                        message: 'Direct push requires explicit confirmation. Set confirmDirectPush=true only when user explicitly asked for direct push.',
                        name: 'ValidationError',
                    },
                };
            }
            const targetBranch = normalizeGitBranch(
                parsed.data.targetBranch,
                publishMode === 'direct' ? baseBranch : workBranch
            );
            const commitMessage = parsed.data.commitMessage.trim();

            const command = [
                'set -euo pipefail',
                "cat > /tmp/tuna_git_askpass.sh <<'EOF'",
                '#!/bin/sh',
                'case "$1" in',
                '  *Username*) echo "x-access-token" ;;',
                '  *Password*) echo "$GITHUB_TOKEN" ;;',
                '  *) echo "" ;;',
                'esac',
                'EOF',
                'chmod 700 /tmp/tuna_git_askpass.sh',
                'export GIT_ASKPASS=/tmp/tuna_git_askpass.sh',
                'export GIT_TERMINAL_PROMPT=0',
                "trap 'rm -f /tmp/tuna_git_askpass.sh' EXIT",
                'if [ ! -d "$REPO_PATH/.git" ]; then',
                '  echo "__NOT_GIT_REPO__"',
                '  exit 2',
                'fi',
                'git -C "$REPO_PATH" remote set-url origin "https://github.com/$REPO_FULL_NAME.git"',
                'git -C "$REPO_PATH" fetch origin --prune',
                'git -C "$REPO_PATH" checkout -B "$WORK_BRANCH"',
                'git -C "$REPO_PATH" config user.name "${GIT_AUTHOR_NAME:-Tuna Agent}"',
                'git -C "$REPO_PATH" config user.email "${GIT_AUTHOR_EMAIL:-agent@tuna.local}"',
                'git -C "$REPO_PATH" add -A',
                'if git -C "$REPO_PATH" diff --cached --quiet; then',
                '  echo "__NO_CHANGES__"',
                '  exit 0',
                'fi',
                'git -C "$REPO_PATH" commit -m "$COMMIT_MESSAGE"',
                'if [ "$PUBLISH_MODE" = "direct" ]; then',
                '  git -C "$REPO_PATH" push origin "HEAD:$TARGET_BRANCH"',
                'else',
                '  git -C "$REPO_PATH" push -u origin "$WORK_BRANCH"',
                'fi',
                'echo "__PUSHED__"',
                'git -C "$REPO_PATH" rev-parse HEAD',
            ].join('\n');

            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${sessionId}/exec`, {
                    method: 'POST',
                    body: JSON.stringify({
                        command,
                        timeout_seconds: 300,
                        env: {
                            GITHUB_TOKEN: token,
                            REPO_FULL_NAME: connection.repoFullName,
                            REPO_PATH: repoPath,
                            WORK_BRANCH: workBranch,
                            TARGET_BRANCH: targetBranch,
                            PUBLISH_MODE: publishMode,
                            COMMIT_MESSAGE: commitMessage,
                        },
                    }),
                }),
            });
            const effectiveSessionId = call.sessionId;
            const execResult = call.result;

            if (!execResult.ok) {
                return { ok: false, error: { message: execResult.errorText || 'GitHub publish failed', name: 'RunnerError' } };
            }

            const stdout = typeof execResult.data?.stdout === 'string' ? execResult.data.stdout : '';
            if (stdout.includes('__NOT_GIT_REPO__')) {
                return {
                    ok: false,
                    error: { message: `${repoPath} is not a git repository. Run github_repo_checkout first.`, name: 'ValidationError' },
                };
            }
            const noChanges = stdout.includes('__NO_CHANGES__');
            let prUrl: string | null = null;
            let prNumber: number | null = null;
            let prExisting = false;

            if (!noChanges && publishMode === 'pr') {
                const prTitle = parsed.data.prTitle?.trim() || commitMessage;
                const prBody = parsed.data.prBody?.trim()
                    || `Automated update from Tuna agent.\n\n- Repo: ${connection.repoFullName}\n- Branch: ${workBranch}`;
                const pr = await ensureGithubPullRequest({
                    token,
                    repoFullName: connection.repoFullName,
                    baseBranch,
                    headBranch: workBranch,
                    title: prTitle,
                    body: prBody,
                    draft: parsed.data.draftPr,
                });
                prUrl = pr.url;
                prNumber = pr.number;
                prExisting = pr.existing;
            }

            let repoMirror: { basePrefix: string; count: number; totalBytes: number } | null = null;
            let repoMirrorWarning: string | null = null;
            try {
                repoMirror = await mirrorRepoTreeToFileManager({
                    chatId,
                    sessionId: effectiveSessionId,
                    repoFullName: connection.repoFullName,
                    rootPath: repoPath,
                });
            } catch (error) {
                repoMirrorWarning = error instanceof Error ? error.message : String(error);
            }

            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `GitHub publish ${connection.repoFullName}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: {
                    repo: connection.repoFullName,
                    repoPath,
                    publishMode,
                    baseBranch,
                    workBranch,
                    targetBranch,
                    noChanges,
                    prUrl: prUrl ?? undefined,
                    fileManagerPrefix: repoMirror?.basePrefix,
                    fileManagerCount: repoMirror?.count,
                    fileManagerTotalBytes: repoMirror?.totalBytes,
                    fileManagerWarning: repoMirrorWarning || undefined,
                },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? base.workdir,
                summary: {
                    headline: noChanges
                        ? 'No Git changes to publish'
                        : publishMode === 'pr'
                            ? (prExisting ? 'Updated existing pull request branch' : 'Opened pull request')
                            : 'Pushed changes directly',
                    detail: connection.repoFullName,
                    nextAction: noChanges
                        ? 'Modify files first, then publish again.'
                        : publishMode === 'pr'
                            ? 'Review and merge the pull request on GitHub.'
                            : 'Verify the target branch state on GitHub.',
                },
            });

            await billSandboxSessionIfNeeded(context, effectiveSessionId);

            return {
                ok: true,
                data: {
                    repoFullName: connection.repoFullName,
                    repoPath,
                    publishMode,
                    baseBranch,
                    workBranch,
                    targetBranch,
                    noChanges,
                    prUrl,
                    prNumber,
                    prExisting,
                    stdout: clip(stdout, 1400),
                    fileManagerPrefix: repoMirror?.basePrefix ?? null,
                    fileManagerFileCount: repoMirror?.count ?? null,
                    fileManagerTotalBytes: repoMirror?.totalBytes ?? null,
                    fileManagerWarning: repoMirrorWarning,
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const kaggleDatasetDownloadTool: Tool = {
    category: 'data',
    definition: {
        name: 'kaggle_dataset_download',
        description: 'Download a Kaggle dataset into the sandbox session (token is resolved server-side from integrations).',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                dataset: { type: 'string', description: 'Kaggle dataset slug in owner/dataset format.' },
                targetDir: { type: 'string' },
                unzip: { type: 'boolean' },
                timeoutSeconds: { type: 'number' },
            },
            required: ['sessionId', 'dataset'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = kaggleDatasetDownloadSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const { userId } = requireContextIds(context);
            const token = await resolveUserIntegrationToken(userId, 'kaggle', ['KAGGLE_TOKEN']);
            if (!token) {
                return {
                    ok: false,
                    error: {
                        message: 'Kaggle token is not configured. Add it under Integrations first.',
                        name: 'AuthenticationError',
                    },
                };
            }
            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const targetDir = parsed.data.targetDir
                ? resolveSandboxPath(parsed.data.targetDir, stateWorkdir)
                : (stateWorkdir || '/code/kaggle');
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(
                    `/sessions/${sessionId}/kaggle/datasets/download`,
                    {
                        method: 'POST',
                        body: JSON.stringify({
                            dataset: parsed.data.dataset,
                            target_dir: targetDir,
                            unzip: parsed.data.unzip,
                            timeout_seconds: parsed.data.timeoutSeconds,
                            kaggle_token: token,
                        }),
                    }
                ),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Kaggle dataset download failed', name: 'RunnerError' } };
            }

            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `Kaggle dataset ${parsed.data.dataset}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: { action: 'kaggle_dataset_download', dataset: parsed.data.dataset, targetDir },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? base.workdir,
                summary: {
                    headline: 'Kaggle dataset downloaded',
                    detail: parsed.data.dataset,
                    nextAction: 'Use sandbox_exec to inspect or process downloaded files.',
                },
            });
            await billSandboxSessionIfNeeded(context, effectiveSessionId);
            return {
                ok: true,
                data: {
                    dataset: parsed.data.dataset,
                    targetDir,
                    stdout: clip(String(result.data?.stdout ?? ''), 1200),
                    stderr: clip(String(result.data?.stderr ?? ''), 1200),
                    exitCode: result.data?.exit_code,
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const kaggleDatasetUploadTool: Tool = {
    category: 'data',
    definition: {
        name: 'kaggle_dataset_upload',
        description: 'Create a new Kaggle dataset version from a sandbox directory.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                sourceDir: { type: 'string' },
                datasetSlug: { type: 'string', description: 'Kaggle dataset slug in owner/dataset format.' },
                title: { type: 'string' },
                private: { type: 'boolean' },
                message: { type: 'string' },
                timeoutSeconds: { type: 'number' },
            },
            required: ['sessionId', 'sourceDir', 'datasetSlug'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = kaggleDatasetUploadSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const { userId } = requireContextIds(context);
            const token = await resolveUserIntegrationToken(userId, 'kaggle', ['KAGGLE_TOKEN']);
            if (!token) {
                return {
                    ok: false,
                    error: { message: 'Kaggle token is not configured.', name: 'AuthenticationError' },
                };
            }
            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const sourceDir = resolveSandboxPath(parsed.data.sourceDir, stateWorkdir);
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(
                    `/sessions/${sessionId}/kaggle/datasets/upload`,
                    {
                        method: 'POST',
                        body: JSON.stringify({
                            source_dir: sourceDir,
                            dataset_slug: parsed.data.datasetSlug,
                            title: parsed.data.title,
                            private: parsed.data.private,
                            message: parsed.data.message,
                            timeout_seconds: parsed.data.timeoutSeconds,
                            kaggle_token: token,
                        }),
                    }
                ),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Kaggle dataset upload failed', name: 'RunnerError' } };
            }

            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `Kaggle upload ${parsed.data.datasetSlug}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: { action: 'kaggle_dataset_upload', datasetSlug: parsed.data.datasetSlug, sourceDir },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? base.workdir,
                summary: {
                    headline: 'Kaggle dataset version uploaded',
                    detail: parsed.data.datasetSlug,
                    nextAction: 'Verify the new dataset version on Kaggle.',
                },
            });
            await billSandboxSessionIfNeeded(context, effectiveSessionId);
            return {
                ok: true,
                data: {
                    datasetSlug: parsed.data.datasetSlug,
                    sourceDir,
                    stdout: clip(String(result.data?.stdout ?? ''), 1200),
                    stderr: clip(String(result.data?.stderr ?? ''), 1200),
                    exitCode: result.data?.exit_code,
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const kaggleCompetitionSubmitTool: Tool = {
    category: 'data',
    definition: {
        name: 'kaggle_competition_submit',
        description: 'Submit a prediction file from sandbox to a Kaggle competition.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                competition: { type: 'string' },
                filePath: { type: 'string' },
                message: { type: 'string' },
                timeoutSeconds: { type: 'number' },
            },
            required: ['sessionId', 'competition', 'filePath'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = kaggleCompetitionSubmitSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const { userId } = requireContextIds(context);
            const token = await resolveUserIntegrationToken(userId, 'kaggle', ['KAGGLE_TOKEN']);
            if (!token) {
                return {
                    ok: false,
                    error: { message: 'Kaggle token is not configured.', name: 'AuthenticationError' },
                };
            }
            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const filePath = resolveSandboxPath(parsed.data.filePath, stateWorkdir);
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(
                    `/sessions/${sessionId}/kaggle/competitions/submit`,
                    {
                        method: 'POST',
                        body: JSON.stringify({
                            competition: parsed.data.competition,
                            file_path: filePath,
                            message: parsed.data.message,
                            timeout_seconds: parsed.data.timeoutSeconds,
                            kaggle_token: token,
                        }),
                    }
                ),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Kaggle competition submit failed', name: 'RunnerError' } };
            }
            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `Kaggle submit ${parsed.data.competition}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: { action: 'kaggle_competition_submit', competition: parsed.data.competition, filePath },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? base.workdir,
                summary: {
                    headline: 'Kaggle competition submission sent',
                    detail: parsed.data.competition,
                    nextAction: 'Check submission status on Kaggle leaderboard.',
                },
            });
            await billSandboxSessionIfNeeded(context, effectiveSessionId);
            return {
                ok: true,
                data: {
                    competition: parsed.data.competition,
                    filePath,
                    stdout: clip(String(result.data?.stdout ?? ''), 1200),
                    stderr: clip(String(result.data?.stderr ?? ''), 1200),
                    exitCode: result.data?.exit_code,
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const kaggleKernelPushTool: Tool = {
    category: 'data',
    definition: {
        name: 'kaggle_kernel_push',
        description: 'Push a notebook/script from sandbox to Kaggle Kernels (notebook execution hook).',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                sourceDir: { type: 'string' },
                kernelSlug: { type: 'string', description: 'Kaggle kernel slug in owner/kernel format.' },
                title: { type: 'string' },
                competition: { type: 'string' },
                enableGpu: { type: 'boolean' },
                enableInternet: { type: 'boolean' },
                timeoutSeconds: { type: 'number' },
            },
            required: ['sessionId', 'sourceDir', 'kernelSlug'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = kaggleKernelPushSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const { userId } = requireContextIds(context);
            const token = await resolveUserIntegrationToken(userId, 'kaggle', ['KAGGLE_TOKEN']);
            if (!token) {
                return {
                    ok: false,
                    error: { message: 'Kaggle token is not configured.', name: 'AuthenticationError' },
                };
            }
            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const sourceDir = resolveSandboxPath(parsed.data.sourceDir, stateWorkdir);
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(
                    `/sessions/${sessionId}/kaggle/kernels/push`,
                    {
                        method: 'POST',
                        body: JSON.stringify({
                            source_dir: sourceDir,
                            kernel_slug: parsed.data.kernelSlug,
                            title: parsed.data.title,
                            competition: parsed.data.competition,
                            enable_gpu: parsed.data.enableGpu,
                            enable_internet: parsed.data.enableInternet,
                            timeout_seconds: parsed.data.timeoutSeconds,
                            kaggle_token: token,
                        }),
                    }
                ),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Kaggle kernel push failed', name: 'RunnerError' } };
            }
            const now = nowIso();
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'command',
                label: `Kaggle kernel ${parsed.data.kernelSlug}`,
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: { action: 'kaggle_kernel_push', kernelSlug: parsed.data.kernelSlug, sourceDir },
            };
            const payload = appendSandboxEvent(base, event);
            const merged = mergeSandboxState(payload, {
                sessionId: effectiveSessionId,
                workdir: call.recoveredWorkdir ?? base.workdir,
                summary: {
                    headline: 'Kaggle kernel pushed',
                    detail: parsed.data.kernelSlug,
                    nextAction: 'Open Kaggle to monitor kernel execution/output.',
                },
            });
            await billSandboxSessionIfNeeded(context, effectiveSessionId);
            return {
                ok: true,
                data: {
                    kernelSlug: parsed.data.kernelSlug,
                    sourceDir,
                    stdout: clip(String(result.data?.stdout ?? ''), 1200),
                    stderr: clip(String(result.data?.stderr ?? ''), 1200),
                    exitCode: result.data?.exit_code,
                },
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: merged,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const sandboxBrowserTool: Tool = {
    category: 'data',
    definition: {
        name: 'sandbox_browser',
        description:
            'Fetch a URL in the sandbox and return screenshot/html/text; screenshots are persisted and returned as a URL. If the page is blocked by login/paywall/CAPTCHA (reCAPTCHA/hCaptcha/Turnstile) or needs interactive steps, escalate to a Desktop session (`desktop_start` + `desktop_action`) and prompt the user to take over when required.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                url: { type: 'string' },
                action: { type: 'string', enum: ['screenshot', 'html', 'text'] },
                selector: { type: 'string' },
                waitMs: { type: 'number' },
                viewport: { type: 'string', description: 'Optional viewport as a JSON object string, e.g. {"width":1280,"height":720}.' },
            },
            required: ['sessionId', 'url'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = sandboxBrowserSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const base = await loadSandboxState(context).catch(() => emptySandboxState());
            const stateWorkdir = base.sessionId === parsed.data.sessionId ? base.workdir : undefined;
            const call = await withSessionRecoveryJson<Record<string, unknown>>({
                initialSessionId: parsed.data.sessionId,
                workdir: stateWorkdir ?? '/code',
                request: (sessionId) => runnerFetchJson<Record<string, unknown>>(`/sessions/${sessionId}/browser`, {
                    method: 'POST',
                    body: JSON.stringify({
                        url: parsed.data.url,
                        action: parsed.data.action,
                        selector: parsed.data.selector,
                        wait_ms: parsed.data.waitMs,
                        viewport: parsed.data.viewport,
                    }),
                }),
            });
            const effectiveSessionId = call.sessionId;
            const result = call.result;
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Sandbox browser failed', name: 'RunnerError' } };
            }
            const browserData = result.data as Record<string, unknown>;
            const browserResult = (browserData?.result ?? {}) as Record<string, unknown>;
            let markdown: string | undefined;
            if (typeof browserResult.screenshot_base64 === 'string') {
                const { chatId } = requireContextIds(context);
                const screenshotBytes = Buffer.from(browserResult.screenshot_base64, 'base64');
                const storagePath = `runner-outputs/${chatId}/sandbox/${effectiveSessionId}/screenshot-${Date.now()}.png`;
                await uploadStorageObject('artifacts', storagePath, screenshotBytes, { contentType: 'image/png' });
                const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 600);
                browserResult.screenshot_url = signedUrl;
                delete browserResult.screenshot_base64;
                markdown = `![Screenshot](${signedUrl})`;
            } else if (typeof browserResult.html === 'string') {
                markdown = `\`\`\`html\n${clip(browserResult.html, 4000)}\n\`\`\``;
            } else if (typeof browserResult.text === 'string') {
                markdown = `\`\`\`text\n${clip(browserResult.text, 4000)}\n\`\`\``;
            }
            const snapshot: SandboxBrowserSnapshot = {
                id: randomUUID(),
                url: parsed.data.url,
                title: typeof (browserData as Record<string, unknown>).title === 'string'
                    ? String((browserData as Record<string, unknown>).title)
                    : undefined,
                screenshotUrl: typeof (browserResult as Record<string, unknown>).screenshot_url === 'string'
                    ? String((browserResult as Record<string, unknown>).screenshot_url)
                    : undefined,
                htmlSnippet: typeof (browserResult as Record<string, unknown>).html === 'string'
                    ? clip(String((browserResult as Record<string, unknown>).html), 1200)
                    : undefined,
                textSnippet: typeof (browserResult as Record<string, unknown>).text === 'string'
                    ? clip(String((browserResult as Record<string, unknown>).text), 1200)
                    : undefined,
                createdAt: nowIso(),
            };
            const event: SandboxEvent = {
                id: randomUUID(),
                kind: 'browser',
                label: parsed.data.url,
                status: 'completed',
                startedAt: snapshot.createdAt,
                finishedAt: snapshot.createdAt,
            };
            const recoveryEvent = call.recovered ? {
                id: randomUUID(),
                kind: 'session',
                label: 'Session auto-recovered',
                status: 'completed' as const,
                startedAt: snapshot.createdAt,
                finishedAt: snapshot.createdAt,
                meta: {
                    previousSessionId: parsed.data.sessionId,
                    recoveredSessionId: effectiveSessionId,
                },
            } : null;
            const payload = mergeSandboxState(base, {
                kind: 'sandbox_state_v2',
                status: 'idle',
                sessionId: effectiveSessionId,
                updatedAt: nowIso(),
                events: [...base.events, ...(recoveryEvent ? [recoveryEvent] : []), event],
                browser: [...(base.browser ?? []), snapshot],
                summary: {
                    headline: 'Browser task completed',
                    detail: parsed.data.url,
                    nextAction: 'Review the preview or continue browsing.',
                },
            });

            await billSandboxSessionIfNeeded(context, effectiveSessionId);

            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'sandbox',
                            type: 'markdown',
                            title: 'Sandbox',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'sandbox' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const desktopStartTool: Tool = {
    category: 'data',
    definition: {
        name: 'desktop_start',
        description:
            'Start a desktop session for interactive GUI automation. Attempts to auto-start streaming; falls back to screenshots if unavailable.\n\nTip: If you want the GUI to open with an app already running (e.g. Chromium for web browsing), pass `startupActions` (they run before the Desktop panel is opened).\n\nHuman takeover: If browsing hits a blocker the agent cannot bypass (login/subscription paywall, SSO/OAuth, 2FA/OTP, reCAPTCHA/hCaptcha, Cloudflare Turnstile), ask the user to click "Take control" in the Desktop panel, complete the step in the remote browser, then click "Hand back" and send handoff notes (at minimum "Logged in" so Send is enabled). Keep the same desktop session running so cookies/session state persist; do not stop the session while waiting for handoff.',
        parameters: {
            type: 'object',
            properties: {
                resolution: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                dpi: { type: 'number' },
                display: { type: 'string' },
                timeoutSeconds: { type: 'number' },
                env: { type: 'string', description: 'Optional environment variables as a JSON object string, e.g. {"KEY":"value"}.' },
                startupActions: {
                    type: 'array',
                    description:
                        'Optional desktop actions to run immediately after the session starts (before the UI is opened). Each action must include `action` and optionally `params`.',
                    items: {
                        type: 'object',
                        properties: {
                            action: { type: 'string' },
                            params: { type: 'string', description: 'Optional action parameters as a JSON object string.' },
                        },
                        required: ['action'],
                        additionalProperties: false,
                    },
                },
            },
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = desktopStartSchema.safeParse(args ?? {});
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const result = await runnerFetchJson<Record<string, unknown>>('/desktop/sessions', {
                method: 'POST',
                body: JSON.stringify({
                    resolution: parsed.data.resolution,
                    dpi: parsed.data.dpi,
                    display: parsed.data.display,
                    timeout_seconds: parsed.data.timeoutSeconds,
                    env: parsed.data.env,
                }),
            });
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Failed to start desktop session', name: 'RunnerError' } };
            }
            const sessionId = typeof result.data.desktop_session_id === 'string' ? result.data.desktop_session_id : '';
            if (!sessionId) {
                return { ok: false, error: { message: 'Runner did not return a desktop session id', name: 'RunnerError' } };
            }
            const base = await loadDesktopState(context).catch(() => emptyDesktopState());
            const startedAt = nowIso();
            const event: DesktopEvent = {
                id: randomUUID(),
                kind: 'desktop',
                label: 'Desktop session ready',
                status: 'completed',
                startedAt,
                meta: {
                    resolution: result.data.resolution,
                    dpi: result.data.dpi,
                    display: result.data.display,
                },
            };
            const { chatId } = requireContextIds(context);
            let streamUrl: string | undefined;
            let streamEvent: DesktopEvent | null = null;
            let recordingPayload: DesktopRecording | undefined;
            try {
                const streamStart = await runnerFetchJson<Record<string, unknown>>(
                    `/desktop/sessions/${sessionId}/stream/start`,
                    { method: 'POST', body: JSON.stringify({ require_auth: true }) }
                );
                if (streamStart.ok) {
                    streamUrl = buildDesktopStreamProxyUrl(chatId, sessionId);
                    const streamStartedAt = nowIso();
                    const streamMeta = typeof streamStart.data === 'object' && streamStart.data
                        ? streamStart.data
                        : undefined;
                    const recordingMeta = streamMeta && typeof (streamMeta as Record<string, unknown>).recording === 'object'
                        ? ((streamMeta as Record<string, unknown>).recording as Record<string, unknown>)
                        : undefined;
                    if (recordingMeta) {
                        recordingPayload = {
                            status: 'recording',
                            startedAt: typeof recordingMeta.started_at === 'string' ? recordingMeta.started_at : streamStartedAt,
                            intervalMs: typeof recordingMeta.interval_ms === 'number' ? recordingMeta.interval_ms : undefined,
                            frameCount: typeof recordingMeta.frame_count === 'number' ? recordingMeta.frame_count : 0,
                            manifestKey: typeof recordingMeta.manifest_key === 'string' ? recordingMeta.manifest_key : undefined,
                        };
                    }
                    streamEvent = {
                        id: randomUUID(),
                        kind: 'desktop_stream',
                        label: 'Stream started',
                        status: 'completed',
                        startedAt: streamStartedAt,
                        finishedAt: streamStartedAt,
                        meta: {
                            recording: recordingMeta,
                        },
                    };
                }
            } catch {
                // Ignore stream start failures; fallback to screenshots.
            }
            const startupActions = parsed.data.startupActions;
            let startupEvent: DesktopEvent | null = null;
            let startupLastAction: string | undefined;
            if (Array.isArray(startupActions) && startupActions.length > 0) {
                const startupStartedAt = nowIso();
                const label = `startup: ${startupActions.map((a) => a.action).join(', ')}`.trim();
                try {
                    const startupResult = await runnerFetchJson<Record<string, unknown>>(
                        `/desktop/sessions/${sessionId}/actions`,
                        {
                            method: 'POST',
                            body: JSON.stringify({ actions: startupActions }),
                        },
                        { timeoutMs: 60_000 }
                    );
                    if (startupResult.ok) {
                        startupLastAction = label;
                        startupEvent = {
                            id: randomUUID(),
                            kind: 'desktop_action',
                            label: 'Startup actions',
                            status: 'completed',
                            startedAt: startupStartedAt,
                            finishedAt: nowIso(),
                            meta: {
                                actions: startupActions,
                                results: (startupResult.data as Record<string, unknown> | undefined)?.results,
                            },
                        };
                    } else {
                        startupEvent = {
                            id: randomUUID(),
                            kind: 'desktop_action',
                            label: 'Startup actions',
                            status: 'failed',
                            startedAt: startupStartedAt,
                            finishedAt: nowIso(),
                            meta: {
                                actions: startupActions,
                                error: startupResult.errorText || 'Startup actions failed',
                                status: startupResult.status,
                            },
                        };
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    startupEvent = {
                        id: randomUUID(),
                        kind: 'desktop_action',
                        label: 'Startup actions',
                        status: 'failed',
                        startedAt: startupStartedAt,
                        finishedAt: nowIso(),
                        meta: { actions: startupActions, error: message },
                    };
                }
            }
            const payload = mergeDesktopState(base, {
                kind: 'desktop_state_v1',
                status: 'running',
                sessionId,
                startedAt,
                updatedAt: startedAt,
                streamUrl,
                streamUpdatedAt: streamUrl ? nowIso() : undefined,
                recording: recordingPayload,
                lastAction: startupLastAction,
                events: [...base.events, event, ...(streamEvent ? [streamEvent] : []), ...(startupEvent ? [startupEvent] : [])],
                summary: {
                    headline: streamUrl ? 'Desktop stream active' : 'Desktop ready',
                    detail: streamUrl
                        ? 'Live stream is available in the desktop panel.'
                        : 'You can send desktop actions or capture a screenshot.',
                    nextAction: streamUrl ? 'Perform desktop actions or stop the stream when finished.' : 'Take a screenshot or perform an action.',
                },
            });
            await billSandboxSessionIfNeeded(context, sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'desktop',
                            type: 'markdown',
                            title: 'Desktop',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'desktop' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const desktopActionTool: Tool = {
    category: 'data',
    definition: {
        name: 'desktop_action',
        description:
            'Execute one or more desktop actions.\n\nEach item should be shaped like: { action: string, params?: { ... } }. (If you accidentally pass action-specific fields at the top-level of the action object, they will be treated as params.)\n\nSupported actions: click/left_click, double_click, right_click, middle_click, scroll (direction/amount), move_mouse (x,y), drag (from,to), write (text), press (key/keys), open (target), launch (application, optional uri), wait (ms).\n\nSafety: Do NOT type credentials, 2FA/OTP codes, or payment details. If login/CAPTCHA/SSO is required, ask the user to take over the live Desktop session (Take control → Hand back).',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                actions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            action: { type: 'string' },
                            params: { type: 'string', description: 'Optional action parameters as a JSON object string, e.g. {"x":100,"y":200}.' },
                        },
                        required: ['action'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['sessionId', 'actions'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = desktopActionSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadDesktopState(context).catch(() => emptyDesktopState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/desktop/sessions/${parsed.data.sessionId}/actions`,
                {
                    method: 'POST',
                    body: JSON.stringify({ actions: parsed.data.actions }),
                }
            );
            if (!result.ok || !result.data) {
                return { ok: false, error: { message: result.errorText || 'Desktop action failed', name: 'RunnerError' } };
            }
            const startedAt = nowIso();
            const label = parsed.data.actions.map((action) => action.action).join(', ');
            const event: DesktopEvent = {
                id: randomUUID(),
                kind: 'desktop_action',
                label: label || 'action',
                status: 'completed',
                startedAt,
                finishedAt: nowIso(),
                meta: { results: result.data.results },
            };
            const payload = mergeDesktopState(base, {
                kind: 'desktop_state_v1',
                status: 'running',
                sessionId: parsed.data.sessionId,
                updatedAt: nowIso(),
                lastAction: label,
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'desktop',
                            type: 'markdown',
                            title: 'Desktop',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'desktop' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const desktopScreenshotTool: Tool = {
    category: 'data',
    definition: {
        name: 'desktop_screenshot',
        description: 'Capture a desktop screenshot and store it as an artifact URL.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                copyToStorage: { type: 'boolean' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = desktopScreenshotSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        try {
            const result = await runnerFetchBinary(`/desktop/sessions/${parsed.data.sessionId}/screenshot`);
            if (!result.ok || !result.body) {
                return { ok: false, error: { message: result.errorText || 'Desktop screenshot failed', name: 'RunnerError' } };
            }
            const copyToStorage = parsed.data.copyToStorage !== false;
            const base = await loadDesktopState(context).catch(() => emptyDesktopState());
            const { chatId } = requireContextIds(context);
            const now = nowIso();

            if (!copyToStorage) {
                const event: DesktopEvent = {
                    id: randomUUID(),
                    kind: 'desktop_screenshot',
                    label: 'Screenshot captured',
                    status: 'completed',
                    startedAt: now,
                    finishedAt: now,
                };
                const payload = mergeDesktopState(base, {
                    kind: 'desktop_state_v1',
                    status: base.status ?? 'running',
                    sessionId: parsed.data.sessionId,
                    updatedAt: now,
                    events: [...base.events, event],
                });
                return { ok: true, data: { screenshotBase64: Buffer.from(result.body).toString('base64'), state: payload } };
            }

            const buffer = Buffer.from(result.body);
            const storagePath = `runner-outputs/${chatId}/desktop/${parsed.data.sessionId}/screenshot-${Date.now()}.png`;
            await uploadStorageObject('artifacts', storagePath, buffer, { contentType: 'image/png' });
            const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 600);

            const event: DesktopEvent = {
                id: randomUUID(),
                kind: 'desktop_screenshot',
                label: 'Screenshot captured',
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: { url: signedUrl },
            };
            const payload = mergeDesktopState(base, {
                kind: 'desktop_state_v1',
                status: base.status ?? 'running',
                sessionId: parsed.data.sessionId,
                screenshotUrl: signedUrl,
                screenshotUpdatedAt: now,
                updatedAt: now,
                events: [...base.events, event],
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'desktop',
                            type: 'markdown',
                            title: 'Desktop',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'desktop' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const desktopStopTool: Tool = {
    category: 'data',
    definition: {
        name: 'desktop_stop',
        description: 'Close a desktop session and release resources.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = desktopStopSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadDesktopState(context).catch(() => emptyDesktopState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/desktop/sessions/${parsed.data.sessionId}/close`,
                { method: 'POST' }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Failed to close desktop session', name: 'RunnerError' } };
            }
            const now = nowIso();
            const event: DesktopEvent = {
                id: randomUUID(),
                kind: 'desktop',
                label: 'Desktop session closed',
                status: 'stopped',
                startedAt: now,
                finishedAt: now,
            };
            const payload = mergeDesktopState(base, {
                kind: 'desktop_state_v1',
                status: 'stopped',
                sessionId: undefined,
                updatedAt: now,
                events: [...base.events, event],
                summary: {
                    headline: 'Desktop closed',
                    detail: 'Session resources were released.',
                    nextAction: 'Start a new desktop session when needed.',
                },
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'desktop',
                            type: 'markdown',
                            title: 'Desktop',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const desktopStreamStartTool: Tool = {
    category: 'data',
    definition: {
        name: 'desktop_stream_start',
        description: 'Start a desktop stream and expose it via the server proxy URL.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                windowId: { type: 'string' },
                requireAuth: { type: 'boolean' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = desktopStreamStartSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadDesktopState(context).catch(() => emptyDesktopState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/desktop/sessions/${parsed.data.sessionId}/stream/start`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        window_id: parsed.data.windowId,
                        require_auth: parsed.data.requireAuth,
                    }),
                }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Desktop stream start failed', name: 'RunnerError' } };
            }
            const { chatId } = requireContextIds(context);
            const now = nowIso();
            const proxyUrl = buildDesktopStreamProxyUrl(chatId, parsed.data.sessionId);
            const recordingMeta = result.data && typeof result.data === 'object'
                ? (result.data as Record<string, unknown>).recording
                : undefined;
            const recordingPayload: DesktopRecording | undefined = recordingMeta && typeof recordingMeta === 'object'
                ? (() => {
                    const meta = recordingMeta as Record<string, unknown>;
                    const startedAtRaw = meta.started_at;
                    const intervalRaw = meta.interval_ms;
                    const frameCountRaw = meta.frame_count;
                    const manifestKeyRaw = meta.manifest_key;
                    return {
                        status: 'recording',
                        startedAt: typeof startedAtRaw === 'string' ? startedAtRaw : now,
                        intervalMs: typeof intervalRaw === 'number' ? intervalRaw : undefined,
                        frameCount: typeof frameCountRaw === 'number' ? frameCountRaw : 0,
                        manifestKey: typeof manifestKeyRaw === 'string' ? manifestKeyRaw : undefined,
                    };
                })()
                : undefined;
            const event: DesktopEvent = {
                id: randomUUID(),
                kind: 'desktop_stream',
                label: 'Stream started',
                status: 'completed',
                startedAt: now,
                finishedAt: now,
                meta: { windowId: parsed.data.windowId, requireAuth: parsed.data.requireAuth, recording: recordingMeta },
            };
            const payload = mergeDesktopState(base, {
                kind: 'desktop_state_v1',
                status: base.status ?? 'running',
                sessionId: parsed.data.sessionId,
                streamUrl: proxyUrl,
                streamUpdatedAt: now,
                recording: recordingPayload,
                updatedAt: now,
                events: [...base.events, event],
                summary: {
                    headline: 'Desktop stream active',
                    detail: 'Live stream is available in the desktop panel.',
                    nextAction: 'Stop the stream when finished.',
                },
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'desktop',
                            type: 'markdown',
                            title: 'Desktop',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id: 'desktop' } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};

export const desktopStreamStopTool: Tool = {
    category: 'data',
    definition: {
        name: 'desktop_stream_stop',
        description: 'Stop the active desktop stream.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
            },
            required: ['sessionId'],
        },
    },
    handler: async (args: unknown, context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = desktopStreamStopSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const base = await loadDesktopState(context).catch(() => emptyDesktopState());
        try {
            const result = await runnerFetchJson<Record<string, unknown>>(
                `/desktop/sessions/${parsed.data.sessionId}/stream/stop`,
                { method: 'POST' }
            );
            if (!result.ok) {
                return { ok: false, error: { message: result.errorText || 'Desktop stream stop failed', name: 'RunnerError' } };
            }
            const now = nowIso();
            const recordingMeta = result.data && typeof result.data === 'object'
                ? (result.data as Record<string, unknown>).recording
                : undefined;
            const recordingPayload: DesktopRecording | undefined = recordingMeta && typeof recordingMeta === 'object'
                ? (() => {
                    const meta = recordingMeta as Record<string, unknown>;
                    const startedAtRaw = meta.started_at;
                    const stoppedAtRaw = meta.stopped_at;
                    const intervalRaw = meta.interval_ms;
                    const frameCountRaw = meta.frame_count;
                    const manifestKeyRaw = meta.manifest_key;
                    return {
                        status: 'stopped',
                        startedAt: typeof startedAtRaw === 'string' ? startedAtRaw : undefined,
                        stoppedAt: typeof stoppedAtRaw === 'string' ? stoppedAtRaw : now,
                        intervalMs: typeof intervalRaw === 'number' ? intervalRaw : undefined,
                        frameCount: typeof frameCountRaw === 'number' ? frameCountRaw : undefined,
                        manifestKey: typeof manifestKeyRaw === 'string' ? manifestKeyRaw : undefined,
                    };
                })()
                : undefined;
            const event: DesktopEvent = {
                id: randomUUID(),
                kind: 'desktop_stream',
                label: 'Stream stopped',
                status: 'completed',
                startedAt: now,
                finishedAt: now,
            };
            const payload = mergeDesktopState(base, {
                kind: 'desktop_state_v1',
                status: base.status ?? 'running',
                sessionId: parsed.data.sessionId,
                streamUrl: undefined,
                streamUpdatedAt: now,
                recording: recordingPayload,
                updatedAt: now,
                events: [...base.events, event],
                summary: {
                    headline: 'Desktop stream stopped',
                    detail: 'Live stream has ended.',
                    nextAction: 'Restart the stream or capture a screenshot.',
                },
            });
            await billSandboxSessionIfNeeded(context, parsed.data.sessionId);
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id: 'desktop',
                            type: 'markdown',
                            title: 'Desktop',
                            content: payload,
                            status: 'executing',
                            isCollaborative: false,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message, name: 'ConfigurationError' } };
        }
    },
};
