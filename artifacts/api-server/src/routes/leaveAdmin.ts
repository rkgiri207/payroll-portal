import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import type { AttendanceRole } from '../lib/attendance/adminAccess';
import { toId } from '../lib/attendance/adminValidation';
import { writeAudit } from '../lib/attendance/auditStore';
import { asPoolLike, withTransaction } from '../lib/attendance/db';
import {
  confirmYear, createAcademicYear, createHoliday, deleteHoliday, getAcademicYear, importTemplate,
  listAcademicYears, listHolidays, previewWorkingDays, updateAcademicYear, updateHoliday,
} from '../lib/leave/calendarStore';
import { CALENDAR_TEMPLATES, findTemplate } from '../lib/leave/calendarTemplates';
import leavePolicyRouter from './leavePolicyAdmin';
import leaveRequestsRouter from './leaveRequestsAdmin';
import permissionsRouter from './permissionsAdmin';
import accrualRouter from './accrualAdmin';
import { validateAcademicYear, validateHoliday, validateImportDates } from '../lib/leave/calendarValidation';

/**
 * Leave admin endpoints. Mounted inside the attendance admin router, so every request has
 * already passed the sign-in and attendance-role checks (res.locals.actor). Every change is
 * written to the append-only attendance audit log.
 */
const router = Router();
const db = asPoolLike(pool);

interface Actor { userId: number; role: AttendanceRole }
const actorOf = (res: Response): Actor => res.locals.actor as Actor;
const bad = (res: Response, error: string, status = 400) => { res.status(status).json({ error }); };

const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
  try {
    await fn(req, res);
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave admin request failed');
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// ── Ready-made calendars ──────────────────────────────────────────────────────
router.get('/calendar/templates', handle(async (_req, res) => {
  res.json({
    templates: CALENDAR_TEMPLATES.map(t => ({
      key: t.key, title: t.title, label: t.label, startDate: t.startDate, endDate: t.endDate, holidayCount: t.holidays.length,
    })),
  });
}));

router.post('/calendar/import', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const template = findTemplate(req.body?.templateKey);
  if (!template) return bad(res, 'Unknown calendar');
  const dates = validateImportDates(req.body);
  if (!dates.ok) return bad(res, dates.error);
  const result = await withTransaction(db, q => importTemplate(q, template, userId, dates.value ?? undefined));
  if (!result.ok) return bad(res, result.error, result.status);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'CALENDAR_IMPORTED', entityType: 'academic_year',
    entityId: String(result.value.yearId),
    newValue: { template: template.key, ...result.value, skipped: result.value.skipped.length },
  });
  res.json({ ok: true, ...result.value });
}));

// ── Academic years ────────────────────────────────────────────────────────────
router.get('/calendar/years', handle(async (_req, res) => {
  res.json({ years: await listAcademicYears(db) });
}));

router.post('/calendar/years', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const input = validateAcademicYear(req.body);
  if (!input.ok) return bad(res, input.error);
  const created = await createAcademicYear(db, input.value, userId);
  if (!created.ok) return bad(res, created.error, created.status);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'ACADEMIC_YEAR_CREATED', entityType: 'academic_year',
    entityId: String(created.value.id), newValue: input.value,
  });
  res.status(201).json({ year: created.value });
}));

router.patch('/calendar/years/:id', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid academic year');
  const input = validateAcademicYear(req.body);
  if (!input.ok) return bad(res, input.error);
  const updated = await updateAcademicYear(db, id, input.value);
  if (!updated.ok) return bad(res, updated.error, updated.status);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'ACADEMIC_YEAR_UPDATED', entityType: 'academic_year',
    entityId: String(id), oldValue: updated.value.before, newValue: updated.value.after,
  });
  res.json({ year: updated.value.after });
}));

/** One year with its holidays, the month-by-month working days, and the official figures if known. */
router.get('/calendar/years/:id', handle(async (req, res) => {
  const id = toId(req.params.id);
  const year = id ? await getAcademicYear(db, id) : null;
  if (!year) return bad(res, 'Academic year not found', 404);
  const [holidays, months] = await Promise.all([listHolidays(db, year.id), previewWorkingDays(db, year)]);
  const template = CALENDAR_TEMPLATES.find(t => t.label === year.label);
  const official = template?.printedWorkingDays ?? null;
  // The official figures are a reference. They are only a pass/fail check when the organisation's
  // year has exactly the official first and last day; otherwise a difference is expected.
  const sameDates = template?.startDate === year.startDate && template?.endDate === year.endDate;
  res.json({
    year, holidays, officialDatesDiffer: Boolean(template) && !sameDates,
    months: months.map(m => ({
      ...m, printed: official ? (official[m.month] ?? null) : null,
      matches: sameDates && official && official[m.month] !== undefined ? official[m.month] === m.workingDays : null,
    })),
  });
}));

router.post('/calendar/years/:id/holidays', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const yearId = toId(req.params.id);
  const year = yearId ? await getAcademicYear(db, yearId) : null;
  if (!year) return bad(res, 'Academic year not found', 404);
  const input = validateHoliday(req.body);
  if (!input.ok) return bad(res, input.error);
  const created = await createHoliday(db, year.id, input.value, userId);
  if (!created.ok) return bad(res, created.error, created.status);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'HOLIDAY_CREATED', entityType: 'holiday',
    entityId: String(created.value.id), newValue: created.value,
  });
  res.status(201).json({ holiday: created.value });
}));

router.patch('/calendar/holidays/:id', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid holiday');
  const input = validateHoliday(req.body);
  if (!input.ok) return bad(res, input.error);
  const updated = await updateHoliday(db, id, input.value);
  if (!updated.ok) return bad(res, updated.error, updated.status);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'HOLIDAY_UPDATED', entityType: 'holiday',
    entityId: String(id), oldValue: updated.value.before, newValue: updated.value.after,
  });
  res.json({ holiday: updated.value.after });
}));

router.delete('/calendar/holidays/:id', handle(async (req, res) => {
  const { userId } = actorOf(res);
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid holiday');
  const removed = await deleteHoliday(db, id);
  if (!removed) return bad(res, 'Holiday not found', 404);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'HOLIDAY_DELETED', entityType: 'holiday',
    entityId: String(id), oldValue: removed,
  });
  res.json({ ok: true });
}));

/** Only the Director confirms a calendar. Confirmed dates start to count for leave at once. */
router.post('/calendar/years/:id/confirm', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  if (role !== 'DIRECTOR') return bad(res, 'Only the Director can confirm a calendar', 403);
  const yearId = toId(req.params.id);
  const year = yearId ? await getAcademicYear(db, yearId) : null;
  if (!year) return bad(res, 'Academic year not found', 404);
  const confirmed = await confirmYear(db, year.id, userId);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'CALENDAR_CONFIRMED', entityType: 'academic_year',
    entityId: String(year.id), newValue: { label: year.label, holidaysConfirmed: confirmed },
  });
  res.json({ ok: true, confirmed });
}));

router.use(leavePolicyRouter);
router.use(leaveRequestsRouter);
router.use(permissionsRouter);
router.use(accrualRouter);

export default router;
