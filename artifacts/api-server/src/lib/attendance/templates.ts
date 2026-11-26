/**
 * Director alert templates. These are the EXACT texts to submit to Meta (category: Utility,
 * language: English). {{n}} are variables. Meta requires that a template does not start or
 * end with a variable, so each ends with fixed text.
 *
 * Employee-facing replies are free-form messages inside WhatsApp's 24-hour window and need
 * no template (see messages.ts).
 */

export type DirectorTemplateKey = 'checkin' | 'checkout' | 'late' | 'exception' | 'missingOut' | 'digest';

interface TemplateDefinition {
  /** Default Meta template name; the live name is a setting editable in the app. */
  defaultName: string;
  body: string;
  /** Meta needs an example for each variable when you submit the template. */
  examples: string[];
}

export const DIRECTOR_TEMPLATES: Record<DirectorTemplateKey, TemplateDefinition> = {
  checkin: {
    defaultName: 'attendance_checkin',
    body: 'Attendance alert: {{1}} (ID {{2}}) checked IN at {{3}} on {{4}} at {{5}}. Status: {{6}}. Details: {{7}}. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', '02 Mar 2026', '09:05 AM', 'On time', 'https://example.com/attendance'],
  },
  checkout: {
    defaultName: 'attendance_checkout',
    body: 'Attendance alert: {{1}} (ID {{2}}) checked OUT at {{3}} on {{4}} at {{5}}. Details: {{6}}. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', '02 Mar 2026', '04:02 PM', 'https://example.com/attendance'],
  },
  late: {
    defaultName: 'attendance_late',
    body: 'Late arrival: {{1}} (ID {{2}}) checked IN at {{3}} on {{4}} at {{5}}, {{6}} minutes after the permitted time. Details: {{7}}. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', '02 Mar 2026', '09:25 AM', '15', 'https://example.com/attendance'],
  },
  exception: {
    defaultName: 'attendance_exception',
    body: 'Attendance exception: {{1}} (ID {{2}}) at {{3}} on {{4}}. Reason: {{5}}. Please review: {{6}}. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', '02 Mar 2026', 'Location outside campus', 'https://example.com/attendance'],
  },
  missingOut: {
    defaultName: 'attendance_missing_out',
    body: 'Missing check-out: {{1}} (ID {{2}}) at {{3}} has not checked OUT on {{4}}. Please review: {{5}}. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', '02 Mar 2026', 'https://example.com/attendance'],
  },
  digest: {
    defaultName: 'attendance_digest',
    body: 'Attendance summary for {{1}} as of {{2}}: Present {{3}}, Late {{4}}, Unmarked {{5}}, Open exceptions {{6}}. Details: {{7}}. This is an automated alert.',
    examples: ['02 Mar 2026', '11:00 AM', '41', '3', '6', '1', 'https://example.com/attendance'],
  },
};

/** Highest {{n}} in a template body. */
export function placeholderCount(body: string): number {
  const numbers = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
  return numbers.length ? Math.max(...numbers) : 0;
}

/**
 * Meta rejects empty parameters, newlines, tabs and runs of 4+ spaces. Clean a value so a
 * stray name or reason can never make a send fail.
 */
export function sanitizeParam(value: unknown): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 1000);
  return text || '-';
}

/** Build the ordered, sanitised parameter list for a template. Throws on a wrong count. */
export function buildParams(key: DirectorTemplateKey, values: unknown[]): string[] {
  const expected = placeholderCount(DIRECTOR_TEMPLATES[key].body);
  if (values.length !== expected) {
    throw new Error(`Template ${key} needs ${expected} parameters, got ${values.length}`);
  }
  return values.map(sanitizeParam);
}

/** The text a recipient will see (used for the dashboard feed and stub-mode previews). */
export function renderTemplate(key: DirectorTemplateKey, params: string[]): string {
  return DIRECTOR_TEMPLATES[key].body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '-');
}
