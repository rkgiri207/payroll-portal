import type { Queryable } from './db';

export type AlertMode = 'individual' | 'digest' | 'mute_normal';

export interface AttendanceSettings {
  defaultGraceMinutes: number;
  defaultGeofenceRadiusM: number;
  requiredGpsAccuracyM: number;
  tokenTtlMinutes: number;
  maxFailedAttempts: number;
  missingOutAfterMinutes: number;
  selfieRetentionDays: number;
  directorWhatsapp: string | null;
  alertMode: AlertMode;
  digestIntervalMinutes: number;
  linkBaseUrl: string;
  templateLanguage: string;
  templates: { checkin: string; checkout: string; late: string; exception: string; missingOut: string; digest: string };
}

/** Fallbacks used only if a row is missing or invalid; the real values live in the database. */
export const SETTING_DEFAULTS: AttendanceSettings = {
  defaultGraceMinutes: 10,
  defaultGeofenceRadiusM: 25,
  requiredGpsAccuracyM: 10,
  tokenTtlMinutes: 5,
  maxFailedAttempts: 3,
  missingOutAfterMinutes: 60,
  selfieRetentionDays: 90,
  directorWhatsapp: null,
  alertMode: 'individual',
  digestIntervalMinutes: 60,
  linkBaseUrl: '',
  templateLanguage: 'en',
  templates: {
    checkin: 'attendance_checkin',
    checkout: 'attendance_checkout',
    late: 'attendance_late',
    exception: 'attendance_exception',
    missingOut: 'attendance_missing_out',
    digest: 'attendance_digest',
  },
};

interface Rule {
  validate(value: unknown): boolean;
  description: string;
}

const intBetween = (min: number, max: number): Rule => ({
  validate: v => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max,
  description: `a whole number from ${min} to ${max}`,
});
const templateName: Rule = {
  validate: v => typeof v === 'string' && /^[a-z0-9_]{1,512}$/.test(v),
  description: 'lowercase letters, digits and underscores',
};

/** Every editable setting and what values it accepts (used by the admin screen API). */
export const SETTING_RULES: Record<string, Rule> = {
  default_grace_minutes: intBetween(0, 120),
  default_geofence_radius_m: intBetween(5, 500),
  required_gps_accuracy_m: intBetween(3, 100),
  token_ttl_minutes: intBetween(1, 30),
  max_failed_attempts: intBetween(1, 10),
  missing_out_after_minutes: intBetween(0, 720),
  selfie_retention_days: intBetween(1, 3650),
  digest_interval_minutes: intBetween(5, 1440),
  director_whatsapp_e164: {
    validate: v => v === null || (typeof v === 'string' && /^[1-9][0-9]{7,14}$/.test(v)),
    description: 'digits with country code (e.g. 919876543210), or empty',
  },
  alert_mode: {
    validate: v => v === 'individual' || v === 'digest' || v === 'mute_normal',
    description: 'individual, digest or mute_normal',
  },
  attendance_link_base_url: {
    validate: v => {
      if (v === '') return true;
      if (typeof v !== 'string') return false;
      try {
        const url = new URL(v);
        return url.protocol === 'https:' && !url.search && !url.hash;
      } catch {
        return false;
      }
    },
    description: 'an https:// address without a query string, or empty to use the app address',
  },
  whatsapp_template_language: {
    validate: v => typeof v === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(v),
    description: 'a language code such as en or en_GB',
  },
  template_checkin: templateName,
  template_checkout: templateName,
  template_late: templateName,
  template_exception: templateName,
  template_missing_out: templateName,
  template_digest: templateName,
};

/** A short hint for the admin screen about what a setting accepts. */
export function settingHint(key: string): string | null {
  return SETTING_RULES[key]?.description ?? null;
}

/** Returns an error message if the value is not acceptable, otherwise null. */
export function validateSettingValue(key: string, value: unknown): string | null {
  const rule = SETTING_RULES[key];
  if (!rule) return `Unknown setting: ${key}`;
  return rule.validate(value) ? null : `${key} must be ${rule.description}`;
}

/** Build the typed settings from raw rows, falling back to defaults for missing/invalid values. */
export function parseSettings(rows: { key: string; value: unknown }[]): AttendanceSettings {
  const raw = new Map(rows.map(row => [row.key, row.value]));
  const pick = <T>(key: string, fallback: T): T => {
    if (!raw.has(key)) return fallback;
    const value = raw.get(key);
    return validateSettingValue(key, value) === null ? (value as T) : fallback;
  };
  const d = SETTING_DEFAULTS;
  return {
    defaultGraceMinutes: pick('default_grace_minutes', d.defaultGraceMinutes),
    defaultGeofenceRadiusM: pick('default_geofence_radius_m', d.defaultGeofenceRadiusM),
    requiredGpsAccuracyM: pick('required_gps_accuracy_m', d.requiredGpsAccuracyM),
    tokenTtlMinutes: pick('token_ttl_minutes', d.tokenTtlMinutes),
    maxFailedAttempts: pick('max_failed_attempts', d.maxFailedAttempts),
    missingOutAfterMinutes: pick('missing_out_after_minutes', d.missingOutAfterMinutes),
    selfieRetentionDays: pick('selfie_retention_days', d.selfieRetentionDays),
    directorWhatsapp: pick<string | null>('director_whatsapp_e164', d.directorWhatsapp),
    alertMode: pick<AlertMode>('alert_mode', d.alertMode),
    digestIntervalMinutes: pick('digest_interval_minutes', d.digestIntervalMinutes),
    linkBaseUrl: pick('attendance_link_base_url', d.linkBaseUrl),
    templateLanguage: pick('whatsapp_template_language', d.templateLanguage),
    templates: {
      checkin: pick('template_checkin', d.templates.checkin),
      checkout: pick('template_checkout', d.templates.checkout),
      late: pick('template_late', d.templates.late),
      exception: pick('template_exception', d.templates.exception),
      missingOut: pick('template_missing_out', d.templates.missingOut),
      digest: pick('template_digest', d.templates.digest),
    },
  };
}

export async function loadSettings(q: Queryable): Promise<AttendanceSettings> {
  const { rows } = await q.query<{ key: string; value: unknown }>(
    'select key, value from attendance_settings',
  );
  return parseSettings(rows);
}

export async function loadRawSettings(
  q: Queryable,
): Promise<{ key: string; value: unknown; description: string | null }[]> {
  const { rows } = await q.query<{ key: string; value: unknown; description: string | null }>(
    'select key, value, description from attendance_settings order by key',
  );
  // Internal bookkeeping rows (digest_last_sent_at, sweeper_last_run_at) are not editable.
  return rows.filter(row => row.key in SETTING_RULES);
}

/** Update one setting after validating it. Returns false if the key does not exist. */
export async function updateSetting(
  q: Queryable,
  key: string,
  value: unknown,
  userId: number | null,
): Promise<{ ok: true; oldValue: unknown } | { ok: false; error: string }> {
  const error = validateSettingValue(key, value);
  if (error) return { ok: false, error };
  const existing = await q.query<{ value: unknown }>(
    'select value from attendance_settings where key = $1',
    [key],
  );
  if (existing.rows.length === 0) return { ok: false, error: `Unknown setting: ${key}` };
  await q.query(
    'update attendance_settings set value = $2::jsonb, updated_at = now(), updated_by = $3 where key = $1',
    [key, JSON.stringify(value), userId],
  );
  return { ok: true, oldValue: existing.rows[0].value };
}
