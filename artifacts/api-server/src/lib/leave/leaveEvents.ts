import { flushOutbox } from '../attendance/attendanceService';
import type { PoolLike } from '../attendance/db';
import { loadSettings } from '../attendance/settings';
import { loadWhatsAppConfig } from '../attendance/whatsappSender';
import { notifyDirectorOfLeave, notifyEmployeeOfDecision, queueLeaveReply } from './leaveNotifications';
import { notifyDirectorOfPermission, notifyEmployeeOfPermissionDecision } from './permissionNotifications';
import { getPermissionItem } from './permissionStore';
import { getRequestItem } from './requestQueries';

/**
 * What happens on WhatsApp after something changes on a leave request. Each function queues the
 * message in the outbox and then tries to send it straight away, time-boxed. If sending does not
 * finish in time, the scheduled sweeper delivers it later, so a slow WhatsApp never slows the
 * screen and a message is never lost. A failure here is logged by the caller and never undoes
 * the leave decision that was already saved.
 */

const deps = (pool: PoolLike) => ({ pool, wa: loadWhatsAppConfig(), env: process.env, now: () => new Date() });

/** A new pending request: ask the Director to decide. */
export async function onLeaveSubmitted(pool: PoolLike, requestId: string): Promise<void> {
  const item = await getRequestItem(pool, requestId);
  if (!item || item.status !== 'PENDING') return;
  await notifyDirectorOfLeave(pool, await loadSettings(pool), item);
  await flushOutbox(deps(pool));
}

/** Approved, rejected or cancelled: tell the employee. */
export async function onLeaveDecided(pool: PoolLike, requestId: string): Promise<void> {
  const item = await getRequestItem(pool, requestId);
  if (!item) return;
  await notifyEmployeeOfDecision(pool, await loadSettings(pool), item);
  await flushOutbox(deps(pool));
}

/** A plain reply to the employee, such as "that date is full". */
export async function replyToEmployee(pool: PoolLike, employeeId: number, body: string, key: string): Promise<void> {
  await queueLeaveReply(pool, employeeId, body, key);
  await flushOutbox(deps(pool));
}

// ── Permissions: the same flow, with the permission messages ────────────────────────────────
/** A new pending permission: ask the Director to decide. */
export async function onPermissionSubmitted(pool: PoolLike, requestId: string): Promise<void> {
  const item = await getPermissionItem(pool, requestId);
  if (!item || item.status !== 'PENDING') return;
  await notifyDirectorOfPermission(pool, await loadSettings(pool), item);
  await flushOutbox(deps(pool));
}

/** Approved, rejected or cancelled: tell the employee. */
export async function onPermissionDecided(pool: PoolLike, requestId: string): Promise<void> {
  const item = await getPermissionItem(pool, requestId);
  if (!item) return;
  await notifyEmployeeOfPermissionDecision(pool, await loadSettings(pool), item);
  await flushOutbox(deps(pool));
}
