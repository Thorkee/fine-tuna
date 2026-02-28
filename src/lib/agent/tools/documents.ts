import 'server-only';

import { z } from 'zod';
import HTMLtoDOCX from 'html-to-docx';
import { randomUUID } from 'crypto';
import createDOMPurify, { type WindowLike } from 'dompurify';

import { normalizeDocumentHtml } from '@/lib/markdown';
import { createClient } from '@/lib/supabase/server';
import {
    createStorageSignedUrl,
    downloadStorageObject,
    uploadStorageObject,
} from '@/lib/supabase/storage';
import { AgentPersistence } from '../persistence';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';

const importDocxSchema = z.object({
    chatId: z.string().min(1),
    storagePath: z.string().min(1),
    artifactId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
}).strict();

const upsertHtmlSchema = z.object({
    chatId: z.string().min(1),
    artifactId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    html: z.string().min(1),
}).strict();

const exportDocxSchema = z.object({
    chatId: z.string().min(1),
    artifactId: z.string().min(1),
}).strict();

async function assertChatOwnership(chatId: string) {
    const supabase = await createClient();
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const { data, error } = await supabase
        .from('chats')
        .select('id')
        .eq('id', chatId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error || !data) throw new Error('Chat not found');
    return { supabase, userId };
}

type Purifier = ReturnType<typeof createDOMPurify>;

let purifierPromise: Promise<Purifier | null> | null = null;
let purifierInitFailed = false;

async function getPurifier(): Promise<Purifier | null> {
    if (purifierPromise) return purifierPromise;
    purifierPromise = (async () => {
        try {
            const { JSDOM } = await import('jsdom');
            const { window } = new JSDOM('');
            return createDOMPurify(window as unknown as WindowLike);
        } catch (error) {
            if (!purifierInitFailed) {
                purifierInitFailed = true;
                console.warn('JSDOM unavailable; falling back to basic HTML sanitizer.', error);
            }
            return null;
        }
    })();
    return purifierPromise;
}

function basicSanitizeHtml(html: string) {
    let safe = html;
    safe = safe.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    safe = safe.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    safe = safe.replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    safe = safe.replace(/\s(href|src)=(["'])\s*javascript:[^"']*\2/gi, ' $1="#"');
    safe = safe.replace(/\s(href|src)=\s*javascript:[^\s>]+/gi, ' $1="#"');
    return safe;
}

async function sanitizeHtml(html: string) {
    const purifier = await getPurifier();
    if (purifier) {
        return purifier.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return basicSanitizeHtml(html);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function extractHtml(content: unknown): string | null {
    const raw =
        typeof content === 'string'
            ? content
            : isRecord(content)
                ? content.html ?? content.content ?? content.body ?? content.markdown
                : null;
    if (typeof raw !== 'string') return null;
    const normalized = normalizeDocumentHtml(raw);
    return normalized ? normalized : null;
}

function safeFileName(value: string) {
    return value.replace(/[^a-z0-9_-]+/gi, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
}

export const importDocxTool: Tool = {
    category: 'data',
    definition: {
        name: 'import_docx',
        description: 'Import a DOCX from Supabase storage into a document artifact.',
        parameters: {
            type: 'object',
            properties: {
                chatId: { type: 'string' },
                storagePath: { type: 'string' },
                artifactId: { type: 'string' },
                title: { type: 'string' },
            },
            required: ['chatId', 'storagePath'],
        },
    },
    handler: async (args: unknown, _context: AgentContext): Promise<ToolExecutionResult> => {
        const parsed = importDocxSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const { chatId, storagePath, artifactId, title } = parsed.data;
        try {
            await assertChatOwnership(chatId);
            const fileBuffer = await downloadStorageObject('uploads', storagePath);
            const mammoth = await import('mammoth');
            const result = await mammoth.convertToHtml({ buffer: fileBuffer });
            const rawHtml = typeof result.value === 'string' && result.value.trim() ? result.value : '<p></p>';
            const html = await sanitizeHtml(rawHtml);
            const now = new Date().toISOString();
            const id = artifactId ?? 'document';
            const payload = {
                kind: 'document',
                title: title ?? 'Document',
                html,
                updatedAt: now,
                version: 1,
            };
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id,
                            type: 'document',
                            title: payload.title,
                            content: payload,
                            status: 'draft',
                            isCollaborative: true,
                        },
                    },
                    { type: 'ui.openArtifact', payload: { id } },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};

export const upsertDocumentHtmlTool: Tool = {
    category: 'ui',
    definition: {
        name: 'upsert_document_html',
        description: 'Create or update a document artifact with HTML content.',
        parameters: {
            type: 'object',
            properties: {
                chatId: { type: 'string' },
                artifactId: { type: 'string' },
                title: { type: 'string' },
                html: { type: 'string' },
            },
            required: ['chatId', 'html'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = upsertHtmlSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const { chatId, artifactId, title, html } = parsed.data;
        try {
            await assertChatOwnership(chatId);
            const now = new Date().toISOString();
            const id = artifactId ?? 'document';
            const normalizedHtml = normalizeDocumentHtml(html);
            const safeHtml = await sanitizeHtml(normalizedHtml || '<p></p>');
            const payload = {
                kind: 'document',
                title: title ?? 'Document',
                html: safeHtml,
                updatedAt: now,
                version: 1,
            };
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id,
                            type: 'document',
                            title: payload.title,
                            content: payload,
                            status: 'draft',
                            isCollaborative: true,
                        },
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};

export const exportDocxTool: Tool = {
    category: 'data',
    definition: {
        name: 'export_docx',
        description: 'Export a document artifact to DOCX and return a signed URL.',
        parameters: {
            type: 'object',
            properties: {
                chatId: { type: 'string' },
                artifactId: { type: 'string' },
            },
            required: ['chatId', 'artifactId'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = exportDocxSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const { chatId, artifactId } = parsed.data;
        try {
            await assertChatOwnership(chatId);
            const state = await AgentPersistence.loadState(chatId);
            if (!state) throw new Error('Agent state not found');
            const artifact = state.artifacts.find(a => a.id === artifactId);
            if (!artifact) throw new Error('Artifact not found');
            const html = extractHtml(artifact.content) ?? '<p></p>';
            const docx = await HTMLtoDOCX(html, null, {
                title: artifact.title || 'Document',
                creator: 'tuna',
            });
            const fileBuffer = Buffer.isBuffer(docx) ? docx : Buffer.from(docx as ArrayBuffer);
            const fileName = `${safeFileName(artifactId) || 'document'}-${randomUUID().slice(0, 8)}.docx`;
            const storagePath = `exports/${chatId}/${fileName}`;
            await uploadStorageObject('artifacts', storagePath, fileBuffer, {
                contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 60 * 10);
            return { ok: true, data: { url: signedUrl, storagePath } };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};
