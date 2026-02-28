import 'server-only';

import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';

import { createClient } from '@/lib/supabase/server';
import {
    createStorageSignedUrl,
    downloadStorageObject,
    uploadStorageObject,
} from '@/lib/supabase/storage';
import { AgentPersistence } from '../persistence';
import type { AgentContext, Tool, ToolExecutionResult } from '../types';

type SpreadsheetSheet = {
    id?: string;
    name?: string;
    order?: number;
    status?: number;
    row?: number;
    column?: number;
    celldata?: Array<{ r: number; c: number; v: unknown }>;
};

type SpreadsheetArtifactData = {
    kind: 'spreadsheet';
    title?: string;
    sheets: SpreadsheetSheet[];
    updatedAt?: string;
    version?: number;
};

type CellValue = string | number | boolean | Date;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeSheets(data: unknown): SpreadsheetSheet[] {
    if (Array.isArray(data)) return data as SpreadsheetSheet[];
    if (isRecord(data) && Array.isArray(data.sheets)) return data.sheets as SpreadsheetSheet[];
    return [];
}

function safeFileName(value: string) {
    return value.replace(/[^a-z0-9_-]+/gi, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
}

const importXlsxSchema = z.object({
    chatId: z.string().min(1),
    storagePath: z.string().min(1),
    artifactId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
}).strict();

const exportXlsxSchema = z.object({
    chatId: z.string().min(1),
    artifactId: z.string().min(1),
}).strict();

const createFromTableSchema = z.object({
    chatId: z.string().min(1),
    artifactId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    sheetName: z.string().min(1).optional(),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.any()),
}).strict();

const readRangeSchema = z.object({
    chatId: z.string().min(1),
    artifactId: z.string().min(1),
    sheetName: z.string().min(1).optional(),
    range: z.string().min(1).optional(),
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

function workbookToFortune(wb: XLSX.WorkBook): SpreadsheetSheet[] {
    return wb.SheetNames.map((name, idx) => {
        const ws = wb.Sheets[name]!;
        const celldata: Array<{ r: number; c: number; v: unknown }> = [];
        Object.keys(ws).forEach((key) => {
            if (key.startsWith('!')) return;
            const cell = ws[key] as XLSX.CellObject;
            const pos = XLSX.utils.decode_cell(key);
            const value = {
                v: cell.v ?? '',
                f: cell.f,
                t: cell.t,
                z: cell.z,
                w: cell.w,
            };
            celldata.push({ r: pos.r, c: pos.c, v: value });
        });
        const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref'] as string) : null;
        return {
            id: `sheet-${idx + 1}`,
            name,
            order: idx,
            status: 1,
            row: range ? range.e.r + 1 : 30,
            column: range ? range.e.c + 1 : 12,
            celldata,
        };
    });
}

function fortuneToWorkbook(sheets: SpreadsheetSheet[]): XLSX.WorkBook {
    const wb = XLSX.utils.book_new();
    const toCellValue = (value: unknown): CellValue => {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
        if (value instanceof Date) return value;
        return '';
    };
    sheets.forEach((sheet, idx) => {
        const ws: XLSX.WorkSheet = {};
        const celldata = sheet.celldata ?? [];
        let maxR = 0;
        let maxC = 0;
        celldata.forEach((cell) => {
            const addr = XLSX.utils.encode_cell({ r: cell.r, c: cell.c });
            const raw = cell.v;
            let cellObj: XLSX.CellObject;
            if (isRecord(raw)) {
                const v = toCellValue(raw.v);
                cellObj = {
                    v,
                    t: typeof raw.t === 'string'
                        ? (raw.t as XLSX.ExcelDataType)
                        : typeof v === 'number'
                            ? 'n'
                            : typeof v === 'boolean'
                                ? 'b'
                                : v instanceof Date
                                    ? 'd'
                                    : 's',
                };
                if (typeof raw.f === 'string') cellObj.f = raw.f;
                if (typeof raw.z === 'string') cellObj.z = raw.z;
            } else {
                const v = toCellValue(raw);
                cellObj = {
                    v,
                    t: typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : v instanceof Date ? 'd' : 's',
                };
            }
            ws[addr] = cellObj;
            if (cell.r > maxR) maxR = cell.r;
            if (cell.c > maxC) maxC = cell.c;
        });
        if (typeof sheet.row === 'number') maxR = Math.max(maxR, sheet.row - 1);
        if (typeof sheet.column === 'number') maxC = Math.max(maxC, sheet.column - 1);
        ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
        XLSX.utils.book_append_sheet(wb, ws, sheet.name || `Sheet${idx + 1}`);
    });
    return wb;
}

function buildSpreadsheetPayload(args: { title: string; sheets: SpreadsheetSheet[] }): SpreadsheetArtifactData {
    return {
        kind: 'spreadsheet',
        title: args.title,
        sheets: args.sheets,
        updatedAt: new Date().toISOString(),
        version: 1,
    };
}

export const importXlsxTool: Tool = {
    category: 'data',
    definition: {
        name: 'import_xlsx',
        description: 'Import an XLSX from Supabase storage into a spreadsheet artifact.',
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
        const parsed = importXlsxSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const { chatId, storagePath, artifactId, title } = parsed.data;
        try {
            await assertChatOwnership(chatId);
            const fileBuffer = await downloadStorageObject('uploads', storagePath);
            const wb = XLSX.read(fileBuffer, { type: 'buffer', cellFormula: true });
            const sheets = workbookToFortune(wb);
            const id = artifactId ?? 'spreadsheet';
            const payload = buildSpreadsheetPayload({ title: title ?? 'Spreadsheet', sheets });
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id,
                            type: 'spreadsheet',
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

export const exportXlsxTool: Tool = {
    category: 'data',
    definition: {
        name: 'export_xlsx',
        description: 'Export a spreadsheet artifact to XLSX and return a signed URL.',
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
        const parsed = exportXlsxSchema.safeParse(args);
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
            const sheets = normalizeSheets(artifact.content);
            const wb = fortuneToWorkbook(sheets);
            const out = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
            const buffer = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
            const fileName = `${safeFileName(artifactId) || 'sheet'}-${randomUUID().slice(0, 8)}.xlsx`;
            const storagePath = `exports/${chatId}/${fileName}`;
            await uploadStorageObject('artifacts', storagePath, buffer, {
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            });
            const signedUrl = await createStorageSignedUrl('artifacts', storagePath, 60 * 10);
            return { ok: true, data: { url: signedUrl, storagePath } };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};

export const createSpreadsheetFromTableTool: Tool = {
    category: 'data',
    definition: {
        name: 'create_spreadsheet_from_table',
        description: 'Create a spreadsheet artifact from rows/columns data.',
        parameters: {
            type: 'object',
            properties: {
                chatId: { type: 'string' },
                artifactId: { type: 'string' },
                title: { type: 'string' },
                sheetName: { type: 'string' },
                columns: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: {} },
            },
            required: ['chatId', 'rows'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = createFromTableSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const { chatId, artifactId, title, sheetName, columns, rows } = parsed.data;
        try {
            await assertChatOwnership(chatId);
            const headers = columns && columns.length > 0
                ? columns
                : rows.length > 0 && isRecord(rows[0])
                    ? Object.keys(rows[0] as Record<string, unknown>)
                    : [];
            const celldata: Array<{ r: number; c: number; v: unknown }> = [];
            if (headers.length > 0) {
                headers.forEach((h, c) => {
                    celldata.push({ r: 0, c, v: { v: h, t: 's' } });
                });
            }
            rows.forEach((row, rIdx) => {
                if (Array.isArray(row)) {
                    row.forEach((cell, c) => {
                        celldata.push({ r: rIdx + 1, c, v: cell });
                    });
                    return;
                }
                if (isRecord(row)) {
                    headers.forEach((h, c) => {
                        celldata.push({ r: rIdx + 1, c, v: row[h] });
                    });
                }
            });
            const sheets: SpreadsheetSheet[] = [
                {
                    id: 'sheet-1',
                    name: sheetName ?? 'Sheet1',
                    order: 0,
                    status: 1,
                    row: Math.max(30, rows.length + 2),
                    column: Math.max(12, headers.length || 1),
                    celldata,
                },
            ];
            const id = artifactId ?? 'spreadsheet';
            const payload = buildSpreadsheetPayload({ title: title ?? 'Spreadsheet', sheets });
            return {
                ok: true,
                data: payload,
                sideEffects: [
                    {
                        type: 'ui.upsertArtifact',
                        payload: {
                            id,
                            type: 'spreadsheet',
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

export const readRangeTool: Tool = {
    category: 'data',
    definition: {
        name: 'read_range',
        description: 'Read a range from a spreadsheet artifact and return rows.',
        parameters: {
            type: 'object',
            properties: {
                chatId: { type: 'string' },
                artifactId: { type: 'string' },
                sheetName: { type: 'string' },
                range: { type: 'string' },
            },
            required: ['chatId', 'artifactId'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = readRangeSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        const { chatId, artifactId, sheetName, range } = parsed.data;
        try {
            await assertChatOwnership(chatId);
            const state = await AgentPersistence.loadState(chatId);
            if (!state) throw new Error('Agent state not found');
            const artifact = state.artifacts.find(a => a.id === artifactId);
            if (!artifact) throw new Error('Artifact not found');
            const sheets = normalizeSheets(artifact.content);
            const sheet = sheetName
                ? sheets.find(s => s.name === sheetName)
                : sheets[0];
            if (!sheet) throw new Error('Sheet not found');
            const wb = fortuneToWorkbook([sheet]);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, {
                header: 1,
                range: range || undefined,
                blankrows: false,
            }) as unknown[][];
            return { ok: true, data: { sheet: sheet.name ?? 'Sheet1', range: range ?? null, rows } };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};
