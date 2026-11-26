import { AbortTransaction, withTransaction, type PoolLike, type Queryable } from './db';
import { consumeToken, type EventType } from './tokenStore';

export interface NewAttendanceEvent {
  employeeId: number;
  campusId: number;
  eventType: EventType;
  workDate: string;
  punctuality: 'ON_TIME' | 'LATE' | 'NO_SHIFT' | 'NOT_APPLICABLE';
  lateMinutes: number | null;
  /** Snapshot of the shift used, so later shift changes never alter this record. */
  shift: { loginTime: string; logoutTime: string; graceMinutes: number } | null;
  gps: { lat: number; lng: number; accuracyM: number; distanceM: number };
  selfiePath: string | null;
  tokenId: string;
  /** The server clock reading used for the late calculation; stored as the event time. */
  serverTs: Date;
}

export type RecordResult =
  | { status: 'RECORDED'; eventId: string; serverTs: Date }
  | { status: 'TOKEN_UNAVAILABLE' }
  | { status: 'DUPLICATE' };

/**
 * Record an IN or OUT event and use up the token in ONE transaction.
 *  - TOKEN_UNAVAILABLE: the token was already used, locked, expired or not location-verified.
 *  - DUPLICATE: a valid event already exists for this employee, day and type, or this token
 *    already produced an event. Nothing is created and the token is left untouched.
 * `afterInsert` runs inside the same transaction (used to queue alerts), so the event and its
 * alerts are saved together or not at all.
 */
export async function recordAttendanceEvent(
  pool: PoolLike,
  event: NewAttendanceEvent,
  afterInsert?: (q: Queryable, saved: { eventId: string; serverTs: Date }) => Promise<void>,
): Promise<RecordResult> {
  return withTransaction<RecordResult>(pool, async q => {
    const inserted = await q.query<{ id: string; server_ts: Date }>(
      `insert into attendance_events
         (employee_id, campus_id, event_type, work_date, punctuality, late_minutes,
          shift_login_time, shift_logout_time, shift_grace_minutes,
          gps_lat, gps_lng, gps_accuracy_m, gps_distance_m, gps_result,
          selfie_path, source, token_id, server_ts)
       values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PASSED', $14, 'WHATSAPP_LINK', $15, $16)
       on conflict do nothing
       returning id, server_ts`,
      [
        event.employeeId, event.campusId, event.eventType, event.workDate, event.punctuality,
        event.lateMinutes, event.shift?.loginTime ?? null, event.shift?.logoutTime ?? null,
        event.shift?.graceMinutes ?? null, event.gps.lat, event.gps.lng, event.gps.accuracyM,
        event.gps.distanceM, event.selfiePath, event.tokenId, event.serverTs,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new AbortTransaction<RecordResult>({ status: 'DUPLICATE' });

    if (!(await consumeToken(q, event.tokenId))) {
      // Roll back the event we just inserted: no token, no attendance.
      throw new AbortTransaction<RecordResult>({ status: 'TOKEN_UNAVAILABLE' });
    }

    const saved = { eventId: row.id, serverTs: row.server_ts };
    if (afterInsert) await afterInsert(q, saved);
    return { status: 'RECORDED', ...saved };
  });
}

export interface StoredEvent {
  id: string;
  employeeId: number;
  campusId: number;
  eventType: EventType;
  workDate: string;
  serverTs: Date;
  punctuality: string;
  lateMinutes: number | null;
}

/** The event a token produced (used so a repeated submit returns the same result). */
export async function findEventByToken(q: Queryable, tokenId: string): Promise<StoredEvent | null> {
  const { rows } = await q.query<{
    id: string; employee_id: number; campus_id: number; event_type: EventType;
    work_date: string; server_ts: Date; punctuality: string; late_minutes: number | null;
  }>(
    `select id, employee_id, campus_id, event_type, work_date::text as work_date,
            server_ts, punctuality, late_minutes
       from attendance_events where token_id = $1`,
    [tokenId],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id, employeeId: r.employee_id, campusId: r.campus_id, eventType: r.event_type,
        workDate: r.work_date, serverTs: r.server_ts, punctuality: r.punctuality, lateMinutes: r.late_minutes,
      }
    : null;
}

/** The valid event (if any) for an employee, day and type. */
export async function findValidEvent(
  q: Queryable,
  employeeId: number,
  workDate: string,
  eventType: EventType,
): Promise<StoredEvent | null> {
  const { rows } = await q.query<{
    id: string; employee_id: number; campus_id: number; event_type: EventType;
    work_date: string; server_ts: Date; punctuality: string; late_minutes: number | null;
  }>(
    `select id, employee_id, campus_id, event_type, work_date::text as work_date,
            server_ts, punctuality, late_minutes
       from attendance_events
      where employee_id = $1 and work_date = $2::date and event_type = $3 and is_valid`,
    [employeeId, workDate, eventType],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id, employeeId: r.employee_id, campusId: r.campus_id, eventType: r.event_type,
        workDate: r.work_date, serverTs: r.server_ts, punctuality: r.punctuality, lateMinutes: r.late_minutes,
      }
    : null;
}
