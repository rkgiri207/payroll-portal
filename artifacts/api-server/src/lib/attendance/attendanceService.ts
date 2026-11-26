import { attendanceLink, portalBaseUrl, queueEmployeeText, queueLinkMessage } from './alerts';
import {
  findEmployeeByWhatsApp, getCampus, listAllowedCampuses, type RegisteredEmployee,
} from './campusData';
import { parseCommand } from './commands';
import { withTransaction, type PoolLike } from './db';
import { findValidEvent } from './eventStore';
import type { InboundMessage, InboundStatus } from './inbound';
import {
  alreadyMarkedText, campusChoiceText, comingSoonText, helpText, needInFirstText, noCampusText,
} from './messages';
import { applyDeliveryStatus } from './outboxStore';
import { processOutbox } from './outboxWorker';
import { loadSettings } from './settings';
import { istParts } from './time';
import { createToken } from './tokenStore';
import { claimWebhookEvent, setWebhookOutcome, type WebhookOutcome } from './webhookStore';
import { maskPhone } from './webhookSecurity';
import type { WhatsAppConfig } from './whatsappSender';

export interface ServiceDeps {
  pool: PoolLike;
  wa: WhatsAppConfig;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

/**
 * Send what was just queued, best effort and time-boxed so the web request stays fast.
 * Anything not sent in time stays in the outbox and is retried by the scheduled sweeper.
 */
export async function flushOutbox(deps: ServiceDeps, timeoutMs = 4_000): Promise<void> {
  try {
    await Promise.race([
      processOutbox(deps.pool, deps.wa, { limit: 10 }),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // The messages remain queued; the sweeper will retry them.
  }
}

export type InboundResult = WebhookOutcome | 'DUPLICATE';

/**
 * Handle one inbound WhatsApp message. Only a recognised command from a registered, active
 * employee does anything. Strangers and ordinary chat get NO reply and start no workflow.
 */
export async function handleInboundMessage(deps: ServiceDeps, message: InboundMessage): Promise<InboundResult> {
  const fromMasked = maskPhone(message.from);

  if (message.isGroup) {
    if (await claimWebhookEvent(deps.pool, { eventKey: `msg:${message.id}`, kind: 'MESSAGE', fromMasked, command: null, employeeId: null })) {
      await setWebhookOutcome(deps.pool, `msg:${message.id}`, 'IGNORED_GROUP');
    }
    return 'IGNORED_GROUP';
  }

  const employee = await findEmployeeByWhatsApp(deps.pool, message.from);
  const parsed = employee && message.type === 'text' ? parseCommand(message.text) : null;
  const eventKey = `msg:${message.id}`;

  const fresh = await claimWebhookEvent(deps.pool, {
    eventKey, kind: 'MESSAGE', fromMasked, command: parsed?.command ?? null, employeeId: employee?.employeeId ?? null,
  });
  if (!fresh) return 'DUPLICATE';

  const finish = async (outcome: WebhookOutcome, detail: string | null = null): Promise<InboundResult> => {
    await setWebhookOutcome(deps.pool, eventKey, outcome, detail);
    return outcome;
  };

  if (!employee) return finish('IGNORED_UNREGISTERED');
  if (message.type !== 'text') return finish('IGNORED_NOT_TEXT');
  if (!parsed) return finish('IGNORED_NOT_COMMAND');

  try {
    const reply = (kind: 'HELP' | 'COMING_SOON' | 'CAMPUS_CHOICE', body: string, suffix: string) =>
      queueEmployeeText(deps.pool, {
        employee: { id: employee.employeeId, whatsapp: message.from },
        kind, body, idempotencyKey: `reply:${message.id}:${suffix}`,
      });

    switch (parsed.command) {
      case 'HELP':
        await reply('HELP', helpText(), 'help');
        break;
      case 'LEAVE':
      case 'PERMISSION':
      case 'BALANCE':
        await reply('COMING_SOON', comingSoonText(), 'soon');
        break;
      case 'IN':
      case 'OUT':
        await startAttendance(deps, employee, parsed.command, parsed.choice, message);
        break;
    }
    await flushOutbox(deps);
    return finish('REPLIED');
  } catch (error) {
    return finish('ERROR', error instanceof Error ? error.message : 'Unexpected error');
  }
}

/** Create a one-time link for IN or OUT and queue it to the employee. */
async function startAttendance(
  deps: ServiceDeps,
  employee: RegisteredEmployee,
  type: 'IN' | 'OUT',
  choice: number | null,
  message: InboundMessage,
): Promise<void> {
  const settings = await loadSettings(deps.pool);
  const { workDate } = istParts(deps.now());
  const info = (body: string, suffix: string) =>
    queueEmployeeText(deps.pool, {
      employee: { id: employee.employeeId, whatsapp: message.from },
      kind: 'HELP', body, idempotencyKey: `reply:${message.id}:${suffix}`,
    });

  const existing = await findValidEvent(deps.pool, employee.employeeId, workDate, type);
  if (existing) {
    await info(alreadyMarkedText({ type, at: existing.serverTs }), 'already');
    return;
  }

  let campusId: number;
  let campusName: string;
  if (type === 'OUT') {
    // An OUT belongs to the campus where the day's IN was recorded.
    const inEvent = await findValidEvent(deps.pool, employee.employeeId, workDate, 'IN');
    if (!inEvent) {
      await info(needInFirstText(), 'needin');
      return;
    }
    const campus = await getCampus(deps.pool, inEvent.campusId);
    if (!campus) {
      await info(noCampusText(), 'nocampus');
      return;
    }
    campusId = campus.id;
    campusName = campus.name;
  } else {
    const allowed = await listAllowedCampuses(deps.pool, employee.employeeId, workDate);
    if (allowed.length === 0) {
      await info(noCampusText(), 'nocampus');
      return;
    }
    const picked = allowed.length === 1 ? allowed[0] : choice ? allowed[choice - 1] : undefined;
    if (!picked) {
      await queueEmployeeText(deps.pool, {
        employee: { id: employee.employeeId, whatsapp: message.from },
        kind: 'CAMPUS_CHOICE',
        body: campusChoiceText(type, allowed.map(a => ({ campusName: a.campusName }))),
        idempotencyKey: `reply:${message.id}:choice`,
      });
      return;
    }
    campusId = picked.campusId;
    campusName = picked.campusName;
  }

  const baseUrl = portalBaseUrl(settings, deps.env);
  if (!baseUrl) throw new Error('No public base URL is configured for attendance links');

  await withTransaction(deps.pool, async q => {
    const token = await createToken(q, {
      employeeId: employee.employeeId, campusId, eventType: type, workDate,
      ttlMinutes: settings.tokenTtlMinutes, sourceMessageId: message.id,
    });
    if (!token) return; // the same message already produced a link
    await queueLinkMessage(q, {
      employee: { id: employee.employeeId, whatsapp: message.from },
      tokenId: token.id, type, campusName,
      url: attendanceLink(baseUrl, token.token), ttlMinutes: settings.tokenTtlMinutes,
    });
  });
}

/** Apply a delivery status Meta reported for one of our messages. Foreign messages are ignored. */
export async function handleDeliveryStatus(deps: ServiceDeps, status: InboundStatus): Promise<boolean> {
  return applyDeliveryStatus(deps.pool, status.id, status.status, status.error);
}
