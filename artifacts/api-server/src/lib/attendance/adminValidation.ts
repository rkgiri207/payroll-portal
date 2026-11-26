/**
 * Validation for everything an admin types into the attendance setup screens. Each function
 * returns either the cleaned value or a plain-language error that the screen can show as is.
 */
import { toWhatsAppNumber } from './webhookSecurity';
import { timeToMinutes } from './time';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function text(value: unknown, label: string, max: number, required: boolean): Result<string | null> {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return required ? fail(`${label} is required`) : ok(null);
  }
  if (typeof value !== 'string') return fail(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) return fail(`${label} must be at most ${max} characters`);
  return ok(trimmed);
}

// ── Campuses ──────────────────────────────────────────────────────────────────
export interface CampusInput {
  code: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
  requiredAccuracyM: number | null;
  isActive: boolean;
}

/** `defaults` supplies the radius when the admin leaves it blank (a setting, not hardcoded). */
export function validateCampus(body: unknown, defaults: { geofenceRadiusM: number }): Result<CampusInput> {
  if (!isRecord(body)) return fail('Send the campus details');
  const code = text(body.code, 'Campus code', 20, true);
  if (!code.ok) return code;
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(code.value!)) return fail('Campus code may use letters, numbers, - and _ only');
  const name = text(body.name, 'Campus name', 100, true);
  if (!name.ok) return name;
  const address = text(body.address, 'Address', 300, false);
  if (!address.ok) return address;

  const hasLat = body.latitude !== undefined && body.latitude !== null && body.latitude !== '';
  const hasLng = body.longitude !== undefined && body.longitude !== null && body.longitude !== '';
  if (hasLat !== hasLng) return fail('Enter both latitude and longitude, or leave both empty');
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (hasLat && hasLng) {
    latitude = Number(body.latitude);
    longitude = Number(body.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return fail('Latitude must be between -90 and 90');
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail('Longitude must be between -180 and 180');
  }

  const radius = body.geofenceRadiusM === undefined || body.geofenceRadiusM === null || body.geofenceRadiusM === ''
    ? defaults.geofenceRadiusM : Number(body.geofenceRadiusM);
  if (!isInt(radius, 5, 500)) return fail('Geofence radius must be a whole number from 5 to 500 metres');

  let requiredAccuracyM: number | null = null;
  if (body.requiredAccuracyM !== undefined && body.requiredAccuracyM !== null && body.requiredAccuracyM !== '') {
    requiredAccuracyM = Number(body.requiredAccuracyM);
    if (!isInt(requiredAccuracyM, 3, 100)) return fail('Required GPS accuracy must be a whole number from 3 to 100 metres');
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return fail('Active must be true or false');

  return ok({
    code: code.value!.toUpperCase(), name: name.value!, address: address.value,
    latitude, longitude, geofenceRadiusM: radius, requiredAccuracyM, isActive: body.isActive !== false,
  });
}

// ── Shifts ────────────────────────────────────────────────────────────────────
export interface ShiftInput {
  loginTime: string;     // HH:MM
  logoutTime: string;    // HH:MM
  graceMinutes: number;
  weekdays: number[];    // 0 = Sunday ... 6 = Saturday
  effectiveFrom: string; // YYYY-MM-DD
}

const hhmm = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export function validateShift(body: unknown, defaults: { graceMinutes: number }): Result<ShiftInput> {
  if (!isRecord(body)) return fail('Send the shift details');
  if (!hhmm(body.loginTime)) return fail('Login time must look like 09:00');
  if (!hhmm(body.logoutTime)) return fail('Logout time must look like 16:00');
  if (timeToMinutes(body.logoutTime) <= timeToMinutes(body.loginTime)) return fail('Logout time must be after login time');

  const grace = body.graceMinutes === undefined || body.graceMinutes === null || body.graceMinutes === ''
    ? defaults.graceMinutes : Number(body.graceMinutes);
  if (!isInt(grace, 0, 120)) return fail('Grace minutes must be a whole number from 0 to 120');

  if (!Array.isArray(body.weekdays) || body.weekdays.length === 0) return fail('Choose at least one working day');
  const days = [...new Set(body.weekdays.map(Number))];
  if (!days.every(d => isInt(d, 0, 6))) return fail('Working days must be between Sunday and Saturday');
  if (!isValidDate(body.effectiveFrom)) return fail('Effective-from date must look like 2026-03-02');

  return ok({
    loginTime: body.loginTime, logoutTime: body.logoutTime, graceMinutes: grace,
    weekdays: days.sort((a, b) => a - b), effectiveFrom: body.effectiveFrom,
  });
}

// ── Employee registration and assignments ─────────────────────────────────────
export interface RegistrationInput {
  /** Digits with country code (e.g. 919849136605), or null to clear. */
  whatsapp: string | null;
  attendanceApplicable: boolean;
}

export function validateRegistration(body: unknown): Result<RegistrationInput> {
  if (!isRecord(body)) return fail('Send the registration details');
  let whatsapp: string | null = null;
  if (body.whatsapp !== undefined && body.whatsapp !== null && String(body.whatsapp).trim() !== '') {
    whatsapp = typeof body.whatsapp === 'string' ? toWhatsAppNumber(body.whatsapp) : null;
    if (!whatsapp) return fail('Enter a valid 10-digit Indian mobile number (with or without +91)');
  }
  if (typeof body.attendanceApplicable !== 'boolean') return fail('Attendance applicable must be true or false');
  return ok({ whatsapp, attendanceApplicable: body.attendanceApplicable });
}

export interface AssignmentInput {
  campusId: number;
  kind: 'PRIMARY' | 'TEMPORARY';
  mode: 'REPLACE' | 'ADDITIONAL';
  startDate: string;
  endDate: string | null;
  note: string | null;
}

export function validateAssignment(body: unknown): Result<AssignmentInput> {
  if (!isRecord(body)) return fail('Send the assignment details');
  if (!isInt(body.campusId, 1, 2_147_483_647)) return fail('Choose a campus');
  if (body.kind !== 'PRIMARY' && body.kind !== 'TEMPORARY') return fail('Choose primary or temporary');
  if (!isValidDate(body.startDate)) return fail('Start date must look like 2026-03-02');

  let endDate: string | null = null;
  if (body.endDate !== undefined && body.endDate !== null && body.endDate !== '') {
    if (!isValidDate(body.endDate)) return fail('End date must look like 2026-03-02');
    endDate = body.endDate;
  }
  if (endDate && endDate < body.startDate) return fail('End date cannot be before the start date');
  if (body.kind === 'TEMPORARY' && !endDate) return fail('A temporary assignment needs an end date');

  let mode: 'REPLACE' | 'ADDITIONAL' = 'REPLACE';
  if (body.kind === 'TEMPORARY' && body.mode !== undefined) {
    if (body.mode !== 'REPLACE' && body.mode !== 'ADDITIONAL') return fail('Mode must be replace or additional');
    mode = body.mode;
  }
  const note = text(body.note, 'Note', 200, false);
  if (!note.ok) return note;
  return ok({ campusId: body.campusId, kind: body.kind, mode, startDate: body.startDate, endDate, note: note.value });
}

// ── Reviews ───────────────────────────────────────────────────────────────────
export function validateReview(body: unknown): Result<{ status: 'APPROVED' | 'REJECTED'; note: string | null }> {
  if (!isRecord(body)) return fail('Send the review');
  if (body.status !== 'APPROVED' && body.status !== 'REJECTED') return fail('Choose approve or reject');
  const note = text(body.note, 'Note', 300, body.status === 'REJECTED');
  if (!note.ok) return note;
  return ok({ status: body.status, note: note.value });
}

export function validateExceptionReview(body: unknown): Result<{ status: 'REVIEWED' | 'RESOLVED'; note: string | null }> {
  if (!isRecord(body)) return fail('Send the review');
  if (body.status !== 'REVIEWED' && body.status !== 'RESOLVED') return fail('Choose reviewed or resolved');
  const note = text(body.note, 'Note', 300, false);
  if (!note.ok) return note;
  return ok({ status: body.status, note: note.value });
}

/** A positive whole number from a URL or body, or null. */
export function toId(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return isInt(n, 1, 2_147_483_647) ? n : null;
}
