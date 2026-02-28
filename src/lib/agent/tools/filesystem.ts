import type { AgentContext, Tool } from '../types';
import fs from 'fs/promises';
import path from 'path';
import { isSensitiveRepoPath } from '../tool-runner';

// Allowed root for safety
const PROJECT_ROOT = process.cwd();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeRepoPath(input: string): string {
    return input.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isAgentNotesPath(relPath: string): boolean {
    const normalized = normalizeRepoPath(relPath);
    return normalized === 'agent_notes' || normalized.startsWith('agent_notes/');
}

function getPathArg(args: unknown): string | null {
    if (!isRecord(args)) return null;
    const p = args.path;
    if (typeof p !== 'string') return null;
    const trimmed = p.trim();
    return trimmed ? trimmed : null;
}

function getOptionalPositiveIntArg(args: unknown, key: string): number | undefined {
    if (!isRecord(args)) return undefined;
    const raw = (args as Record<string, unknown>)[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    const n = Math.floor(raw);
    return n > 0 ? n : undefined;
}

export const readFileTool: Tool = {
    category: 'filesystem',
    definition: {
        name: 'read_file',
        description: 'Read the contents of a file (text only). Supports optional line-range reads.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path from project root' },
                startLine: { type: 'number', description: 'Optional 1-based start line (defaults to 1)' },
                endLine: { type: 'number', description: 'Optional 1-based end line (inclusive). Defaults to startLine+199.' },
            },
            required: ['path'],
        },
    },
    handler: async (args: unknown, _context: AgentContext) => {
        const relPath = getPathArg(args);
        if (!relPath) return { ok: false, error: { message: "Invalid args: expected { path: string }" } };
        const startLineArg = getOptionalPositiveIntArg(args, 'startLine');
        const endLineArg = getOptionalPositiveIntArg(args, 'endLine');
        try {
            if (isSensitiveRepoPath(relPath)) {
                throw new Error('Access denied: sensitive path');
            }
            const fullPath = path.resolve(PROJECT_ROOT, relPath);
            if (!fullPath.startsWith(PROJECT_ROOT)) {
                throw new Error('Access denied: Path outside project root');
            }
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split(/\r?\n/);
            const totalLines = lines.length;

            const startLine = startLineArg ?? 1;
            const endLine = endLineArg ?? Math.min(totalLines, startLine + 199);
            const safeStart = Math.max(1, Math.min(startLine, totalLines));
            const safeEnd = Math.max(safeStart, Math.min(endLine, totalLines));

            const selected = lines.slice(safeStart - 1, safeEnd);
            const withNumbers = selected.map((line, idx) => `${safeStart + idx}|${line}`).join('\n');
            const truncated = safeEnd < totalLines;

            return {
                ok: true,
                data: {
                    content: withNumbers,
                    startLine: safeStart,
                    endLine: safeEnd,
                    totalLines,
                    truncated,
                },
            };
        } catch (error: unknown) {
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
            if (code === 'ENOENT' && isAgentNotesPath(relPath)) {
                return { ok: true, data: { content: '', missing: true } };
            }
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};

export const listDirTool: Tool = {
    category: 'filesystem',
    definition: {
        name: 'list_files',
        description: 'List files in a directory.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path from project root' },
            },
            required: ['path'],
        },
    },
    handler: async (args: unknown, _context: AgentContext) => {
        const relPath = getPathArg(args);
        if (!relPath) return { ok: false, error: { message: "Invalid args: expected { path: string }" } };
        try {
            if (isSensitiveRepoPath(relPath)) {
                throw new Error('Access denied: sensitive path');
            }
            const fullPath = path.resolve(PROJECT_ROOT, relPath);
            if (!fullPath.startsWith(PROJECT_ROOT)) {
                throw new Error('Access denied: Path outside project root');
            }
            const items = await fs.readdir(fullPath, { withFileTypes: true });
            const files = items
                .filter(i => !isSensitiveRepoPath(path.posix.join(relPath.replace(/\\/g, '/'), i.name)))
                .map(i => ({
                    name: i.name,
                    type: i.isDirectory() ? 'directory' : 'file',
                }));
            return { ok: true, data: { files } };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};
