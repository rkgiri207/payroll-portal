import { Router, type Request, type Response } from 'express';
import { pool } from '@workspace/db';
import type { AttendanceRole } from '../lib/attendance/adminAccess';
import { toId } from '../lib/attendance/adminValidation';
import { writeAudit } from '../lib/attendance/auditStore';
import { asPoolLike } from '../lib/attendance/db';
import { onPermissionDecided } from '../lib/leave/leaveEvents';
import { permissionWhen } from '../lib/leave/permissionNotifications';
import {
  approvePermission, cancelPermission, rejectPermission, type PermissionDecision,
} from '../lib/leave/permissionService';
import { countPermissionsByStatus, getPermissionItem, listPermissions, type PermissionStatus } from '../lib/leave/permissionStore';

/**
 * Permission requests, admin side. Mounted inside the leave admin router, so sign-in and the
 * attendance-role check have already passed. Only the Director approves or rejects (checked here and
 * again by the database). Every change is written to the append-only audit log.
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
    req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Permission request failed');
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

/** A WhatsApp problem must never undo or hide a decision that is already saved. */
const safely = async (req: Request, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); } catch (error) { req.log.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Permission WhatsApp notification failed'); }
};

const STATUSES: PermissionStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

router.get('/permissions', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status as PermissionStatus) ? (req.query.status as PermissionStatus) : null;
  const employeeId = req.query.employeeId ? toId(req.query.employeeId) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
  const [permissions, counts] = await Promise.all([listPermissions(db, { status, employeeId, limit }), countPermissionsByStatus(db)]);
  res.json({ permissions, counts });
}));

async function finish(req: Request, res: Response, result: PermissionDecision, action: string, userId: number) {
  if (result.status === 'NOT_FOUND') return bad(res, 'Permission request not found', 404);
  if (result.status === 'REFUSED') return bad(res, result.message, result.code === 'NOT_ALLOWED' ? 403 : 400, { code: result.code });
  if (result.status === 'ALREADY') return bad(res, `This request is already ${result.request.status.toLowerCase()}.`, 409, { code: 'ALREADY', status: result.request.status });
  const item = await getPermissionItem(db, result.request.id);
  await writeAudit(db, {
    actorType: 'USER', actorUserId: userId, action, entityType: 'permission_request', entityId: result.request.id,
    newValue: { status: result.request.status, note: result.request.decisionNote },
  });
  await safely(req, () => onPermissionDecided(db, result.request.id));
  res.json({ request: item, message: item ? `${item.employeeName}: permission ${permissionWhen(item)} is now ${item.status.toLowerCase()}.` : 'Saved.' });
}

router.post('/permissions/:id/approve', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  if (role !== 'DIRECTOR') return bad(res, 'Only the Director can approve permissions', 403);
  await finish(req, res, await approvePermission(db, { requestId: String(req.params.id), via: 'WEB', userId }), 'PERMISSION_APPROVED', userId);
}));

router.post('/permissions/:id/reject', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  if (role !== 'DIRECTOR') return bad(res, 'Only the Director can reject permissions', 403);
  await finish(req, res, await rejectPermission(db, { requestId: String(req.params.id), via: 'WEB', userId, note: req.body?.reason }), 'PERMISSION_REJECTED', userId);
}));

router.post('/permissions/:id/cancel', handle(async (req, res) => {
  const { userId, role } = actorOf(res);
  await finish(req, res, await cancelPermission(db, {
    requestId: String(req.params.id), canceller: { by: role === 'DIRECTOR' ? 'DIRECTOR' : 'ADMIN' }, reason: req.body?.reason,
  }), 'PERMISSION_CANCELLED', userId);
}));

export default router;
