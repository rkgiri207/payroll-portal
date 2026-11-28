import { portalBaseUrl } from '../attendance/alerts';
import type { PoolLike } from '../attendance/db';
import type { InboundMessage } from '../attendance/inbound';
import { enqueueMessage } from '../attendance/outboxStore';
import { loadSettings } from '../attendance/settings';
import { istParts } from '../attendance/time';
import { withTransaction } from '../attendance/db';
import { balanceText, leaveFormText, startLeaveForm } from './employeeLeave';

/**
 * The employee's WhatsApp commands for leave. Both reply inside the 24-hour window that the
 * employee's own message just opened, so plain text is enough and no template is needed.
 */

interface Deps { pool: PoolLike; env: NodeJS.ProcessEnv; now: () => Date }
interface Who { employeeId: number }

export const leaveFormUrl = (baseUrl: string, token: string) => `${baseUrl}/l/${token}`;

/** LEAVE: send a one-time link to the leave form. The link is cleared from the outbox once delivered. */
export async function handleLeaveCommand(deps: Deps, employee: Who, message: InboundMessage): Promise<void> {
  const settings = await loadSettings(deps.pool);
  const baseUrl = portalBaseUrl(settings, deps.env);
  if (!baseUrl) throw new Error('No public base URL is configured for leave links');
  await withTransaction(deps.pool, async q => {
    const token = await startLeaveForm(q, { employeeId: employee.employeeId, sourceMessageId: message.id, ttlMinutes: settings.formTokenTtlMinutes, now: deps.now() });
    if (!token) return; // the same WhatsApp message already produced a link
    await enqueueMessage(q, {
      recipientType: 'EMPLOYEE', recipientE164: message.from, employeeId: employee.employeeId, kind: 'LINK', deliveryMode: 'TEXT',
      payload: { body: leaveFormText(leaveFormUrl(baseUrl, token.token), settings.formTokenTtlMinutes) },
      idempotencyKey: `leave-form:${token.id}`,
    });
  });
}

/** BALANCE: reply with the balances for the current academic year. */
export async function handleBalanceCommand(deps: Deps, employee: Who, message: InboundMessage): Promise<void> {
  const body = await balanceText(deps.pool, employee.employeeId, istParts(deps.now()).workDate);
  await enqueueMessage(deps.pool, {
    recipientType: 'EMPLOYEE', recipientE164: message.from, employeeId: employee.employeeId, kind: 'LEAVE_INFO', deliveryMode: 'TEXT',
    payload: { body }, idempotencyKey: `reply:${message.id}:balance`,
  });
}
