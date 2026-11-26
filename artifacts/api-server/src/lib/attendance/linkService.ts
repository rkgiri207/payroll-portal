import { portalBaseUrl, queueEventAlerts, queueExceptionAlert, queueEmployeeText } from './alerts';
import { getCampus, getEmployeeContact, getShifts, listAllowedCampuses } from './campusData';
import { withTransaction } from './db';
import { findEventByToken, recordAttendanceEvent } from './eventStore';
import { openException, type ExceptionKind } from './exceptionStore';
import { evaluateLocation } from './geo';
import { formatIstDate, formatIstTime, lockedText } from './messages';
import { flushOutbox, type ServiceDeps } from './attendanceService';
import { loadSettings } from './settings';
import { evaluatePunctuality, pickShift } from './shift';
import { decodeSelfie, type SelfieStorage } from './selfieStorage';
import { istParts } from './time';
import { hashToken, isTokenShape } from './token';
import {
  getTokenByHash, getVerifiedLocation, markLocationVerified, recordAttempt,
  registerFailedAttempt, tokenState, type TokenRecord, type TokenState,
} from './tokenStore';

export interface LinkDeps extends ServiceDeps {
  storage: SelfieStorage;
}

export interface HttpResult {
  http: number;
  body: Record<string, unknown>;
}

const STATE_HTTP: Record<Exclude<TokenState, 'OK'>, number> = {
  NOT_FOUND: 404, EXPIRED: 410, USED: 409, LOCKED: 423,
};

type Loaded =
  | { ok: true; record: TokenRecord }
  | { ok: false; state: TokenState; record: TokenRecord | null };

async function loadToken(deps: ServiceDeps, token: unknown): Promise<Loaded> {
  if (!isTokenShape(token)) return { ok: false, state: 'NOT_FOUND', record: null };
  const record = await getTokenByHash(deps.pool, hashToken(token));
  const state = tokenState(record, deps.now());
  return state === 'OK' && record ? { ok: true, record } : { ok: false, state, record };
}

const closed = (state: TokenState): HttpResult => ({
  http: state === 'OK' ? 400 : STATE_HTTP[state as Exclude<TokenState, 'OK'>],
  body: { ok: false, state },
});

/** What the phone page needs to show. Never exposes employee details. */
export async function getLinkInfo(deps: ServiceDeps, token: unknown): Promise<HttpResult> {
  const loaded = await loadToken(deps, token);
  if (!loaded.ok) return closed(loaded.state);
  const { record } = loaded;
  const [campus, settings] = await Promise.all([getCampus(deps.pool, record.campusId), loadSettings(deps.pool)]);
  if (!campus) return closed('NOT_FOUND');
  return {
    http: 200,
    body: {
      ok: true,
      state: 'OK',
      type: record.eventType,
      campusName: campus.name,
      expiresAt: record.expiresAt.toISOString(),
      // The page counts down against the server's clock, not the phone's (which may be wrong).
      serverTime: deps.now().toISOString(),
      locationVerified: record.locationVerifiedAt !== null,
      attemptsLeft: Math.max(settings.maxFailedAttempts - record.failedAttempts, 0),
      requiredAccuracyM: campus.requiredAccuracyM ?? settings.requiredGpsAccuracyM,
    },
  };
}

const LOCATION_FAILURE_KIND: Record<string, ExceptionKind> = {
  OUTSIDE_RADIUS: 'GPS_OUTSIDE_RADIUS',
  POOR_ACCURACY: 'POOR_ACCURACY',
};

/**
 * Step 1: check the reported location against the campus. Every try is logged with the
 * reported coordinates and accuracy. Failed tries (outside the radius, poor accuracy) count
 * towards the lock; reaching the limit locks the link, tells the employee, and alerts the
 * Director. GPS is read once; there is no continuous tracking.
 */
export async function submitLocation(
  deps: ServiceDeps,
  token: unknown,
  input: { lat: unknown; lng: unknown; accuracyM: unknown; userAgent?: string | null },
): Promise<HttpResult> {
  const loaded = await loadToken(deps, token);
  if (!loaded.ok) return closed(loaded.state);
  const { record } = loaded;

  const [campus, settings, employee] = await Promise.all([
    getCampus(deps.pool, record.campusId),
    loadSettings(deps.pool),
    getEmployeeContact(deps.pool, record.employeeId),
  ]);
  if (!campus || !employee) return closed('NOT_FOUND');

  const attempt = (result: Parameters<typeof recordAttempt>[1]['result'], extra: Partial<Parameters<typeof recordAttempt>[1]> = {}) =>
    recordAttempt(deps.pool, {
      tokenId: record.id, employeeId: record.employeeId, campusId: record.campusId,
      lat: typeof input.lat === 'number' ? input.lat : null,
      lng: typeof input.lng === 'number' ? input.lng : null,
      accuracyM: typeof input.accuracyM === 'number' ? input.accuracyM : null,
      distanceM: null, result, userAgent: input.userAgent ?? null, ...extra,
    });

  // Only employees assigned to this campus (or on authorised temporary duty) may mark here.
  if (record.eventType === 'IN') {
    const allowed = await listAllowedCampuses(deps.pool, record.employeeId, record.workDate);
    if (!allowed.some(option => option.campusId === record.campusId)) {
      await attempt('CAMPUS_NOT_ALLOWED', { reason: 'Employee is not assigned to this campus today' });
      return { http: 403, body: { ok: false, result: 'CAMPUS_NOT_ALLOWED' } };
    }
  }

  const evaluation = evaluateLocation(
    {
      latitude: campus.latitude, longitude: campus.longitude, radiusM: campus.radiusM,
      requiredAccuracyM: campus.requiredAccuracyM ?? settings.requiredGpsAccuracyM,
    },
    { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM },
  );

  const baseUrl = portalBaseUrl(settings, deps.env);
  const now = deps.now();
  const alertContext = { settings, baseUrl, at: now, employee: { id: employee.employeeId, code: employee.employeeCode, name: employee.employeeName }, campusName: campus.name };

  if (evaluation.result === 'PASSED') {
    await attempt('PASSED', { distanceM: evaluation.distanceM });
    const ok = await markLocationVerified(deps.pool, record.id);
    return ok
      ? { http: 200, body: { ok: true, result: 'PASSED', boundary: evaluation.boundary } }
      : closed('EXPIRED');
  }

  if (evaluation.result === 'CAMPUS_NOT_CONFIGURED') {
    await attempt('ERROR', { reason: 'Campus coordinates are not configured' });
    await withTransaction(deps.pool, async q => {
      const id = await openException(q, {
        employeeId: employee.employeeId, campusId: campus.id, workDate: record.workDate,
        kind: 'OTHER', detail: 'Campus coordinates are not configured', tokenId: record.id,
      });
      if (id) await queueExceptionAlert(q, { ...alertContext, exceptionId: id, kind: 'OTHER', workDate: record.workDate });
    });
    await flushOutbox(deps);
    return { http: 409, body: { ok: false, result: 'CAMPUS_NOT_CONFIGURED' } };
  }

  if (evaluation.result === 'NO_LOCATION') {
    // Usually permission denied or no GPS signal. Logged, but does not count towards the lock.
    await attempt('NO_LOCATION', { reason: 'No usable location reported' });
    return { http: 422, body: { ok: false, result: 'NO_LOCATION', attemptsLeft: Math.max(settings.maxFailedAttempts - record.failedAttempts, 0) } };
  }

  // OUTSIDE_RADIUS or POOR_ACCURACY: a counted failure.
  const reason = evaluation.result === 'OUTSIDE_RADIUS'
    ? `Reported position is ${Math.round(evaluation.distanceM ?? 0)} m from the campus point (limit ${campus.radiusM} m)`
    : `Reported accuracy ${Math.round(Number(input.accuracyM))} m is worse than the ${campus.requiredAccuracyM ?? settings.requiredGpsAccuracyM} m limit`;
  await attempt(evaluation.result, { distanceM: evaluation.distanceM, reason });

  const failure = await registerFailedAttempt(deps.pool, record.id, settings.maxFailedAttempts);
  if (!failure) return closed('USED');

  const kind: ExceptionKind = failure.locked ? 'TOKEN_LOCKED' : LOCATION_FAILURE_KIND[evaluation.result];
  if (failure.locked || failure.failedAttempts === 1) {
    await withTransaction(deps.pool, async q => {
      const id = await openException(q, {
        employeeId: employee.employeeId, campusId: campus.id, workDate: record.workDate,
        kind, detail: failure.locked ? `Link locked after ${failure.failedAttempts} failed attempts. ${reason}` : reason,
        tokenId: record.id,
      });
      if (id) await queueExceptionAlert(q, { ...alertContext, exceptionId: id, kind, workDate: record.workDate });
      if (failure.locked && employee.whatsapp) {
        await queueEmployeeText(q, {
          employee: { id: employee.employeeId, whatsapp: employee.whatsapp },
          kind: 'TOKEN_LOCKED', body: lockedText(), idempotencyKey: `locked:${record.id}`,
        });
      }
    });
    await flushOutbox(deps);
  }

  return {
    http: 422,
    body: {
      ok: false, result: evaluation.result, locked: failure.locked,
      attemptsLeft: Math.max(settings.maxFailedAttempts - failure.failedAttempts, 0),
    },
  };
}

function successBody(event: { eventType: 'IN' | 'OUT'; serverTs: Date; punctuality: string; lateMinutes: number | null }, campusName: string, duplicate: boolean) {
  return {
    ok: true, duplicate, type: event.eventType, campusName,
    time: formatIstTime(event.serverTs), date: formatIstDate(event.serverTs),
    punctuality: event.punctuality, lateMinutes: event.lateMinutes,
  };
}

/**
 * Step 2: take the selfie, record the attendance with the SERVER time, and queue the
 * confirmation and Director alert. A repeated submit returns the same result instead of
 * creating a second record.
 */
export async function submitSelfie(
  deps: LinkDeps,
  token: unknown,
  input: { image: unknown },
): Promise<HttpResult> {
  const loaded = await loadToken(deps, token);

  // Idempotent: a double-tap or retry after success returns the same confirmation.
  if (!loaded.ok && loaded.state === 'USED' && loaded.record) {
    const existing = await findEventByToken(deps.pool, loaded.record.id);
    const campus = existing ? await getCampus(deps.pool, existing.campusId) : null;
    if (existing && campus) {
      return { http: 200, body: successBody(existing, campus.name, true) };
    }
  }
  if (!loaded.ok) return closed(loaded.state);
  const { record } = loaded;

  if (!record.locationVerifiedAt) {
    return { http: 409, body: { ok: false, state: 'LOCATION_REQUIRED' } };
  }
  const now = deps.now();
  const ist = istParts(now);
  if (record.workDate !== ist.workDate) return closed('EXPIRED'); // the day changed while the link was open

  const image = decodeSelfie(input.image);
  if (!image) return { http: 400, body: { ok: false, state: 'INVALID_IMAGE' } };

  const [campus, employee, settings, verified] = await Promise.all([
    getCampus(deps.pool, record.campusId),
    getEmployeeContact(deps.pool, record.employeeId),
    loadSettings(deps.pool),
    getVerifiedLocation(deps.pool, record.id),
  ]);
  if (!campus || !employee || !employee.whatsapp) return closed('NOT_FOUND');
  if (!verified) return { http: 409, body: { ok: false, state: 'LOCATION_REQUIRED' } };

  let shift = null;
  let punctuality: 'ON_TIME' | 'LATE' | 'NO_SHIFT' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
  let lateMinutes: number | null = null;
  if (record.eventType === 'IN') {
    shift = pickShift(await getShifts(deps.pool, campus.id), ist.workDate, ist.weekday);
    const result = evaluatePunctuality(shift, ist.minuteOfDay);
    punctuality = result.punctuality;
    lateMinutes = result.lateMinutes;
  }

  const selfiePath = `${ist.workDate.slice(0, 4)}/${ist.workDate.slice(5, 7)}/${record.id}.${image.kind.extension}`;
  await deps.storage.upload(selfiePath, image.bytes, image.kind.contentType);

  const baseUrl = portalBaseUrl(settings, deps.env);
  const contact = { id: employee.employeeId, code: employee.employeeCode, name: employee.employeeName, whatsapp: employee.whatsapp };

  let result;
  try {
    result = await recordAttendanceEvent(
      deps.pool,
      {
        employeeId: employee.employeeId, campusId: campus.id, eventType: record.eventType,
        workDate: ist.workDate, punctuality, lateMinutes,
        shift: shift ? { loginTime: shift.loginTime, logoutTime: shift.logoutTime, graceMinutes: shift.graceMinutes } : null,
        gps: verified, selfiePath, tokenId: record.id, serverTs: now,
      },
      async (q, saved) => {
        await queueEventAlerts(q, {
          settings, baseUrl, eventId: saved.eventId, eventType: record.eventType, serverTs: saved.serverTs,
          punctuality, lateMinutes, employee: contact, campusName: campus.name,
        });
        if (record.eventType === 'IN' && punctuality === 'NO_SHIFT') {
          const id = await openException(q, {
            employeeId: employee.employeeId, campusId: campus.id, workDate: ist.workDate, kind: 'NO_SHIFT',
            detail: 'Check-in recorded but no shift is configured for this campus and weekday', eventId: saved.eventId,
          });
          if (id) {
            await queueExceptionAlert(q, {
              settings, baseUrl, exceptionId: id, kind: 'NO_SHIFT', workDate: ist.workDate, at: saved.serverTs,
              employee: { id: employee.employeeId, code: employee.employeeCode, name: employee.employeeName },
              campusName: campus.name,
            });
          }
        }
      },
    );
  } catch (error) {
    await deps.storage.remove(selfiePath).catch(() => undefined);
    throw error;
  }

  if (result.status === 'RECORDED') {
    await flushOutbox(deps);
    return {
      http: 200,
      body: successBody({ eventType: record.eventType, serverTs: result.serverTs, punctuality, lateMinutes }, campus.name, false),
    };
  }

  // Nothing was saved: remove the orphaned selfie.
  await deps.storage.remove(selfiePath).catch(() => undefined);
  if (result.status === 'DUPLICATE') {
    return { http: 409, body: { ok: false, state: 'ALREADY_MARKED' } };
  }
  return closed('USED');
}
