import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateIndianMobile } from '../mobileValidator';

/**
 * Verify Meta's X-Hub-Signature-256 header against the RAW request body.
 * Returns false (never throws) for a missing, malformed or wrong signature.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(provided, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Normalise an Indian mobile number to the WhatsApp format (digits with country code,
 * e.g. 919876543210) using the existing validator. Returns null if it is not valid.
 */
export function toWhatsAppNumber(raw: string): string | null {
  const result = validateIndianMobile(raw);
  return result.valid ? result.e164 : null;
}

/** '919876543210' -> '********3210'. Used for logs; full numbers are never logged. */
export function maskPhone(value: string): string {
  return value.length <= 4 ? '****' : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}
