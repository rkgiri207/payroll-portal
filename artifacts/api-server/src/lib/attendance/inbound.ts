/**
 * Turn Meta's webhook JSON into a simple list of messages and delivery statuses.
 * Defensive: anything unexpected is skipped, never thrown.
 */

export interface InboundMessage {
  id: string;
  /** Sender's number, digits only (e.g. 919849136605). */
  from: string;
  type: string;
  text: string | null;
  isGroup: boolean;
}

export interface InboundStatus {
  id: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  error: string | null;
}

const STATUS_MAP: Record<string, InboundStatus['status']> = {
  sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const digitsOnly = (value: unknown): string => (typeof value === 'string' ? value.replace(/\D/g, '') : '');

export function extractInbound(body: unknown): { messages: InboundMessage[]; statuses: InboundStatus[] } {
  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];
  if (!isRecord(body) || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return { messages, statuses };
  }

  for (const entry of body.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      const value = change.value;
      const ownNumber = isRecord(value.metadata) ? digitsOnly(value.metadata.display_phone_number) : '';

      if (Array.isArray(value.messages)) {
        for (const raw of value.messages) {
          if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) continue;
          const from = digitsOnly(raw.from);
          if (!from || (ownNumber && from === ownNumber)) continue; // never react to our own number
          const textBody = isRecord(raw.text) && typeof raw.text.body === 'string' ? raw.text.body : null;
          messages.push({
            id: raw.id,
            from,
            type: typeof raw.type === 'string' ? raw.type : 'unknown',
            text: textBody,
            isGroup: 'group_id' in raw,
          });
        }
      }

      if (Array.isArray(value.statuses)) {
        for (const raw of value.statuses) {
          if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.status !== 'string') continue;
          const status = STATUS_MAP[raw.status];
          if (!status) continue;
          let error: string | null = null;
          if (Array.isArray(raw.errors) && isRecord(raw.errors[0])) {
            const first = raw.errors[0];
            error = [first.code, first.title].filter(part => part !== undefined && part !== null).join(': ').slice(0, 300) || null;
          }
          statuses.push({ id: raw.id, status, error });
        }
      }
    }
  }
  return { messages, statuses };
}
