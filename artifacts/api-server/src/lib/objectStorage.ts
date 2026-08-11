import { randomUUID } from 'crypto';

export const STORAGE_BUCKETS = {
  companyAssets: 'company-assets',
  payrollFiles: 'payroll-files',
  payslips: 'payslips',
} as const;

type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function storageUrl(path: string): string {
  return `${requiredEnv('SUPABASE_URL').replace(/\/$/, '')}/storage/v1${path}`;
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function storageRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(storageUrl(path), {
    ...init,
    headers: serviceHeaders(init.headers as Record<string, string> | undefined),
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Supabase Storage request failed (${response.status}): ${detail}`);
  }
  return response;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
    this.name = 'ObjectNotFoundError';
  }
}

class SupabaseObjectFile {
  constructor(
    readonly bucket: StorageBucket,
    readonly path: string,
  ) {}

  async download(): Promise<[Buffer]> {
    const response = await storageRequest(
      `/object/${encodeURIComponent(this.bucket)}/${encodeObjectPath(this.path)}`,
    );
    return [Buffer.from(await response.arrayBuffer())];
  }
}

export class ObjectStorageService {
  async uploadObject(bucket: StorageBucket, path: string, data: Buffer, contentType: string): Promise<string> {
    if (!path || path.includes('..') || path.startsWith('/')) throw new Error('Invalid storage path');
    await storageRequest(`/object/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
      body: data,
    });
    return `/objects/${bucket}/${path}`;
  }

  async deleteObject(objectPath: string, fallbackBucket: StorageBucket): Promise<void> {
    const parsed = parseObjectPath(objectPath, fallbackBucket);
    await storageRequest(`/object/${encodeURIComponent(parsed.bucket)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [parsed.path] }),
    });
  }
  async getObjectEntityUploadURL(
    bucket: StorageBucket = STORAGE_BUCKETS.companyAssets,
    originalName?: string,
  ): Promise<{ uploadURL: string; objectPath: string }> {
    const extension = safeExtension(originalName);
    const path = `uploads/${randomUUID()}${extension}`;
    const response = await storageRequest(
      `/object/upload/sign/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-upsert': 'false' },
        body: '{}',
      },
    );
    const data = (await response.json()) as { url?: string; signedURL?: string };
    const signedPath = data.url ?? data.signedURL;
    if (!signedPath) throw new Error('Supabase Storage did not return a signed upload URL');

    return {
      uploadURL: signedPath.startsWith('http')
        ? signedPath
        : `${storageUrl('')}${signedPath.startsWith('/') ? '' : '/'}${signedPath}`,
      objectPath: `/objects/${bucket}/${path}`,
    };
  }

  async getObjectEntityFile(
    objectPath: string,
    fallbackBucket: StorageBucket = STORAGE_BUCKETS.companyAssets,
  ): Promise<SupabaseObjectFile> {
    const parsed = parseObjectPath(objectPath, fallbackBucket);
    try {
      await storageRequest(
        `/object/info/${encodeURIComponent(parsed.bucket)}/${encodeObjectPath(parsed.path)}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('(404)')) {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
    return new SupabaseObjectFile(parsed.bucket, parsed.path);
  }

  async downloadObject(file: SupabaseObjectFile, cacheTtlSec = 3600): Promise<Response> {
    const response = await storageRequest(
      `/object/${encodeURIComponent(file.bucket)}/${encodeObjectPath(file.path)}`,
    );
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `private, max-age=${cacheTtlSec}`);
    return new Response(response.body, { status: response.status, headers });
  }
}

function parseObjectPath(
  objectPath: string,
  fallbackBucket: StorageBucket,
): { bucket: StorageBucket; path: string } {
  if (!objectPath.startsWith('/objects/')) throw new ObjectNotFoundError();
  const parts = objectPath.slice('/objects/'.length).split('/').filter(Boolean);
  const knownBuckets = Object.values(STORAGE_BUCKETS) as string[];
  const bucket = knownBuckets.includes(parts[0]) ? (parts.shift() as StorageBucket) : fallbackBucket;
  const path = parts.join('/');
  if (!path || path.includes('..')) throw new ObjectNotFoundError();
  return { bucket, path };
}

function encodeObjectPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function safeExtension(name?: string): string {
  const match = name?.toLowerCase().match(/\.(png|jpe?g|webp|gif|xlsx?|xls)$/);
  return match ? match[0] : '';
}
