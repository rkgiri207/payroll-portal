import { writeAudit } from '../attendance/auditStore';
import { parseCommand } from '../attendance/commands';
import type { PoolLike, Queryable } from '../attendance/db';
import type { InboundMessage } from '../attendance/inbound';
import { loadSettings } from '../attendance/settings';
import { approveLeave, rejectLeave, type DecisionResult } from './decisionService';
import { dayRangeText, notifyEmployeeOfDecision, queueDirectorReply, splitText } from './leaveNotifications';
import { parseDecisionPayload } from './leaveTemplates';
import { notifyEmployeeOfPermissionDecision, permissionWhen } from './permissionNotifications';
import { approvePermission, rejectPermission, type PermissionDecision } from './permissionService';
import { getPermissionItem } from './permissionStore';
import { getRequestItem } from './requestQueries';

/**
 * The Director answering a leave or permission request on WhatsApp.
 *
 * Tapping Approve decides at once. Tapping Reject asks for a reason; the Director's next text
 * message becomes it. WHO is answering is decided here by comparing the sender's number with the
 * Director's saved number, never by trusting anything inside the message. A number that is not the
 * Director's is ignored without a reply. Meta's webhook signature has already been verified before a
 * message reaches this code, and each message is processed once.
 */

const REJECT_REASON_MINUTES = 10;

export type DirectorOutcome = 'REPLIED' | 'IGNORED_UNREGISTERED';
type Kind = 'LEAVE' | 'PERMISSION';

async function openPendingInput(q: Queryable): Promise<{ id: string; requestId: string; kind: Kind } | null> {
  const { rows } = await q.query<{ id: string; request_id: string; request_kind: Kind }>(
    `select id, request_id, request_kind from director_pending_input
      where consumed_at is null and expires_at > now() order by created_at desc limit 1`,
  );
  return rows[0] ? { id: rows[0].id, requestId: rows[0].request_id, kind: rows[0].request_kind } : null;
}

const consume = (q: Queryable, id: string) => q.query('update director_pending_input set consumed_at = now() where id = $1 and consumed_at is null', [id]);

/** What the Director needs to see about a request, whichever kind it is. */
async function describe(pool: PoolLike, kind: Kind, id: string): Promise<{ status: string; who: string; ask: string; done: string } | null> {
  if (kind === 'LEAVE') {
    const r = await getRequestItem(pool, id);
    return r && { status: r.status, who: r.employeeName, ask: `${r.leaveTypeName} (${dayRangeText(r)})`, done: `${r.leaveTypeName}, ${dayRangeText(r)} (${splitText(r)})` };
  }
  const p = await getPermissionItem(pool, id);
  return p && { status: p.status, who: p.employeeName, ask: `permission (${permissionWhen(p)})`, done: `permission, ${permissionWhen(p)}` };
}

/**
 * Handle a message that might be the Director's answer. Returns null when it is not one (so the
 * normal employee commands carry on), otherwise how it was handled.
 */
export async function handleDirectorMessage(pool: PoolLike, message: InboundMessage): Promise<DirectorOutcome | null> {
  const tap = parseDecisionPayload(message.buttonPayload ?? null);
  const pending = !tap && message.type === 'text' ? await openPendingInput(pool) : null;
  if (!tap && !pending) return null;

  const settings = await loadSettings(pool);
  if (!settings.directorWhatsapp || message.from !== settings.directorWhatsapp) {
    // Someone else tapped a button or typed while the Director's reason was awaited: not theirs to decide.
    return tap ? 'IGNORED_UNREGISTERED' : null;
  }
  const reply = (text: string, suffix: string) => queueDirectorReply(pool, settings, text, `dir-reply:${message.id}:${suffix}`);

  const finish = async (kind: Kind, result: DecisionResult | PermissionDecision, requestId: string, approved: boolean) => {
    if (result.status === 'NOT_FOUND') { await reply(`That ${kind.toLowerCase()} request could not be found.`, 'nf'); return; }
    if (result.status === 'ALREADY') { await reply(`This request was already ${result.request.status.toLowerCase()}. Nothing was changed.`, 'already'); return; }
    if (result.status === 'REFUSED') { await reply(result.message, 'refused'); return; }
    const info = await describe(pool, kind, requestId);
    if (!info) return;
    const action = `${kind}_${approved ? 'APPROVED' : 'REJECTED'}`;
    await writeAudit(pool, {
      actorType: 'WEBHOOK', action, entityType: kind === 'LEAVE' ? 'leave_request' : 'permission_request', entityId: requestId,
      newValue: { status: info.status, via: 'WHATSAPP' },
    });
    if (kind === 'LEAVE') {
      const item = await getRequestItem(pool, requestId);
      if (item) await notifyEmployeeOfDecision(pool, settings, item);
    } else {
      const item = await getPermissionItem(pool, requestId);
      if (item) await notifyEmployeeOfPermissionDecision(pool, settings, item);
    }
    await reply(`${approved ? 'Approved' : 'Not approved'}: ${info.who}, ${info.done}. ${info.who} has been told.`, 'done');
  };

  const decide = (kind: Kind, requestId: string, approve: boolean, note?: string) => {
    if (kind === 'LEAVE') {
      return approve ? approveLeave(pool, { requestId, via: 'WHATSAPP', userId: null }) : rejectLeave(pool, { requestId, via: 'WHATSAPP', userId: null, note });
    }
    return approve ? approvePermission(pool, { requestId, via: 'WHATSAPP', userId: null }) : rejectPermission(pool, { requestId, via: 'WHATSAPP', userId: null, note });
  };

  if (tap) {
    if (tap.action === 'APPROVE') {
      await finish(tap.kind, await decide(tap.kind, tap.requestId, true), tap.requestId, true);
      return 'REPLIED';
    }
    const info = await describe(pool, tap.kind, tap.requestId);
    if (!info) { await reply(`That ${tap.kind.toLowerCase()} request could not be found.`, 'nf'); return 'REPLIED'; }
    if (info.status !== 'PENDING') { await reply(`This request was already ${info.status.toLowerCase()}. Nothing was changed.`, 'already'); return 'REPLIED'; }
    await pool.query('update director_pending_input set consumed_at = now() where consumed_at is null');
    await pool.query(
      `insert into director_pending_input (request_kind, request_id, action, expires_at)
       values ($1, $2, 'REJECT', now() + ($3 || ' minutes')::interval)`,
      [tap.kind, tap.requestId, String(REJECT_REASON_MINUTES)],
    );
    await reply(`Please reply with the reason for not approving ${info.who}'s ${info.ask}. Reply CANCEL to leave it pending.`, 'ask');
    return 'REPLIED';
  }

  // The Director's text while a rejection reason is awaited.
  const input = pending!;
  const text = (message.text ?? '').trim();
  // A command such as IN or OUT (the Director may mark their own attendance) is never taken as a reason.
  if (parseCommand(text)) return null;
  if (text.toUpperCase() === 'CANCEL') {
    await consume(pool, input.id);
    await reply('Understood. The request is still pending.', 'cancelled');
    return 'REPLIED';
  }
  const result = await decide(input.kind, input.requestId, false, text);
  if (result.status === 'REFUSED') { await reply(result.message, 'refused'); return 'REPLIED'; } // keep waiting for a valid reason
  await consume(pool, input.id);
  await finish(input.kind, result, input.requestId, false);
  return 'REPLIED';
}
