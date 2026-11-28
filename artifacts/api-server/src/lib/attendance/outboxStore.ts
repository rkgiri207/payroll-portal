import type { Queryable } from './db';

export type OutboxKind =
  | 'LINK' | 'CHECKIN_CONFIRM' | 'CHECKOUT_CONFIRM' | 'FAILED_VERIFICATION' | 'TOKEN_LOCKED'
  | 'HELP' | 'COMING_SOON' | 'CAMPUS_CHOICE'
  | 'DIRECTOR_CHECKIN' | 'DIRECTOR_CHECKOUT' | 'DIRECTOR_LATE' | 'DIRECTOR_EXCEPTION'
  | 'DIRECTOR_MISSING_OUT' | 'DIRECTOR_DIGEST' | 'DIRECTOR_LEAVE_REQUEST' | 'DIRECTOR_PERMISSION_REQUEST'
  | 'LEAVE_INFO' | 'LEAVE_DECISION' | 'PERMISSION_DECISION' | 'DIRECTOR_INFO';

export interface NewOutboxMessage {
  recipientType: 'DIRECTOR' | 'EMPLOYEE';
  recipientE164: string;
  employeeId?: number | null;
  eventId?: string | null;
  exceptionId?: string | null;
  kind: OutboxKind;
  deliveryMode: 'TEXT' | 'TEMPLATE';
  templateName?: string | null;
  templateLanguage?: string | null;
  /** TEXT: { body }. TEMPLATE: { params: string[], buttons?: string[] } (buttons = quick-reply payloads, in order). Never contains selfies. */
  payload: Record<string, unknown>;
  /** The same key can be queued only once, so repeated triggers never double-send. */
  idempotencyKey: string;
  maxAttempts?: number;
}

/** Queue a message. Returns its id, or null if the idempotency key was already queued. */
export async function enqueueMessage(q: Queryable, m: NewOutboxMessage): Promise<string | null> {
  const { rows } = await q.query<{ id: string }>(
    `insert into notification_outbox
       (recipient_type, recipient_e164, employee_id, event_id, exception_id, kind, delivery_mode,
        template_name, template_language, payload, idempotency_key, max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      m.recipientType, m.recipientE164, m.employeeId ?? null, m.eventId ?? null, m.exceptionId ?? null,
      m.kind, m.deliveryMode, m.templateName ?? null, m.templateLanguage ?? null,
      JSON.stringify(m.payload), m.idempotencyKey, m.maxAttempts ?? 5,
    ],
  );
  const id = rows[0]?.id ?? null;
  if (id) await logDelivery(q, id, 'QUEUED', null, null);
  return id;
}

export interface OutboxMessage {
  id: string;
  recipientType: 'DIRECTOR' | 'EMPLOYEE';
  recipientE164: string;
  kind: OutboxKind;
  deliveryMode: 'TEXT' | 'TEMPLATE';
  templateName: string | null;
  templateLanguage: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Claim up to `limit` due messages for sending. `for update skip locked` means two sweepers
 * running at once never take the same message, and `locked_until` releases a message that a
 * crashed sender was holding.
 */
export async function claimDueMessages(
  q: Queryable,
  limit: number,
  lockSeconds = 120,
): Promise<OutboxMessage[]> {
  const { rows } = await q.query<{
    id: string; recipient_type: 'DIRECTOR' | 'EMPLOYEE'; recipient_e164: string; kind: OutboxKind;
    delivery_mode: 'TEXT' | 'TEMPLATE'; template_name: string | null; template_language: string | null;
    payload: Record<string, unknown>; attempts: number; max_attempts: number;
  }>(
    `with due as (
       select id from notification_outbox
        where status = 'QUEUED' and next_attempt_at <= now()
          and (locked_until is null or locked_until < now())
        order by next_attempt_at
        limit $1
        for update skip locked
     )
     update notification_outbox o
        set locked_until = now() + make_interval(secs => $2::int),
            attempts = o.attempts + 1,
            updated_at = now()
       from due
      where o.id = due.id
      returning o.id, o.recipient_type, o.recipient_e164, o.kind, o.delivery_mode, o.template_name,
                o.template_language, o.payload, o.attempts, o.max_attempts`,
    [limit, lockSeconds],
  );
  return rows.map(r => ({
    id: r.id, recipientType: r.recipient_type, recipientE164: r.recipient_e164, kind: r.kind,
    deliveryMode: r.delivery_mode, templateName: r.template_name, templateLanguage: r.template_language,
    payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts,
  }));
}

/** Seconds to wait before retry number `attempts`: 60, 120, 240 ... capped at one hour. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 3600);
}

/**
 * Mark a claimed message as sent (or stubbed). For link messages the payload is cleared
 * so the secret link is not kept after delivery.
 */
export async function markSent(
  q: Queryable,
  id: string,
  opts: { metaMessageId: string | null; stubbed: boolean; clearPayload: boolean },
): Promise<void> {
  const status = opts.stubbed ? 'STUBBED' : 'SENT';
  await q.query(
    `update notification_outbox
        set status = $2, meta_message_id = $3, sent_at = now(), locked_until = null,
            last_error = null, updated_at = now(),
            payload = case when $4::boolean then '{}'::jsonb else payload end
      where id = $1`,
    [id, status, opts.metaMessageId, opts.clearPayload],
  );
  await logDelivery(q, id, status, null, opts.metaMessageId);
}

/**
 * Record a failed send. Retries with back-off until `max_attempts`, then the message is
 * FAILED (and stays visible in the dashboard feed).
 */
export async function markSendFailure(
  q: Queryable,
  message: Pick<OutboxMessage, 'id' | 'attempts' | 'maxAttempts'>,
  error: string,
  opts: { definitive?: boolean } = {},
): Promise<'RETRY' | 'FAILED'> {
  const safe = error.slice(0, 500);
  // A definitive failure (e.g. invalid number, rejected template) is not retried.
  const final = opts.definitive === true || message.attempts >= message.maxAttempts;
  await q.query(
    `update notification_outbox
        set status = $2, last_error = $3, locked_until = null, updated_at = now(),
            next_attempt_at = now() + make_interval(secs => $4::int)
      where id = $1`,
    [message.id, final ? 'FAILED' : 'QUEUED', safe, backoffSeconds(message.attempts)],
  );
  await logDelivery(q, message.id, final ? 'FAILED' : 'RETRY', safe, null);
  return final ? 'FAILED' : 'RETRY';
}

/**
 * Apply a delivery status reported by Meta (sent/delivered/read/failed). Status only moves
 * forward, so a late or repeated report can never undo a better one.
 */
export async function applyDeliveryStatus(
  q: Queryable,
  metaMessageId: string,
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
  errorDetail: string | null,
): Promise<boolean> {
  const { rows } = await q.query<{ id: string }>(
    `update notification_outbox
        set status = $2::text,
            delivered_at = case when $2::text = 'DELIVERED' then coalesce(delivered_at, now()) else delivered_at end,
            last_error = case when $2::text = 'FAILED' then $3 else last_error end,
            updated_at = now()
      where meta_message_id = $1
        and (case status when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3
                         when 'FAILED' then 5 when 'STUBBED' then 5 when 'CANCELLED' then 5 else 0 end)
          < (case $2::text when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3
                           when 'FAILED' then 4 else 0 end)
      returning id`,
    [metaMessageId, status, errorDetail ? errorDetail.slice(0, 500) : null],
  );
  const id = rows[0]?.id;
  if (id) await logDelivery(q, id, status, errorDetail, metaMessageId);
  return Boolean(id);
}

async function logDelivery(
  q: Queryable,
  outboxId: string,
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'STUBBED' | 'RETRY',
  detail: string | null,
  metaMessageId: string | null,
): Promise<void> {
  await q.query(
    `insert into notification_delivery_log (outbox_id, status, detail, meta_message_id)
     values ($1, $2, $3, $4)`,
    [outboxId, status, detail ? detail.slice(0, 500) : null, metaMessageId],
  );
}
