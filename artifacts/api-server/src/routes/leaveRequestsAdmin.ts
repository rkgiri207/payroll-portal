import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import type { AttendanceRole } from '../lib/attendance/adminAccess';
import { isValidDate, toId } from '../lib/attendance/adminValidation';
import { writeAudit } from '../lib/attendance/auditStore';
import { asPoolLike } from '../lib/attendance/db';
import { istParts } from '../lib/attendance/time';
import type { DayMode } from '../lib/leave/leaveEvaluate';
import { approveLeave, cancelLeave, decisionText, rejectLeave, suggestedSplit, type DecisionResult } from '../lib/leave/decisionService';
import { onLeaveDecided, onLeaveSubmitted } from '../lib/leave/leaveEvents';
import { capReachedText, previewLeave, submitLeaveRequest } from '../lib/leave/leaveService';
import { toRequest, REQUEST_COLUMNS, type LeaveStatus } from '../lib/leave/leaveRequestStore';
import { countByStatus, getRequestItem, listRequestDays, listRequests } from '../lib/leave/requestQueries';

/**
 * Leave requests, admin side. Mounted inside the leave admin router, so sign-in and the
 * attendance-role check have already passed.
 *
 * An admin can enter leave on an employee's behalf (for example a past date). Such a request is
 * still PENDING and still needs the Director's decision: entering leave never approves it.
 */
const router = Router();
const db = asPoolLike(pool);

interface Actor { userId: number; role: AttendanceRole }
const actorOf = (res: Response): Actor => res.locals.actor as Actor;
const bad = (res: Response, error: string, status = 400, extra: Record<string, unknown> = {}) => { res.status(status).json({ error, ...extra }); };

const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
  try {
    await fn(req, res);
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave request failed');
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

/** A WhatsApp problem must never undo or hide a decision that is already saved. */
const safely = async (req: Request, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); } catch (error) { req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave WhatsApp notification failed'); }
};

const DAY_MODES: DayMode[] = ['FULL', 'FIRST_HALF', 'SECOND_HALF'];

function readRequest(body: unknown): { ok: true; value: { employeeId: number; leaveTypeId: number; startDate: string; endDate: string; dayMode: DayMode } } | { ok: false; error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const employeeId = toId(b.employeeId);
  const leaveTypeId = toId(b.leaveTypeId);
  if (!employeeId) return { ok: false, error: 'Choose an employee' };
  if (!leaveTypeId) return { ok: false, error: 'Choose a leave type' };
  if (!isValidDate(b.startDate)) return { ok: false, error: 'Start date must be a valid date' };
  const endDate = b.endDate === undefined || b.endDate === null || b.endDate === '' ? b.startDate : b.endDate;
  if (!isValidDate(endDate)) return { ok: false, error: 'End date must be a valid date' };
  const dayMode = b.dayMode === undefined ? 'FULL' : b.dayMode;
  if (typeof dayMode !== 'string' || !DAY_MODES.includes(dayMode as DayMode)) return { ok: false, error: 'Choose full day, first half or second half' };
  return { ok: true, value: { employeeId, leaveTypeId, startDate: b.startDate, endDate, dayMode: dayMode as DayMode } };
}

/** What a request would cost, without saving anything. */
router.post('/requests/preview', handle(async (req, res) => {
  const input = readRequest(req.body);
  if (!input.ok) return bad(res, input.error);
  const result = await previewLeave(db, { ...input.value, today: istParts(new Date()).workDate, byAdmin: true });
  if (!result.ok) return bad(res, result.message, result.code === 'EMPLOYEE_NOT_FOUND' || result.code === 'TYPE_NOT_FOUND' ? 404 : 400, { code: result.code, dates: result.dates });
  res.json(result);
}));

/** Enter leave on an employee's behalf. It stays pending until the Director decides. */
router.post('/requests', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const input = readRequest(req.body);
  if (!input.ok) return bad(res, input.error);
  const key = typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.length <= 100
    ? `manual:${req.body.idempotencyKey}` : undefined;

  const result = await submitLeaveRequest(db, {
    ...input.value, reason: req.body?.reason, submittedVia: 'MANUAL', enteredByUserId: userId,
    idempotencyKey: key, today: istParts(new Date()).workDate,
  });

  if (result.status === 'REFUSED') {
    return bad(res, result.message, result.code === 'EMPLOYEE_NOT_FOUND' || result.code === 'TYPE_NOT_FOUND' ? 404 : 400, { code: result.code, dates: result.dates });
  }
  if (result.status === 'CAP_REACHED') {
    await writeAudit(db, {
      actorType: 'USER', actorUserId: userId, action: 'LEAVE_REQUEST_AUTO_REJECTED', entityType: 'leave_request',
      entityId: result.request.id, newValue: { reason: 'campus limit', fullDates: result.fullDates, cap: result.cap },
    });
    return bad(res, capReachedText(result.cap, result.fullDates), 409, { code: 'CAP_REACHED', fullDates: result.fullDates, request: result.request });
  }
  if (result.status === 'SUBMITTED') {
    await writeAudit(db, {
      actorType: 'USER', actorUserId: userId, action: 'LEAVE_REQUEST_ENTERED', entityType: 'leave_request',
      entityId: result.request.id,
      newValue: { employeeId: result.request.employeeId, from: result.request.startDate, to: result.request.endDate, days: result.request.totalDays, paid: result.request.paidDays, lop: result.request.lopDays },
    });
  }
  if (result.status === 'SUBMITTED') await safely(req, () => onLeaveSubmitted(db, result.request.id));
  res.status(result.status === 'SUBMITTED' ? 201 : 200).json({ request: result.request, duplicate: result.status === 'DUPLICATE' });
}));

const STATUSES: LeaveStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

/** The list for the approvals screen. Pending requests come first, oldest first. */
router.get('/requests', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status as LeaveStatus) ? (req.query.status as LeaveStatus) : null;
  const academicYearId = req.query.yearId ? toId(req.query.yearId) : null;
  const employeeId = req.query.employeeId ? toId(req.query.employeeId) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
  const [requests, counts] = await Promise.all([
    listRequests(db, { status, academicYearId, employeeId, limit }),
    countByStatus(db, academicYearId),
  ]);
  res.json({ requests, counts });
}));

/** One request with its days and what approving it would do right now. */
router.get('/requests/:id', handle(async (req, res) => {
  const id = String(req.params.id);
  const item = /^[0-9a-f-]{36}$/.test(id) ? await getRequestItem(db, id) : null;
  if (!item) return bad(res, 'Leave request not found', 404);
  const { rows } = await db.query<Parameters<typeof toRequest>[0]>(`select ${REQUEST_COLUMNS} from leave_requests where id = $1`, [id]);
  const approval = item.status === 'PENDING' ? await suggestedSplit(db, toRequest(rows[0])) : null;
  res.json({ request: item, days: await listRequestDays(db, id), ifApproved: approval });
}));

async function finish(req: Request, res: Response, result: DecisionResult, action: string, userId: number, typeName: (id: string) => Promise<string>) {
  if (result.status === 'NOT_FOUND') return bad(res, 'Leave request not found', 404);
  if (result.status === 'REFUSED') return bad(res, result.message, result.code === 'NOT_ALLOWED' ? 403 : 400, { code: result.code });
  if (result.status === 'ALREADY') {
    return bad(res, `This request is already ${result.request.status.toLowerCase()}.`, 409, { code: 'ALREADY', status: result.request.status });
  }
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action, entityType: 'leave_request', entityId: result.request.id,
    newValue: {
      status: result.request.status, days: result.request.totalDays, paid: result.request.paidDays, lop: result.request.lopDays,
      note: result.request.decisionNote,
    },
  });
  await safely(req, () => onLeaveDecided(db, result.request.id));
  res.json({ request: result.request, message: decisionText(result.request, await typeName(result.request.id)) });
}

const typeNameOf = async (id: string) => (await getRequestItem(db, id))?.leaveTypeName ?? 'Leave';

/** Only the Director decides leave. Checked here and again by the database. */
router.post('/requests/:id/approve', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  if (role !== 'DIRECTOR') return bad(res, 'Only the Director can approve leave', 403);
  const result = await approveLeave(db, { requestId: String(req.params.id), via: 'WEB', userId });
  await finish(req, res, result, 'LEAVE_APPROVED', userId, typeNameOf);
}));

router.post('/requests/:id/reject', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  if (role !== 'DIRECTOR') return bad(res, 'Only the Director can reject leave', 403);
  const result = await rejectLeave(db, { requestId: String(req.params.id), via: 'WEB', userId, note: req.body?.reason });
  await finish(req, res, result, 'LEAVE_REJECTED', userId, typeNameOf);
}));

/** The Director or an admin cancels a pending or approved request. Approved leave gets a ledger reversal. */
router.post('/requests/:id/cancel', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  const result = await cancelLeave(db, {
    requestId: String(req.params.id), canceller: { by: role === 'DIRECTOR' ? 'DIRECTOR' : 'ADMIN' },
    reason: req.body?.reason, today: istParts(new Date()).workDate,
  });
  await finish(req, res, result, 'LEAVE_CANCELLED', userId, typeNameOf);
}));

export default router;
