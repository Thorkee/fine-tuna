import 'server-only';

import {
    CopyObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

type StorageConfig = {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
};

function getRequiredEnv(name: keyof NodeJS.ProcessEnv): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing ${name} environment variable`);
    }
    return value;
}

function getStorageConfig(): StorageConfig {
    return {
        endpoint: getRequiredEnv('SUPABASE_STORAGE_URL'),
        region: getRequiredEnv('SUPABASE_STORAGE_REGION'),
        accessKeyId: getRequiredEnv('SUPABASE_STORAGE_KEY_ID'),
        secretAccessKey: getRequiredEnv('SUPABASE_STORAGE_SECRET'),
    };
}

let cachedClient: S3Client | null = null;

function isWebReadableStream(body: unknown): body is NodeReadableStream {
    return typeof body === 'object' && body !== null && typeof (body as { getReader?: unknown }).getReader === 'function';
}

function getStorageClient(): S3Client {
    if (cachedClient) return cachedClient;
    const config = getStorageConfig();
    cachedClient = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: true,
    });
    return cachedClient;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
    if (!body) {
        throw new Error('Empty storage response body');
    }
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === 'string') return Buffer.from(body);
    if (body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    if (isWebReadableStream(body)) {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
        }
        return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    }
    throw new Error('Unsupported storage response body type');
}

function toNodeReadable(body: unknown): Readable {
    if (!body) {
        throw new Error('Empty storage response body');
    }
    if (body instanceof Readable) return body;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Readable.from([body]);
    if (typeof body === 'string') return Readable.from([body]);
    if (isWebReadableStream(body)) {
        if (typeof Readable.fromWeb !== 'function') {
            throw new Error('Readable.fromWeb is not available in this runtime');
        }
        return Readable.fromWeb(body);
    }
    throw new Error('Unsupported stream body type');
}

export async function downloadStorageObject(bucket: string, key: string): Promise<Buffer> {
    const client = getStorageClient();
    const response = await client.send(
        new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        })
    );
    return bodyToBuffer(response.Body);
}

export async function downloadStorageObjectStream(bucket: string, key: string): Promise<Readable> {
    const client = getStorageClient();
    const response = await client.send(
        new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        })
    );
    return toNodeReadable(response.Body);
}

export type StorageObjectHead = {
    contentType?: string;
    contentLength?: number;
    lastModified?: string;
    etag?: string;
};

export async function headStorageObject(bucket: string, key: string): Promise<StorageObjectHead> {
    const client = getStorageClient();
    const response = await client.send(
        new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
        })
    );
    return {
        contentType: typeof response.ContentType === 'string' ? response.ContentType : undefined,
        contentLength: typeof response.ContentLength === 'number' ? response.ContentLength : undefined,
        lastModified: response.LastModified instanceof Date ? response.LastModified.toISOString() : undefined,
        etag: typeof response.ETag === 'string' ? response.ETag : undefined,
    };
}

type UploadOptions = {
    contentType?: string;
};

export async function uploadStorageObject(
    bucket: string,
    key: string,
    body: Buffer,
    options: UploadOptions = {}
): Promise<void> {
    const client = getStorageClient();
    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: options.contentType,
        })
    );
}

export async function uploadStorageObjectStream(
    bucket: string,
    key: string,
    body: Readable | ReadableStream | Uint8Array | Buffer | string,
    options: UploadOptions = {}
): Promise<void> {
    const client = getStorageClient();
    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: toNodeReadable(body),
            ContentType: options.contentType,
        })
    );
}

export async function createStorageSignedUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number
): Promise<string> {
    const client = getStorageClient();
    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    });
    return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

export type ListedStorageObject = {
    key: string;
    size?: number;
    lastModified?: string;
};

export async function listStorageObjects(bucket: string, prefix: string): Promise<ListedStorageObject[]> {
    const client = getStorageClient();
    const out: ListedStorageObject[] = [];

    let continuationToken: string | undefined = undefined;
    while (true) {
        const response: ListObjectsV2CommandOutput = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                MaxKeys: 1000,
            })
        );

        const contents = Array.isArray(response.Contents) ? response.Contents : [];
        for (const item of contents) {
            const key = typeof item?.Key === 'string' ? item.Key : '';
            if (!key) continue;
            out.push({
                key,
                size: typeof item?.Size === 'number' ? item.Size : undefined,
                lastModified: item?.LastModified instanceof Date ? item.LastModified.toISOString() : undefined,
            });
        }

        if (!response.IsTruncated) break;
        continuationToken =
            typeof response.NextContinuationToken === 'string' ? response.NextContinuationToken : undefined;
        if (!continuationToken) break;
    }

    return out;
}

function assertNonEmptyPrefix(prefix: string) {
    if (!prefix || !prefix.trim()) {
        throw new Error('Refusing to delete storage objects with an empty prefix');
    }
}

async function deleteStorageKeys(bucket: string, keys: string[]): Promise<number> {
    const client = getStorageClient();
    const normalized = keys
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0);
    if (normalized.length === 0) return 0;

    const response = await client.send(
        new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: normalized.map((Key) => ({ Key })),
                Quiet: true,
            },
        })
    );

    const errors = Array.isArray(response.Errors) ? response.Errors : [];
    if (errors.length > 0) {
        const first = errors[0];
        const firstKey = typeof first?.Key === 'string' ? first.Key : 'unknown';
        const firstCode = typeof first?.Code === 'string' ? first.Code : 'UnknownError';
        throw new Error(`Failed to delete ${errors.length} storage object(s) from ${bucket} (first: ${firstCode} @ ${firstKey})`);
    }

    return normalized.length;
}

export async function deleteStorageObject(bucket: string, key: string): Promise<void> {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed) return;
    await deleteStorageKeys(bucket, [trimmed]);
}

function encodeCopySource(bucket: string, key: string): string {
    // S3 expects URL-encoded source; encode key defensively.
    return `${bucket}/${encodeURIComponent(key)}`;
}

export async function copyStorageObject(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string
): Promise<void> {
    const srcKey = sourceKey.trim();
    const dstKey = destKey.trim();
    if (!srcKey || !dstKey) {
        throw new Error('Missing storage key for copy');
    }
    if (sourceBucket === destBucket && srcKey === dstKey) {
        return;
    }

    const client = getStorageClient();
    try {
        await client.send(
            new CopyObjectCommand({
                Bucket: destBucket,
                Key: dstKey,
                CopySource: encodeCopySource(sourceBucket, srcKey),
                MetadataDirective: 'COPY',
            })
        );
        return;
    } catch {
        // Fall back to download+upload (works even if CopyObject isn't supported).
    }

    const head = await headStorageObject(sourceBucket, srcKey).catch(() => ({} as StorageObjectHead));
    const buffer = await downloadStorageObject(sourceBucket, srcKey);
    await uploadStorageObject(destBucket, dstKey, buffer, {
        contentType: head.contentType,
    });
}

export async function moveStorageObject(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string
): Promise<void> {
    await copyStorageObject(sourceBucket, sourceKey, destBucket, destKey);
    await deleteStorageObject(sourceBucket, sourceKey);
}

export async function deleteStoragePrefix(bucket: string, prefix: string): Promise<{ deleted: number }> {
    assertNonEmptyPrefix(prefix);
    const client = getStorageClient();

    let deleted = 0;
    let continuationToken: string | undefined = undefined;
    while (true) {
        const list: ListObjectsV2CommandOutput = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                MaxKeys: 1000,
            })
        );

        const keys = (Array.isArray(list.Contents) ? list.Contents : [])
            .map((item) => (typeof item?.Key === 'string' ? item.Key : ''))
            .filter((k) => k.length > 0);

        if (keys.length > 0) {
            deleted += await deleteStorageKeys(bucket, keys);
        }

        if (!list.IsTruncated) break;
        continuationToken = typeof list.NextContinuationToken === 'string' ? list.NextContinuationToken : undefined;
        if (!continuationToken) break;
    }

    return { deleted };
}
