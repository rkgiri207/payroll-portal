import type { OutboxMessage } from './outboxStore';
import { maskPhone } from './webhookSecurity';

/**
 * Attendance WhatsApp sender. It uses its OWN environment variables and never reads or
 * changes the payslip/receipt WhatsApp configuration.
 *
 *   ATTENDANCE_WA_MODE             stub (default) | live
 *   ATTENDANCE_WA_ACCESS_TOKEN     Meta access token         (secret; never logged)
 *   ATTENDANCE_WA_PHONE_NUMBER_ID  sending number's ID
 *   ATTENDANCE_WA_GRAPH_VERSION    e.g. v21.0
 *
 * In stub mode nothing is sent: the message is only recorded in the outbox as STUBBED.
 */

export interface WhatsAppConfig {
  mode: 'stub' | 'live';
  accessToken: string | null;
  phoneNumberId: string | null;
  graphVersion: string | null;
}

export function loadWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig {
  const clean = (value: string | undefined) => value?.trim() || null;
  return {
    mode: clean(env.ATTENDANCE_WA_MODE)?.toLowerCase() === 'live' ? 'live' : 'stub',
    accessToken: clean(env.ATTENDANCE_WA_ACCESS_TOKEN),
    phoneNumberId: clean(env.ATTENDANCE_WA_PHONE_NUMBER_ID),
    graphVersion: clean(env.ATTENDANCE_WA_GRAPH_VERSION),
  };
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Retrying can help (network problem, rate limit, Meta outage). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SendError';
  }
}

export interface SendResult {
  metaMessageId: string | null;
  stubbed: boolean;
}

interface SendDeps {
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
}

/** Meta error codes that are temporary even though they arrive with a 4xx status. */
const RETRYABLE_META_CODES = new Set(['4', '80007', '130429', '131016', '131000', '133004', '133016']);

function buildRequestBody(message: OutboxMessage): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.recipientE164 };

  if (message.deliveryMode === 'TEXT') {
    const body = message.payload.body;
    if (typeof body !== 'string' || !body.trim()) {
      throw new SendError('Message has no text body', 'INVALID_PAYLOAD', false);
    }
    return { ...base, type: 'text', text: { preview_url: false, body } };
  }

  const params = message.payload.params;
  if (!message.templateName || !Array.isArray(params) || params.some(p => typeof p !== 'string')) {
    throw new SendError('Template message is missing its name or parameters', 'INVALID_PAYLOAD', false);
  }
  // Quick-reply buttons (for example Approve / Reject): each carries a payload that comes back when tapped.
  const rawButtons = message.payload.buttons;
  if (rawButtons !== undefined && (!Array.isArray(rawButtons) || rawButtons.length > 3
    || rawButtons.some(b => typeof b !== 'string' || b.length === 0 || b.length > 256))) {
    throw new SendError('Template buttons are not valid', 'INVALID_PAYLOAD', false);
  }
  const buttons = (rawButtons as string[] | undefined) ?? [];
  return {
    ...base,
    type: 'template',
    template: {
      name: message.templateName,
      language: { code: message.templateLanguage || 'en' },
      components: [
        ...(params.length ? [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }] : []),
        ...buttons.map((payload, index) => ({
          type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }],
        })),
      ],
    },
  };
}

/** Send (or, in stub mode, pretend to send) one outbox message. Never logs tokens or content. */
export async function sendMessage(
  message: OutboxMessage,
  config: WhatsAppConfig,
  deps: SendDeps = {},
): Promise<SendResult> {
  if (!/^[1-9][0-9]{7,14}$/.test(message.recipientE164)) {
    throw new SendError('Recipient number is not valid', 'INVALID_RECIPIENT', false);
  }
  const body = buildRequestBody(message); // validates the payload in every mode

  if (config.mode === 'stub') {
    (deps.log ?? console.info)(
      `[attendance-whatsapp] STUB ${message.kind} to ${maskPhone(message.recipientE164)} (${message.deliveryMode})`,
    );
    return { metaMessageId: null, stubbed: true };
  }

  if (!config.accessToken || !config.phoneNumberId || !config.graphVersion) {
    throw new SendError('Attendance WhatsApp is not fully configured', 'NOT_CONFIGURED', false);
  }
  if (!/^v\d+\.\d+$/.test(config.graphVersion)) {
    throw new SendError('ATTENDANCE_WA_GRAPH_VERSION must look like v21.0', 'NOT_CONFIGURED', false);
  }

  const doFetch = deps.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await doFetch(
      `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    throw new SendError('Could not reach WhatsApp', 'NETWORK', true);
  }

  const result = (await response.json().catch(() => null)) as
    | { messages?: { id?: string }[]; error?: { code?: number | string; message?: string } }
    | null;

  if (!response.ok) {
    const code = String(result?.error?.code ?? response.status);
    const text = typeof result?.error?.message === 'string' ? result.error.message.slice(0, 300) : 'WhatsApp request failed';
    const retryable = response.status === 429 || response.status >= 500 || RETRYABLE_META_CODES.has(code);
    throw new SendError(`${code}: ${text}`, code, retryable);
  }

  const metaMessageId = result?.messages?.[0]?.id;
  if (typeof metaMessageId !== 'string' || !metaMessageId) {
    // Meta accepted the request but gave no ID. Do not retry: it may already have been sent.
    throw new SendError('WhatsApp accepted the message without returning an ID', 'MISSING_MESSAGE_ID', false);
  }
  return { metaMessageId, stubbed: false };
}
