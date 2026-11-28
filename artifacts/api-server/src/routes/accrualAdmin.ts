import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import type { AttendanceRole } from '../lib/attendance/adminAccess';
import { toId } from '../lib/attendance/adminValidation';
import { writeAudit } from '../lib/attendance/auditStore';
import { asPoolLike } from '../lib/attendance/db';
import { istParts } from '../lib/attendance/time';
import { runAccrual } from '../lib/leave/accrualService';
import { getAcademicYear } from '../lib/leave/calendarStore';
import { listOpening, setOpening, validateOpeningEntries } from '../lib/leave/openingBalances';
import { getLeaveType } from '../lib/leave/policyStore';

/**
 * Monthly accrual and opening balances, admin side. Mounted inside the leave admin router, so sign-in
 * and the attendance-role check have already passed. The daily job runs by itself; here an admin can
 * see exactly what it would credit today, and the Director can run it now. Every change is audited.
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
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave accrual request failed');
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

/** What the daily job would credit today. Posts nothing. */
router.post('/accrual/preview', handle(async (_req, res) => {
  res.json(await runAccrual(db, { today: istParts(new Date()).workDate, dryRun: true, userId: null }));
}));

/** Run the job now. Only the Director: it posts leave into balances. Safe to repeat; it only posts what is missing. */
router.post('/accrual/run', handle(async (_req, res) => {
  const { userId, role } = actorOf(res);
  if (role !== 'DIRECTOR') return bad(res, 'Only the Director can run the leave accrual', 403);
  res.json(await runAccrual(db, { today: istParts(new Date()).workDate, dryRun: false, userId }));
}));

/** Active employees with no joining date: they earn nothing and cannot be given an opening balance. */
router.get('/accrual/missing-joining-dates', handle(async (_req, res) => {
  const { rows } = await db.query<{ id: number; employee_code: string; employee_name: string }>(
    `select id, employee_code, employee_name from employees where status = 'ACTIVE' and joining_date is null order by employee_name, id`,
  );
  res.json({ employees: rows.map(r => ({ employeeId: r.id, employeeCode: r.employee_code, employeeName: r.employee_name })) });
}));

async function yearAndType(req: Request, res: Response) {
  const yearId = toId(req.params.yearId);
  const typeId = toId(req.params.typeId);
  const year = yearId ? await getAcademicYear(db, yearId) : null;
  const type = typeId ? await getLeaveType(db, typeId) : null;
  if (!year || !type) { bad(res, 'Academic year or leave type not found', 404); return null; }
  if (!type.tracksBalance) { bad(res, `${type.name} has no balance, so it has no opening balance`); return null; }
  return { year, type };
}

router.get('/opening/:yearId/:typeId', handle(async (req, res) => {
  const ctx = await yearAndType(req, res);
  if (!ctx) return;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim().slice(0, 60) : null;
  res.json({ year: ctx.year, type: ctx.type, employees: await listOpening(db, ctx.year.id, ctx.type.id, search) });
}));

router.put('/opening/:yearId/:typeId', handle(async (req, res) => {
  const ctx = await yearAndType(req, res);
  if (!ctx) return;
  const { userId } = actorOf(res);
  const entries = validateOpeningEntries(req.body);
  if (!entries.ok) return bad(res, entries.error);
  const result = await setOpening(db, { yearId: ctx.year.id, typeId: ctx.type.id, entries: entries.value, userId });
  if (!result.ok) return bad(res, result.message, result.code === 'NOT_FOUND' ? 404 : 400, { code: result.code, employees: result.employees });
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'LEAVE_OPENING_SET', entityType: 'academic_year', entityId: String(ctx.year.id),
    newValue: { type: ctx.type.code, year: ctx.year.label, created: result.created, corrected: result.corrected, unchanged: result.unchanged },
  });
  res.json({ ok: true, created: result.created, corrected: result.corrected, unchanged: result.unchanged });
}));

export default router;
