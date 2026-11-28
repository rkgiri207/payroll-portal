import { Router, type NextFunction, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import { requireAuth } from '../middlewares/requireAuth';
import { canEditSetting, DIRECTOR_ONLY_SETTINGS, resolveRole, type AttendanceRole } from '../lib/attendance/adminAccess';
import {
  createAssignment, createCampus, createShift, deleteFutureShift, countPendingReview, getCampusSummaries,
  getEmployeeProfile, getSelfiePath, getSetupCounts, getTodayFeed, listAlertProblems, listAssignments,
  listCampuses, listEmployees, listPendingReview, listShiftViews, listUnmarked, removeAssignment,
  reviewEvent, saveRegistration, updateCampus,
} from '../lib/attendance/adminStore';
import {
  toId, validateAssignment, validateCampus, validateExceptionReview, validateRegistration, validateReview, validateShift,
} from '../lib/attendance/adminValidation';
import { writeAudit } from '../lib/attendance/auditStore';
import { asPoolLike } from '../lib/attendance/db';
import { listExceptions, reviewException } from '../lib/attendance/exceptionStore';
import { getDaySummary } from '../lib/attendance/rosterStore';
import { createSelfieStorage } from '../lib/attendance/selfieStorage';
import { loadRawSettings, loadSettings, settingHint, updateSetting } from '../lib/attendance/settings';
import { buildChecklist, readEnvFlags } from '../lib/attendance/setupChecklist';
import { maybeSweep } from '../lib/attendance/sweeper';
import { addDays, istParts } from '../lib/attendance/time';
import { maskPhone, toWhatsAppNumber } from '../lib/attendance/webhookSecurity';
import { loadWhatsAppConfig } from '../lib/attendance/whatsappSender';
import leaveAdminRouter from './leaveAdmin';
import { countPendingApprovals, getDayNotice, listOnLeaveToday, listPermissionsToday, upcomingLeave } from '../lib/leave/leaveDashboard';

/**
 * Admin endpoints for the attendance setup screens and the live dashboard. Every request needs
 * a signed-in portal user with an attendance role. Every change is written to the append-only
 * attendance audit log (who, what, old and new value). Phone numbers are masked in the log.
 */
const router = Router();
const db = asPoolLike(pool);

interface Actor { userId: number; role: AttendanceRole }
const actorOf = (res: Response): Actor => res.locals.actor as Actor;

async function requireAttendanceRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session?.userId;
    const role = userId ? await resolveRole(db, userId) : null;
    if (!userId || !role) {
      res.status(403).json({ error: 'You do not have access to attendance' });
      return;
    }
    res.locals.actor = { userId, role } satisfies Actor;
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Attendance role check failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
}

router.use(requireAuth, requireAttendanceRole);
// Leave screens (calendar, policies, requests). They inherit the checks above.
router.use('/leave', leaveAdminRouter);

/** Run a handler; unexpected errors become a plain 500 and are logged without personal data. */
const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
  try {
    await fn(req, res);
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Attendance admin request failed');
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

const bad = (res: Response, error: string, status = 400) => { res.status(status).json({ error }); };
const today = () => istParts(new Date()).workDate;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

// ── Who am I ──────────────────────────────────────────────────────────────────
router.get('/me', handle(async (_req, res) => {
  const { role, userId } = actorOf(res);
  res.json({ userId, role, canEditDirectorSettings: role === 'DIRECTOR', whatsappMode: loadWhatsAppConfig().mode });
}));

// ── Setup checklist ───────────────────────────────────────────────────────────
router.get('/setup-status', handle(async (_req, res) => {
  const [settings, counts] = await Promise.all([loadSettings(db), getSetupCounts(db, today())]);
  const flags = readEnvFlags(process.env, settings);
  const items = buildChecklist(counts, settings, flags);
  res.json({ items, counts, flags, ready: items.every(i => i.done) });
}));

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', handle(async (_req, res) => {
  const rows = await loadRawSettings(db);
  res.json({
    settings: rows.map(r => ({
      key: r.key, value: r.value, description: r.description, hint: settingHint(r.key),
      directorOnly: DIRECTOR_ONLY_SETTINGS.has(r.key),
    })),
  });
}));

router.patch('/settings/:key', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  const key = String(req.params.key);
  if (!canEditSetting(role, key)) return bad(res, 'Only the Director can change this setting', 403);

  let value: unknown = req.body?.value;
  if (key === 'director_whatsapp_e164' && typeof value === 'string') {
    value = value.trim() === '' ? null : (toWhatsAppNumber(value) ?? value);
  }
  const result = await updateSetting(db, key, value, userId);
  if (!result.ok) return bad(res, result.error);

  const secret = key === 'director_whatsapp_e164';
  const show = (v: unknown) => (secret && typeof v === 'string' ? maskPhone(v) : v);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'SETTING_CHANGED', entityType: 'setting', entityId: key,
    oldValue: show(result.oldValue), newValue: show(value),
  });
  res.json({ ok: true, key, value });
}));

// ── Campuses and shifts ───────────────────────────────────────────────────────
router.get('/campuses', handle(async (_req, res) => {
  res.json({ campuses: await listCampuses(db, today()) });
}));

router.post('/campuses', handle(async (req, res) => {
  const settings = await loadSettings(db);
  const input = validateCampus(req.body, { geofenceRadiusM: settings.defaultGeofenceRadiusM });
  if (!input.ok) return bad(res, input.error);
  const created = await createCampus(db, input.value);
  if (!created.ok) return bad(res, created.error, 409);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: actorOf(res).userId, action: 'CAMPUS_CREATED', entityType: 'campus',
    entityId: String(created.value.id), newValue: created.value,
  });
  res.status(201).json({ campus: created.value });
}));

router.patch('/campuses/:id', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid campus');
  const settings = await loadSettings(db);
  const input = validateCampus(req.body, { geofenceRadiusM: settings.defaultGeofenceRadiusM });
  if (!input.ok) return bad(res, input.error);
  const updated = await updateCampus(db, id, input.value);
  if (!updated.ok) return bad(res, updated.error, updated.error === 'Campus not found' ? 404 : 409);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: actorOf(res).userId, action: 'CAMPUS_UPDATED', entityType: 'campus',
    entityId: String(id), oldValue: updated.value.before, newValue: updated.value.after,
  });
  res.json({ campus: updated.value.after });
}));

router.get('/campuses/:id/shifts', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid campus');
  res.json({ shifts: await listShiftViews(db, id), today: today() });
}));

router.post('/campuses/:id/shifts', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid campus');
  const settings = await loadSettings(db);
  const input = validateShift(req.body, { graceMinutes: settings.defaultGraceMinutes });
  if (!input.ok) return bad(res, input.error);
  const { userId } = actorOf(res);
  const created = await createShift(db, id, input.value, userId);
  if (!created.ok) return bad(res, created.error, created.error === 'Campus not found' ? 404 : 409);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'SHIFT_CREATED', entityType: 'campus_shift',
    entityId: String(created.value.id), newValue: created.value,
  });
  res.status(201).json({ shift: created.value });
}));

router.delete('/shifts/:id', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid shift');
  const deleted = await deleteFutureShift(db, id, today());
  if (!deleted.ok) return bad(res, deleted.error, deleted.error === 'Shift not found' ? 404 : 409);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: actorOf(res).userId, action: 'SHIFT_DELETED', entityType: 'campus_shift',
    entityId: String(id), oldValue: deleted.value,
  });
  res.json({ ok: true });
}));

// ── Employees ─────────────────────────────────────────────────────────────────
router.get('/employees', handle(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const status = text(req.query.status);
  const result = await listEmployees(db, {
    today: today(), search: text(req.query.search), status: status === 'ACTIVE' || status === 'INACTIVE' ? status : null,
    limit, offset: (page - 1) * limit,
  });
  res.json({ employees: result.rows, total: result.total, page, limit });
}));

router.put('/employees/:id/registration', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid employee');
  const input = validateRegistration(req.body);
  if (!input.ok) return bad(res, input.error);
  const { userId } = actorOf(res);
  const saved = await saveRegistration(db, id, input.value, userId);
  if (!saved.ok) return bad(res, saved.error, saved.error === 'Employee not found' ? 404 : 409);
  const view = (r: { whatsapp: string | null; attendanceApplicable: boolean } | null) =>
    r && { whatsapp: r.whatsapp ? maskPhone(r.whatsapp) : null, attendanceApplicable: r.attendanceApplicable };
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'EMPLOYEE_REGISTRATION_UPDATED', entityType: 'employee',
    entityId: String(id), oldValue: view(saved.value.before), newValue: view(saved.value.after),
  });
  res.json({ registration: saved.value.after });
}));

router.get('/employees/:id/assignments', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid employee');
  res.json({ assignments: await listAssignments(db, id), today: today() });
}));

router.post('/employees/:id/assignments', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid employee');
  const input = validateAssignment(req.body);
  if (!input.ok) return bad(res, input.error);
  const { userId } = actorOf(res);
  const created = await createAssignment(db, id, input.value, userId);
  if (!created.ok) return bad(res, created.error, /not found/i.test(created.error) ? 404 : 409);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'ASSIGNMENT_CREATED', entityType: 'employee',
    entityId: String(id), newValue: created.value,
  });
  res.status(201).json({ assignment: created.value });
}));

router.delete('/assignments/:id', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid assignment');
  const removed = await removeAssignment(db, id, today());
  if (!removed.ok) return bad(res, removed.error, removed.error === 'Assignment not found' ? 404 : 409);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: actorOf(res).userId, action: `ASSIGNMENT_${removed.value.action}`,
    entityType: 'employee', entityId: String(removed.value.before.employeeId), oldValue: removed.value.before,
  });
  res.json({ ok: true, action: removed.value.action });
}));

router.get('/employees/:id/profile', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid employee');
  const profile = await getEmployeeProfile(db, id, today());
  if (!profile) return bad(res, 'Employee not found', 404);
  res.json({
    ...profile,
    registration: profile.registration && {
      whatsapp: profile.registration.whatsapp ? maskPhone(profile.registration.whatsapp) : null,
      attendanceApplicable: profile.registration.attendanceApplicable,
    },
  });
}));

// ── Live dashboard (the screen polls this every few seconds) ──────────────────
router.get('/dashboard', handle(async (_req, res) => {
  const now = new Date();
  const ist = istParts(now);
  const wa = loadWhatsAppConfig();

  // Fallback for when the scheduled function is not running on this deploy: the open dashboard
  // triggers a throttled sweep (at most once a minute across everyone). Never blocks for long.
  if (process.env.ATTENDANCE_ENABLED === 'true') {
    await Promise.race([
      maybeSweep({ pool: db, wa, env: process.env, now: () => new Date() }, 60).catch(() => null),
      new Promise(resolve => setTimeout(resolve, 2500)),
    ]);
  }

  const reviewSince = addDays(ist.workDate, -14);
  const [settings, summary, campuses, feed, alertProblems, pendingReview, onLeave, permissionsToday, pending, upcoming, notice] = await Promise.all([
    loadSettings(db), getDaySummary(db, ist.workDate, ist.weekday), getCampusSummaries(db, ist.workDate, ist.weekday),
    getTodayFeed(db, ist.workDate), listAlertProblems(db), countPendingReview(db, reviewSince),
    listOnLeaveToday(db, ist.workDate), listPermissionsToday(db, ist.workDate), countPendingApprovals(db),
    upcomingLeave(db, ist.workDate, 7), getDayNotice(db, ist.workDate),
  ]);

  const warnings: string[] = [];
  if (!settings.directorWhatsapp) warnings.push("The Director's WhatsApp number is not set, so no alerts are being sent to the Director.");
  if (wa.mode === 'stub') warnings.push('WhatsApp is in test mode: messages are recorded but NOT sent.');
  if (alertProblems.some(p => p.status === 'FAILED')) warnings.push('Some WhatsApp alerts failed to send. See "Alert problems" below.');

  res.json({
    workDate: ist.workDate, serverTime: now.toISOString(),
    summary: { ...summary, pendingReview }, campuses, feed, alertProblems, warnings,
    alertMode: settings.alertMode,
    // Leave and permission, from decisions only: approved is "on leave"; pending is just a number waiting for the Director.
    leave: { onLeave, permissionsToday, pendingLeave: pending.leave, pendingPermission: pending.permission, upcoming, notice },
  });
}));

router.get('/unmarked', handle(async (_req, res) => {
  const ist = istParts(new Date());
  res.json({ workDate: ist.workDate, unmarked: await listUnmarked(db, ist.workDate, ist.weekday) });
}));

// ── Exceptions and reviews ────────────────────────────────────────────────────
router.get('/exceptions', handle(async (req, res) => {
  const status = text(req.query.status);
  res.json({
    exceptions: await listExceptions(db, {
      status: status === 'OPEN' || status === 'REVIEWED' || status === 'RESOLVED' ? status : undefined,
      limit: Number(req.query.limit) || 100,
    }),
  });
}));

router.patch('/exceptions/:id', handle(async (req, res) => {
  const id = text(req.params.id);
  const input = validateExceptionReview(req.body);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return bad(res, 'Invalid exception');
  if (!input.ok) return bad(res, input.error);
  const { userId } = actorOf(res);
  if (!(await reviewException(db, id, userId, input.value.status, input.value.note))) return bad(res, 'Exception not found', 404);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'EXCEPTION_REVIEWED', entityType: 'attendance_exception',
    entityId: id, newValue: input.value, reason: input.value.note,
  });
  res.json({ ok: true });
}));

router.get('/reviews/pending', handle(async (_req, res) => {
  res.json({ events: await listPendingReview(db, addDays(today(), -14)) });
}));

router.patch('/events/:id/review', handle(async (req, res) => {
  const id = text(req.params.id);
  const input = validateReview(req.body);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return bad(res, 'Invalid record');
  if (!input.ok) return bad(res, input.error);
  const { userId } = actorOf(res);
  const result = await reviewEvent(db, id, userId, input.value.status, input.value.note);
  if (!result.ok) return bad(res, result.error, 404);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'EVENT_REVIEWED', entityType: 'attendance_event',
    entityId: id, oldValue: { reviewStatus: result.value.before }, newValue: { reviewStatus: input.value.status },
    reason: input.value.note,
  });
  res.json({ ok: true });
}));

/**
 * A short-lived (60 second) link to one selfie. The view is written to the audit log BEFORE the
 * link is issued, so there is never a view without a record. Selfies are never public.
 */
router.get('/events/:id/selfie-url', handle(async (req, res) => {
  const id = text(req.params.id);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return bad(res, 'Invalid record');
  const selfie = await getSelfiePath(db, id);
  if (!selfie) return bad(res, 'No selfie is stored for this record', 404);
  const { userId } = actorOf(res);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action: 'SELFIE_VIEWED', entityType: 'attendance_event',
    entityId: id, newValue: { employeeId: selfie.employeeId },
  });
  const url = await createSelfieStorage().signedUrl(selfie.path, 60);
  res.json({ url, expiresInSeconds: 60 });
}));

export default router;
