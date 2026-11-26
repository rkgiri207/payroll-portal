/**
 * Private selfie storage (bucket `attendance-selfies`). It talks to Supabase Storage with the
 * server-only service-role key, the same way the rest of the API does, but is a separate,
 * self-contained client so the existing storage code is left untouched.
 *
 * Selfies are never public. Admins view them only through short-lived signed URLs, and every
 * view is written to the audit log by the caller. Error messages never include keys or URLs.
 */

export const SELFIE_BUCKET = 'attendance-selfies';

export interface SelfieStorage {
  upload(path: string, bytes: Buffer, contentType: 'image/jpeg' | 'image/webp'): Promise<void>;
  remove(path: string): Promise<void>;
  signedUrl(path: string, ttlSeconds: number): Promise<string>;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function createSelfieStorage(env: NodeJS.ProcessEnv = process.env): SelfieStorage {
  const baseUrl = () => {
    const url = env.SUPABASE_URL?.trim().replace(/\/$/, '');
    if (!url) throw new Error('SUPABASE_URL is not configured');
    return `${url}/storage/v1`;
  };
  const headers = (extra: Record<string, string> = {}) => {
    const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
  };

  return {
    async upload(path, bytes, contentType) {
      const response = await fetch(`${baseUrl()}/object/${SELFIE_BUCKET}/${encodePath(path)}`, {
        method: 'POST',
        headers: headers({ 'Content-Type': contentType, 'x-upsert': 'false' }),
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Selfie upload failed (${response.status})`);
    },

    async remove(path) {
      const response = await fetch(`${baseUrl()}/object/${SELFIE_BUCKET}/${encodePath(path)}`, {
        method: 'DELETE',
        headers: headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok && response.status !== 404) throw new Error(`Selfie delete failed (${response.status})`);
    },

    async signedUrl(path, ttlSeconds) {
      const response = await fetch(`${baseUrl()}/object/sign/${SELFIE_BUCKET}/${encodePath(path)}`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: Math.min(Math.max(Math.floor(ttlSeconds), 10), 3600) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Could not create a selfie link (${response.status})`);
      const body = (await response.json().catch(() => null)) as { signedURL?: string } | null;
      if (!body?.signedURL) throw new Error('Could not create a selfie link');
      return `${baseUrl()}${body.signedURL}`;
    },
  };
}

export type ImageKind = { contentType: 'image/jpeg' | 'image/webp'; extension: 'jpg' | 'webp' };

/** Decode a base64 (or data-URL) image and check it really is a small JPEG or WebP. */
export function decodeSelfie(input: unknown, maxBytes = 900_000): { bytes: Buffer; kind: ImageKind } | null {
  if (typeof input !== 'string' || input.length < 100 || input.length > Math.ceil(maxBytes * 1.4) + 200) return null;
  const base64 = input.replace(/^data:image\/(?:jpeg|jpg|webp);base64,/i, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 1_000 || bytes.length > maxBytes) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, kind: { contentType: 'image/jpeg', extension: 'jpg' } };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { bytes, kind: { contentType: 'image/webp', extension: 'webp' } };
  }
  return null;
}
