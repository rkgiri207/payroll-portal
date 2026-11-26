import type { Queryable } from './db';
import { claimDueMessages, markSendFailure, markSent, type OutboxMessage } from './outboxStore';
import { sendMessage, SendError, type SendResult, type WhatsAppConfig } from './whatsappSender';

export interface ProcessSummary {
  claimed: number;
  sent: number;
  stubbed: number;
  retried: number;
  failed: number;
}

type Sender = (message: OutboxMessage, config: WhatsAppConfig) => Promise<SendResult>;

/**
 * Send due outbox messages. Called right after an event is saved (best effort) and by the
 * scheduled sweeper, which retries anything that failed. A failed message is never lost: it
 * stays in the outbox as QUEUED (retrying with back-off) or FAILED, and shows on the dashboard.
 *
 * Known limit: if the process dies after Meta accepted a message but before it is marked
 * SENT, the message is retried once its short lock expires and could be delivered twice.
 */
export async function processOutbox(
  db: Queryable,
  config: WhatsAppConfig,
  opts: { limit?: number; sender?: Sender } = {},
): Promise<ProcessSummary> {
  const send: Sender = opts.sender ?? ((message, cfg) => sendMessage(message, cfg));
  const messages = await claimDueMessages(db, Math.min(Math.max(opts.limit ?? 10, 1), 50));
  const summary: ProcessSummary = { claimed: messages.length, sent: 0, stubbed: 0, retried: 0, failed: 0 };

  await Promise.all(
    messages.map(async message => {
      try {
        const result = await send(message, config);
        await markSent(db, message.id, {
          metaMessageId: result.metaMessageId,
          stubbed: result.stubbed,
          clearPayload: message.kind === 'LINK', // do not keep the secret link after delivery
        });
        if (result.stubbed) summary.stubbed += 1;
        else summary.sent += 1;
      } catch (error) {
        const sendError = error instanceof SendError ? error : null;
        const outcome = await markSendFailure(
          db,
          message,
          sendError ? sendError.message : 'Unexpected sending error',
          { definitive: sendError ? !sendError.retryable : false },
        );
        if (outcome === 'FAILED') summary.failed += 1;
        else summary.retried += 1;
      }
    }),
  );
  return summary;
}
