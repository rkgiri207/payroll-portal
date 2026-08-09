/**
 * Indian mobile number normalization and validation.
 *
 * CANONICAL FORMAT: 10-digit Indian number, e.g. 9876543210
 * E.164 FORMAT:     91-prefixed 12-digit, e.g. 919876543210 (for WhatsApp API)
 *
 * This utility is the single source of truth used by:
 *   - Payroll upload validation
 *   - Future WhatsApp sending module
 */

export type MobileValidationResult =
  | { valid: true;  normalized: string; e164: string }
  | { valid: false; normalized: string | null; reason: string };

/**
 * Normalize a raw mobile string to a plain 10-digit Indian number.
 * Returns the digits-only string (may be wrong length — caller validates).
 *
 * Handles all common formats:
 *   9876543210       → 9876543210
 *   +91 9876543210   → 9876543210
 *   +919876543210    → 9876543210
 *   91-9876543210    → 9876543210
 *   91 9876543210    → 9876543210
 */
export function normalizeIndianMobile(raw: string): string {
  let s = raw.trim();

  // 1. Strip explicit +91 prefix (with optional space/dash separator)
  s = s.replace(/^\+91[\s-]?/, '');

  // 2. Remove all non-digit characters to get pure digits
  const digits = s.replace(/\D/g, '');

  // 3. If we have 12 digits and the string looks like 91 + valid Indian mobile (6-9 prefix),
  //    strip the 91 country code. This covers: 91-9876543210, 91 9876543210, 919876543210.
  if (digits.length === 12 && /^91[6-9]/.test(digits)) {
    return digits.slice(2);
  }

  return digits;
}

/**
 * Validate a raw mobile number string.
 *
 * Rules (Indian mobile numbers):
 *  - Exactly 10 digits after normalization
 *  - First digit must be 6, 7, 8, or 9
 *  - No alphabetic characters (checked before digit-stripping)
 *  - No obviously invalid patterns (all same digit, e.g. 9999999999)
 *
 * Missing / blank input → { valid: false, reason: 'missing' }  (caller treats as warning)
 */
export function validateIndianMobile(raw: string): MobileValidationResult {
  const trimmed = raw?.trim() ?? '';

  // ── Missing ────────────────────────────────────────────────────────────────
  if (!trimmed) {
    return { valid: false, normalized: null, reason: 'missing' };
  }

  // ── Alpha characters ───────────────────────────────────────────────────────
  if (/[a-zA-Z]/.test(trimmed)) {
    return { valid: false, normalized: null, reason: 'Mobile number contains invalid characters' };
  }

  // ── Normalize ──────────────────────────────────────────────────────────────
  const digits = normalizeIndianMobile(trimmed);

  // ── Length ─────────────────────────────────────────────────────────────────
  if (digits.length !== 10) {
    return {
      valid: false,
      normalized: digits || null,
      reason: 'Mobile number must contain 10 digits',
    };
  }

  // ── Valid starting digit ───────────────────────────────────────────────────
  if (!/^[6-9]/.test(digits)) {
    return {
      valid: false,
      normalized: digits,
      reason: 'Invalid Indian mobile number',
    };
  }

  // ── Obviously invalid repeated patterns ────────────────────────────────────
  if (/^(.)\1{9}$/.test(digits)) {
    return {
      valid: false,
      normalized: digits,
      reason: 'Invalid Indian mobile number',
    };
  }

  return {
    valid: true,
    normalized: digits,
    e164: `91${digits}`,
  };
}
