import type { Queryable } from './db';
import type { EmployeeCommand } from './commands';

export type WebhookOutcome =
  | 'RECEIVED' | 'REPLIED' | 'IGNORED_UNREGISTERED' | 'IGNORED_GROUP'
  | 'IGNORED_NOT_COMMAND' | 'IGNORED_NOT_TEXT' | 'STATUS_APPLIED' | 'ERROR';

/**
 * Claim an inbound WhatsApp event for processing. Returns true the FIRST time an event key is
 * seen and false for every repeat, so a duplicate delivery from Meta is processed only once.
 * Only the parsed command and a masked number are stored; message text is never kept.
 */
export async function claimWebhookEvent(
  q: Queryable,
  e: {
    eventKey: string;
    kind: 'MESSAGE' | 'STATUS';
    fromMasked: string | null;
    command: EmployeeCommand | null;
    employeeId: number | null;
  },
): Promise<boolean> {
  const { rows } = await q.query<{ event_key: string }>(
    `insert into whatsapp_webhook_events (event_key, kind, from_masked, command, employee_id)
     values ($1, $2, $3, $4, $5)
     on conflict (event_key) do nothing
     returning event_key`,
    [e.eventKey, e.kind, e.fromMasked, e.command, e.employeeId],
  );
  return rows.length === 1;
}

export async function setWebhookOutcome(
  q: Queryable,
  eventKey: string,
  outcome: WebhookOutcome,
  detail: string | null = null,
): Promise<void> {
  await q.query(
    'update whatsapp_webhook_events set outcome = $2, detail = $3 where event_key = $1',
    [eventKey, outcome, detail ? detail.slice(0, 300) : null],
  );
}
