import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import type { AttendanceRole } from '../lib/attendance/adminAccess';
import { toId } from '../lib/attendance/adminValidation';
import { writeAudit } from '../lib/attendance/auditStore';
import { asPoolLike, withTransaction } from '../lib/attendance/db';
import { getAcademicYear } from '../lib/leave/calendarStore';
import {
  applyAllocation, copyPolicies, createLeaveType, deleteAllocation, getLeaveType, listAllocations, listLeaveTypes,
  listPolicies, updateLeaveType, upsertAllocation, upsertPolicy,
} from '../lib/leave/policyStore';
import {
  validateAllocation, validateBulkAllocation, validateLeaveType, validateLeaveTypeChanges, validatePolicy,
} from '../lib/leave/policyValidation';

/**
 * Leave types, policies (per leave type per academic year) and allocations (per employee). Mounted
 * inside the leave admin router, so sign-in and the attendance-role check have already passed.
 * Every change is written to the append-only audit log. Nothing here moves any balance: credits
 * and deductions are posted to the leave ledger by the leave workflow, never edited here.
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
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Leave policy request failed');
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

const audit = (res: Response, action: string, entityType: string, entityId: string, oldValue: unknown, newValue: unknown) =>
  writeAudit(db, { actorType: 'USER', actorUserId: actorOf(res).userId, action, entityType, entityId, oldValue, newValue });

// ── Leave types ───────────────────────────────────────────────────────────────
router.get('/types', handle(async (_req, res) => {
  res.json({ types: await listLeaveTypes(db) });
}));

router.post('/types', handle(async (req, res) => {
  const input = validateLeaveType(req.body);
  if (!input.ok) return bad(res, input.error);
  const created = await createLeaveType(db, input.value);
  if (!created.ok) return bad(res, created.error, created.status);
  await audit(res, 'LEAVE_TYPE_CREATED', 'leave_type', String(created.value.id), null, created.value);
  res.status(201).json({ type: created.value });
}));

router.patch('/types/:id', handle(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return bad(res, 'Invalid leave type');
  const changes = validateLeaveTypeChanges(req.body);
  if (!changes.ok) return bad(res, changes.error);
  const updated = await updateLeaveType(db, id, changes.value);
  if (!updated.ok) return bad(res, updated.error, updated.status);
  await audit(res, 'LEAVE_TYPE_UPDATED', 'leave_type', String(id), updated.value.before, updated.value.after);
  res.json({ type: updated.value.after });
}));

// ── Policies (per leave type, per academic year) ──────────────────────────────
router.get('/policies/:yearId', handle(async (req, res) => {
  const yearId = toId(req.params.yearId);
  const year = yearId ? await getAcademicYear(db, yearId) : null;
  if (!year) return bad(res, 'Academic year not found', 404);
  res.json({ year, policies: await listPolicies(db, year.id) });
}));

router.put('/policies/:yearId/:typeId', handle(async (req, res) => {
  const yearId = toId(req.params.yearId);
  const typeId = toId(req.params.typeId);
  const year = yearId ? await getAcademicYear(db, yearId) : null;
  const type = typeId ? await getLeaveType(db, typeId) : null;
  if (!year || !type) return bad(res, 'Academic year or leave type not found', 404);
  const input = validatePolicy(req.body, type);
  if (!input.ok) return bad(res, input.error);
  const before = (await listPolicies(db, year.id)).find(p => p.type.id === type.id)?.policy ?? null;
  const saved = await upsertPolicy(db, year.id, type.id, input.value, actorOf(res).userId);
  if (!saved.ok) return bad(res, saved.error, saved.status);
  await audit(res, 'LEAVE_POLICY_SAVED', 'leave_policy', `${year.id}:${type.id}`, before, { year: year.label, type: type.code, ...input.value });
  res.json({ policy: saved.value });
}));

/** Start a new academic year from last year's policies. Policies the new year already has are kept. */
router.post('/policies/:yearId/copy-from/:fromYearId', handle(async (req, res) => {
  const toYearId = toId(req.params.yearId);
  const fromYearId = toId(req.params.fromYearId);
  const [to, from] = await Promise.all([
    toYearId ? getAcademicYear(db, toYearId) : null,
    fromYearId ? getAcademicYear(db, fromYearId) : null,
  ]);
  if (!to || !from) return bad(res, 'Academic year not found', 404);
  if (to.id === from.id) return bad(res, 'Choose a different year to copy from');
  const copied = await copyPolicies(db, from.id, to.id, actorOf(res).userId);
  await audit(res, 'LEAVE_POLICIES_COPIED', 'academic_year', String(to.id), null, { from: from.label, to: to.label, copied });
  res.json({ ok: true, copied });
}));

// ── Allocations (per employee) ────────────────────────────────────────────────
async function loadYearAndType(req: Request, res: Response) {
  const yearId = toId(req.params.yearId);
  const typeId = toId(req.params.typeId);
  const year = yearId ? await getAcademicYear(db, yearId) : null;
  const type = typeId ? await getLeaveType(db, typeId) : null;
  if (!year || !type) { bad(res, 'Academic year or leave type not found', 404); return null; }
  if (!type.tracksBalance) { bad(res, `${type.name} has no balance, so it has no yearly days to allocate`); return null; }
  return { year, type };
}

router.get('/allocations/:yearId/:typeId', handle(async (req, res) => {
  const ctx = await loadYearAndType(req, res);
  if (!ctx) return;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim().slice(0, 60) : null;
  res.json({ year: ctx.year, type: ctx.type, allocations: await listAllocations(db, ctx.year.id, ctx.type.id, search) });
}));

router.put('/allocations/:yearId/:typeId/:employeeId', handle(async (req, res) => {
  const ctx = await loadYearAndType(req, res);
  if (!ctx) return;
  const employeeId = toId(req.params.employeeId);
  if (!employeeId) return bad(res, 'Invalid employee');
  const input = validateAllocation(req.body);
  if (!input.ok) return bad(res, input.error);
  const saved = await upsertAllocation(db, ctx.year.id, ctx.type.id, employeeId, input.value, actorOf(res).userId);
  if (!saved.ok) return bad(res, saved.error, saved.status);
  await audit(res, 'LEAVE_ALLOCATION_SAVED', 'leave_allocation', `${ctx.year.id}:${ctx.type.id}:${employeeId}`,
    { annualDays: saved.value.before }, { year: ctx.year.label, type: ctx.type.code, ...input.value });
  res.json({ ok: true });
}));

router.delete('/allocations/:yearId/:typeId/:employeeId', handle(async (req, res) => {
  const ctx = await loadYearAndType(req, res);
  if (!ctx) return;
  const employeeId = toId(req.params.employeeId);
  if (!employeeId) return bad(res, 'Invalid employee');
  const removed = await deleteAllocation(db, ctx.year.id, ctx.type.id, employeeId);
  if (!removed) return bad(res, 'This employee has no allocation of their own', 404);
  await audit(res, 'LEAVE_ALLOCATION_REMOVED', 'leave_allocation', `${ctx.year.id}:${ctx.type.id}:${employeeId}`,
    { year: ctx.year.label, type: ctx.type.code }, null);
  res.json({ ok: true });
}));

router.post('/allocations/:yearId/:typeId/apply', handle(async (req, res) => {
  const ctx = await loadYearAndType(req, res);
  if (!ctx) return;
  const input = validateBulkAllocation(req.body);
  if (!input.ok) return bad(res, input.error);
  const applied = await withTransaction(db, q => applyAllocation(q, ctx.year.id, ctx.type.id, input.value, actorOf(res).userId));
  await audit(res, 'LEAVE_ALLOCATION_APPLIED', 'leave_allocation', `${ctx.year.id}:${ctx.type.id}`, null, {
    year: ctx.year.label, type: ctx.type.code, annualDays: input.value.annualDays, overwrite: input.value.overwrite,
    who: input.value.employeeIds === 'ALL' ? 'ALL' : input.value.employeeIds.length, applied,
  });
  res.json({ ok: true, applied });
}));

export default router;
