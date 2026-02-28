import 'server-only';

import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';

import { AgentPersistence } from '@/lib/agent/persistence';
import {
    createStorageSignedUrl,
    downloadStorageObject,
    downloadStorageObjectStream,
    headStorageObject,
    uploadStorageObject,
    uploadStorageObjectStream,
} from '@/lib/supabase/storage';

type TrainingFinalizeOptions = {
    chatId: string;
    taskId: string;
    force?: boolean;
};

export type TrainingFinalizeResult = {
    downloadUrl?: string;
    modelUrl?: string;
    modelStoragePath?: string;
    modelFileName?: string;
    logUrl?: string;
    logStoragePath?: string;
    metadataUrl?: string;
    metadataStoragePath?: string;
    reportUrl?: string;
    reportStoragePath?: string;
    bundleUrl?: string;
    bundleStoragePath?: string;
    requestedBackend?: string;
    executionBackend?: string;
    wandbProject?: string;
    wandbRunUrl?: string;
    warnings?: string[];
};

type TrainingArtifactSnapshot = {
    expectedOutputName?: string;
    inputName?: string;
    scriptName?: string;
    submittedAt?: string;
    modelStoragePath?: string;
    logStoragePath?: string;
    metadataStoragePath?: string;
    status?: string;
};

type RunnerConfig = {
    baseUrl: string;
    token?: string;
};

function getRunnerConfig(): RunnerConfig {
    const baseUrl = (process.env.E2B_RUNNER_URL || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
        throw new Error('E2B_RUNNER_URL is not configured');
    }
    const token = (process.env.E2B_RUNNER_TOKEN || '').trim() || undefined;
    return { baseUrl, token };
}

function buildAuthHeaders(token?: string) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function safeFileName(value: string, fallback: string): string {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const cleaned = trimmed.replace(/[^a-z0-9._-]+/gi, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || fallback;
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

async function storageExists(bucket: string, key: string): Promise<boolean> {
    try {
        await headStorageObject(bucket, key);
        return true;
    } catch {
        return false;
    }
}

async function fetchRunnerJson(taskId: string, file: 'status' | 'metadata'): Promise<Record<string, unknown>> {
    const { baseUrl, token } = getRunnerConfig();
    const url =
        file === 'status'
            ? `${baseUrl}/tasks/${encodeURIComponent(taskId)}/status`
            : `${baseUrl}/tasks/${encodeURIComponent(taskId)}/download?file=metadata`;
    const resp = await fetch(url, { headers: buildAuthHeaders(token) });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `Runner ${file} fetch failed`);
    }
    const text = await resp.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function fetchRunnerBinary(taskId: string, file: 'model' | 'log'): Promise<Response> {
    const { baseUrl, token } = getRunnerConfig();
    const url = `${baseUrl}/tasks/${encodeURIComponent(taskId)}/download?file=${encodeURIComponent(file)}`;
    const resp = await fetch(url, { headers: buildAuthHeaders(token) });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `Runner ${file} download failed`);
    }
    return resp;
}

async function loadTrainingSnapshot(chatId: string, taskId: string): Promise<TrainingArtifactSnapshot> {
    try {
        const state = await AgentPersistence.loadState(chatId);
        const artifacts = Array.isArray(state?.artifacts) ? state!.artifacts : [];
        const training = artifacts.find((artifact) => {
            if (!artifact || artifact.id !== 'training') return false;
            const content = artifact.content;
            return typeof content === 'object' && content !== null && (content as { taskId?: unknown }).taskId === taskId;
        });
        const content = (training?.content ?? {}) as Record<string, unknown>;
        return {
            expectedOutputName: typeof content.expectedOutputName === 'string' ? content.expectedOutputName.trim() : undefined,
            inputName: typeof content.inputName === 'string' ? content.inputName.trim() : undefined,
            scriptName: typeof content.scriptName === 'string' ? content.scriptName.trim() : undefined,
            submittedAt: typeof content.submittedAt === 'string' ? content.submittedAt : undefined,
            modelStoragePath: typeof content.modelStoragePath === 'string' ? content.modelStoragePath : undefined,
            logStoragePath: typeof content.logStoragePath === 'string' ? content.logStoragePath : undefined,
            metadataStoragePath: typeof content.metadataStoragePath === 'string' ? content.metadataStoragePath : undefined,
            status: typeof content.status === 'string' ? content.status : undefined,
        };
    } catch {
        return {};
    }
}

function formatLogSnippet(buffer: Buffer | null, maxLines = 24, maxChars = 2000): string {
    if (!buffer) return '';
    const text = buffer.toString('utf-8');
    const lines = text.split(/\r?\n/).slice(0, maxLines);
    const joined = lines.join('\n');
    return joined.length > maxChars ? `${joined.slice(0, maxChars)}...` : joined;
}

function formatMetadataExcerpt(metadata: Record<string, unknown> | null, maxChars = 2000): string {
    if (!metadata) return '';
    let text = '';
    try {
        text = JSON.stringify(metadata, null, 2);
    } catch {
        text = String(metadata);
    }
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...`;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    const paragraphs = text.split(/\r?\n/);
    for (const paragraph of paragraphs) {
        if (!paragraph.trim()) {
            lines.push('');
            continue;
        }
        const words = paragraph.split(/\s+/);
        let line = '';
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = candidate;
            }
        }
        if (line) lines.push(line);
    }
    return lines;
}

async function buildTrainingReportPdf(input: {
    taskId: string;
    status?: string;
    inputName?: string;
    scriptName?: string;
    expectedOutputName?: string;
    submittedAt?: string;
    completedAt?: string;
    modelFileName?: string;
    modelStoragePath?: string;
    logStoragePath?: string;
    metadataStoragePath?: string;
    logSnippet?: string;
    metadataExcerpt?: string;
}): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pageSize: [number, number] = [612, 792];
    let page = pdf.addPage(pageSize);
    const margin = 48;
    let cursorY = page.getHeight() - margin;
    const bodySize = 11;
    const lineHeight = bodySize * 1.35;
    const maxWidth = page.getWidth() - margin * 2;

    const drawLine = (text: string, isHeading = false) => {
        if (isHeading) {
            if (cursorY < margin + lineHeight) {
                page = pdf.addPage(pageSize);
                cursorY = page.getHeight() - margin;
            }
            page.drawText(text, { x: margin, y: cursorY, size: 14, font: fontBold });
            cursorY -= lineHeight;
            return;
        }
        const lines = wrapText(text, font, bodySize, maxWidth);
        for (const line of lines) {
            if (cursorY < margin + lineHeight) {
                page = pdf.addPage(pageSize);
                cursorY = page.getHeight() - margin;
            }
            page.drawText(line, { x: margin, y: cursorY, size: bodySize, font });
            cursorY -= lineHeight;
        }
    };

    drawLine('Training Report', true);
    drawLine(`Task ID: ${input.taskId}`);
    drawLine(`Status: ${input.status || 'completed'}`);
    if (input.submittedAt) drawLine(`Submitted at: ${input.submittedAt}`);
    if (input.completedAt) drawLine(`Completed at: ${input.completedAt}`);
    drawLine('');

    drawLine('Inputs', true);
    drawLine(`Input file: ${input.inputName || 'n/a'}`);
    drawLine(`Training script: ${input.scriptName || 'n/a'}`);
    drawLine(`Expected output: ${input.expectedOutputName || input.modelFileName || 'n/a'}`);
    drawLine('');

    drawLine('Outputs', true);
    drawLine(`Model file: ${input.modelFileName || 'n/a'}`);
    if (input.modelStoragePath) drawLine(`Model storage path: ${input.modelStoragePath}`);
    if (input.logStoragePath) drawLine(`Log storage path: ${input.logStoragePath}`);
    if (input.metadataStoragePath) drawLine(`Metadata storage path: ${input.metadataStoragePath}`);
    drawLine('');

    if (input.logSnippet) {
        drawLine('Log excerpt', true);
        const lines = wrapText(input.logSnippet, font, bodySize, maxWidth);
        for (const line of lines) {
            drawLine(line);
        }
        drawLine('');
    }

    if (input.metadataExcerpt) {
        drawLine('Metadata excerpt', true);
        const lines = wrapText(input.metadataExcerpt, font, bodySize, maxWidth);
        for (const line of lines) {
            drawLine(line);
        }
        drawLine('');
    }

    const bytes = await pdf.save();
    return Buffer.from(bytes);
}

async function buildBundleZip(input: {
    chatId: string;
    taskId: string;
    modelStoragePath?: string;
    modelFileName?: string;
    reportBuffer: Buffer;
    logBuffer: Buffer | null;
    metadataBuffer: Buffer | null;
    manifest: Record<string, unknown>;
    force: boolean;
}): Promise<string | null> {
    const bundlePath = `runner-outputs/${input.chatId}/${input.taskId}/training-bundle.zip`;
    if (!input.force && (await storageExists('artifacts', bundlePath))) {
        return bundlePath;
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    const pass = new PassThrough();

    const uploadPromise = uploadStorageObjectStream('artifacts', bundlePath, pass, {
        contentType: 'application/zip',
    });

    const archiveDone = new Promise<void>((resolve, reject) => {
        pass.on('error', reject);
        archive.on('error', reject);
        pass.on('close', resolve);
        pass.on('finish', resolve);
    });

    archive.pipe(pass);
    archive.append(input.reportBuffer, { name: 'training-report.pdf' });
    if (input.logBuffer) archive.append(input.logBuffer, { name: 'run.log' });
    if (input.metadataBuffer) archive.append(input.metadataBuffer, { name: 'metadata.json' });
    archive.append(Buffer.from(JSON.stringify(input.manifest, null, 2), 'utf-8'), { name: 'manifest.json' });

    if (input.modelStoragePath) {
        try {
            const modelStream = await downloadStorageObjectStream('artifacts', input.modelStoragePath);
            const modelName = input.modelFileName || input.modelStoragePath.split('/').pop() || 'model.bin';
            archive.append(modelStream, { name: modelName });
        } catch {
            // If model stream fails, keep bundle without model binary.
        }
    }

    archive.finalize();
    await Promise.all([uploadPromise, archiveDone]);
    return bundlePath;
}

export async function finalizeTrainingOutputs(options: TrainingFinalizeOptions): Promise<TrainingFinalizeResult> {
    const { chatId, taskId, force = false } = options;
    const warnings: string[] = [];
    const snapshot = await loadTrainingSnapshot(chatId, taskId);

    let statusData: Record<string, unknown> | null = null;
    try {
        statusData = await fetchRunnerJson(taskId, 'status');
        const status = typeof statusData.status === 'string' ? statusData.status : '';
        if (status && status !== 'completed') {
            throw new Error(`Training is not completed (status: ${status})`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Training status check failed';
        throw new Error(message);
    }

    const completedAt = typeof statusData?.updated_at === 'string' ? statusData.updated_at : undefined;

    let modelStoragePath = snapshot.modelStoragePath;
    let modelFileName = modelStoragePath ? modelStoragePath.split('/').pop() || undefined : undefined;

    if (modelStoragePath && !force && !(await storageExists('artifacts', modelStoragePath))) {
        modelStoragePath = undefined;
    }

    if (!modelStoragePath || force) {
        const resp = await fetchRunnerBinary(taskId, 'model');
        const headerName = parseContentDispositionFilename(resp.headers.get('content-disposition'));
        const fallbackName = safeFileName(snapshot.expectedOutputName || 'model.bin', 'model.bin');
        const fileName = safeFileName(headerName || fallbackName, fallbackName);
        const storagePath = `runner-outputs/${chatId}/${taskId}/${fileName}`;
        if (!force && (await storageExists('artifacts', storagePath))) {
            modelStoragePath = storagePath;
            modelFileName = fileName;
        } else if (!resp.body) {
            warnings.push('Model download stream unavailable.');
        } else {
            await uploadStorageObjectStream('artifacts', storagePath, resp.body, {
                contentType: resp.headers.get('content-type') || 'application/octet-stream',
            });
            modelStoragePath = storagePath;
            modelFileName = fileName;
        }
    }

    const logStoragePath = snapshot.logStoragePath || `runner-outputs/${chatId}/${taskId}/run.log`;
    let logBuffer: Buffer | null = null;
    if (force || !(await storageExists('artifacts', logStoragePath))) {
        try {
            const resp = await fetchRunnerBinary(taskId, 'log');
            const body = await resp.arrayBuffer();
            logBuffer = Buffer.from(body);
            await uploadStorageObject('artifacts', logStoragePath, logBuffer, { contentType: 'text/plain' });
        } catch {
            warnings.push('Log download failed.');
        }
    }
    if (!logBuffer) {
        try {
            logBuffer = await downloadStorageObject('artifacts', logStoragePath);
        } catch {
            logBuffer = null;
        }
    }

    const metadataStoragePath = snapshot.metadataStoragePath || `runner-outputs/${chatId}/${taskId}/metadata.json`;
    let metadataBuffer: Buffer | null = null;
    let metadataData: Record<string, unknown> | null = null;
    if (force || !(await storageExists('artifacts', metadataStoragePath))) {
        try {
            const meta = await fetchRunnerJson(taskId, 'metadata');
            metadataData = meta;
            metadataBuffer = Buffer.from(JSON.stringify(meta, null, 2), 'utf-8');
            await uploadStorageObject('artifacts', metadataStoragePath, metadataBuffer, {
                contentType: 'application/json',
            });
        } catch {
            warnings.push('Metadata download failed.');
        }
    }
    if (!metadataBuffer) {
        try {
            metadataBuffer = await downloadStorageObject('artifacts', metadataStoragePath);
        } catch {
            metadataBuffer = null;
        }
    }
    if (!metadataData && metadataBuffer) {
        try {
            metadataData = JSON.parse(metadataBuffer.toString('utf-8')) as Record<string, unknown>;
        } catch {
            metadataData = null;
        }
    }

    const reportStoragePath = `runner-outputs/${chatId}/${taskId}/training-report.pdf`;
    let reportBuffer: Buffer;
    const buildReport = async () =>
        buildTrainingReportPdf({
            taskId,
            status: typeof statusData?.status === 'string' ? statusData.status : snapshot.status,
            inputName: snapshot.inputName,
            scriptName: snapshot.scriptName,
            expectedOutputName: snapshot.expectedOutputName,
            submittedAt: snapshot.submittedAt,
            completedAt,
            modelFileName,
            modelStoragePath,
            logStoragePath,
            metadataStoragePath,
            logSnippet: formatLogSnippet(logBuffer),
            metadataExcerpt: formatMetadataExcerpt(metadataData),
        });

    if (!force && (await storageExists('artifacts', reportStoragePath))) {
        try {
            reportBuffer = await downloadStorageObject('artifacts', reportStoragePath);
        } catch {
            reportBuffer = await buildReport();
            await uploadStorageObject('artifacts', reportStoragePath, reportBuffer, { contentType: 'application/pdf' });
        }
    } else {
        reportBuffer = await buildReport();
        await uploadStorageObject('artifacts', reportStoragePath, reportBuffer, { contentType: 'application/pdf' });
    }

    const manifest = {
        taskId,
        createdAt: new Date().toISOString(),
        modelStoragePath,
        logStoragePath,
        metadataStoragePath,
        reportStoragePath,
    };

    let bundleStoragePath: string | null = null;
    try {
        bundleStoragePath = await buildBundleZip({
            chatId,
            taskId,
            modelStoragePath,
            modelFileName,
            reportBuffer,
            logBuffer,
            metadataBuffer,
            manifest,
            force,
        });
    } catch {
        warnings.push('Bundle creation failed.');
    }

    const result: TrainingFinalizeResult = {
        modelStoragePath,
        modelFileName,
        logStoragePath,
        metadataStoragePath,
        reportStoragePath,
        bundleStoragePath: bundleStoragePath || undefined,
        requestedBackend: typeof metadataData?.requested_backend === 'string' ? metadataData.requested_backend : undefined,
        executionBackend: typeof metadataData?.execution_backend === 'string' ? metadataData.execution_backend : undefined,
        wandbProject: (() => {
            const wandb = metadataData?.wandb;
            if (!wandb || typeof wandb !== 'object') return undefined;
            const project = (wandb as Record<string, unknown>).project;
            return typeof project === 'string' ? project : undefined;
        })(),
        wandbRunUrl: (() => {
            const wandb = metadataData?.wandb;
            if (!wandb || typeof wandb !== 'object') return undefined;
            const runUrl =
                (wandb as Record<string, unknown>).run_url
                ?? (wandb as Record<string, unknown>).runUrl;
            return typeof runUrl === 'string' ? runUrl : undefined;
        })(),
        warnings: warnings.length > 0 ? warnings : undefined,
    };

    if (modelStoragePath && (await storageExists('artifacts', modelStoragePath))) {
        result.modelUrl = await createStorageSignedUrl('artifacts', modelStoragePath, 600).catch(() => undefined);
        result.downloadUrl = result.modelUrl;
    }
    if (logStoragePath && (await storageExists('artifacts', logStoragePath))) {
        result.logUrl = await createStorageSignedUrl('artifacts', logStoragePath, 600).catch(() => undefined);
    }
    if (metadataStoragePath && (await storageExists('artifacts', metadataStoragePath))) {
        result.metadataUrl = await createStorageSignedUrl('artifacts', metadataStoragePath, 600).catch(() => undefined);
    }
    if (reportStoragePath && (await storageExists('artifacts', reportStoragePath))) {
        result.reportUrl = await createStorageSignedUrl('artifacts', reportStoragePath, 600).catch(() => undefined);
    }
    if (bundleStoragePath && (await storageExists('artifacts', bundleStoragePath))) {
        result.bundleUrl = await createStorageSignedUrl('artifacts', bundleStoragePath, 600).catch(() => undefined);
    }

    return result;
}
