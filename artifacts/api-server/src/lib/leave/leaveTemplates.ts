import { placeholderCount, sanitizeParam } from '../attendance/templates';

/**
 * The WhatsApp templates for leave. These are the EXACT texts to submit to Meta (category: Utility,
 * language: English). {{n}} are variables. Meta requires that a template does not start or end
 * with a variable, so each ends with fixed text.
 *
 * The Director's template carries two quick-reply buttons, Approve and Reject. When one is tapped
 * Meta sends back the payload we attached (LV:A:<id> or LV:R:<id>).
 * The template names are settings, editable in the app.
 */

export type LeaveTemplateKey = 'leaveRequest' | 'leaveDecision' | 'permissionRequest' | 'permissionDecision';

interface Definition {
  defaultName: string;
  body: string;
  examples: string[];
  /** Button labels to create in Meta, in order. */
  buttons: string[];
}

export const LEAVE_TEMPLATES: Record<LeaveTemplateKey, Definition> = {
  leaveRequest: {
    defaultName: 'leave_request',
    body: 'Leave request: {{1}} (ID {{2}}) at {{3}} has asked for {{4}} on {{5}} ({{6}}). Reason: {{7}}. Please approve or reject. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', 'Casual Leave', '07 Sep 2026 to 08 Sep 2026', '2 days: 2 paid, 0 without pay', 'Family function'],
    buttons: ['Approve', 'Reject'],
  },
  leaveDecision: {
    defaultName: 'leave_decision',
    body: 'Leave update: your {{1}} request for {{2}} was {{3}}. {{4}} This is an automated message.',
    examples: ['Casual Leave', '07 Sep 2026 to 08 Sep 2026', 'approved', 'All days are paid.'],
    buttons: [],
  },
  permissionRequest: {
    defaultName: 'permission_request',
    body: 'Permission request: {{1}} (ID {{2}}) at {{3}} has asked for permission on {{4}} from {{5}} to {{6}} ({{7}}). Reason: {{8}}. Please approve or reject. This is an automated alert.',
    examples: ['Asha Rao', 'T001', 'Main Campus', '07 Sep 2026', '10:00 AM', '11:00 AM', '60 minutes', 'Doctor appointment'],
    buttons: ['Approve', 'Reject'],
  },
  permissionDecision: {
    defaultName: 'permission_decision',
    body: 'Permission update: your permission request for {{1}} from {{2}} to {{3}} was {{4}}. {{5}} This is an automated message.',
    examples: ['07 Sep 2026', '10:00 AM', '11:00 AM', 'approved', 'No further action is needed.'],
    buttons: [],
  },
};

export function buildLeaveParams(key: LeaveTemplateKey, values: unknown[]): string[] {
  const expected = placeholderCount(LEAVE_TEMPLATES[key].body);
  if (values.length !== expected) throw new Error(`Template ${key} needs ${expected} parameters, got ${values.length}`);
  return values.map(sanitizeParam);
}

/** The button payloads. The Director's number is checked when they come back, not trusted from the payload. */
export const approvePayload = (requestId: string) => `LV:A:${requestId}`;
export const rejectPayload = (requestId: string) => `LV:R:${requestId}`;

export function parseLeavePayload(payload: string | null): { action: 'APPROVE' | 'REJECT'; requestId: string } | null {
  const m = /^LV:([AR]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(payload ?? '');
  return m ? { action: m[1] === 'A' ? 'APPROVE' : 'REJECT', requestId: m[2] } : null;
}

export const approvePermissionPayload = (requestId: string) => `PR:A:${requestId}`;
export const rejectPermissionPayload = (requestId: string) => `PR:R:${requestId}`;

export type DecisionPayload = { kind: 'LEAVE' | 'PERMISSION'; action: 'APPROVE' | 'REJECT'; requestId: string };

/** Any Approve / Reject button from the Director, for leave (LV) or permission (PR). */
export function parseDecisionPayload(payload: string | null): DecisionPayload | null {
  const m = /^(LV|PR):([AR]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(payload ?? '');
  return m ? { kind: m[1] === 'LV' ? 'LEAVE' : 'PERMISSION', action: m[2] === 'A' ? 'APPROVE' : 'REJECT', requestId: m[3] } : null;
}
