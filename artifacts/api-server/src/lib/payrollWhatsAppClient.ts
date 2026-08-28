const TEMPLATE_NAME = 'payslip';

export class PayrollWhatsAppConfigurationError extends Error {}

export interface PayslipTemplateInput {
  recipient: string;
  employeeName: string;
  period: string;
  employeeReference: string;
  shareUrl: string;
}

export interface PayrollWhatsAppResult {
  messageId: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new PayrollWhatsAppConfigurationError(`${name} is not configured for the Payroll server`);
  return value;
}

function templateConfiguration() {
  const language = process.env.WHATSAPP_PAYSLIP_TEMPLATE_LANGUAGE?.trim() || 'en';
  const buttonIndex = process.env.WHATSAPP_PAYSLIP_URL_BUTTON_INDEX?.trim() || '0';
  const ctaType = process.env.WHATSAPP_PAYSLIP_CTA_TYPE?.trim() || 'static';
  if (ctaType !== 'dynamic') {
    throw new PayrollWhatsAppConfigurationError(
      'The approved payslip template uses a static Visit Website CTA. A dynamic URL CTA is required before Stage 4A links can be sent.',
    );
  }
  const parameterMode = process.env.WHATSAPP_PAYSLIP_URL_PARAMETER_MODE?.trim();
  if (!/^[0-9]+$/.test(buttonIndex) || !['full_url', 'token'].includes(parameterMode ?? '')) {
    throw new PayrollWhatsAppConfigurationError(
      'The dynamic payslip CTA configuration is incomplete. Confirm its button index and whether Meta expects the full URL or token suffix.',
    );
  }
  return { language, buttonIndex, parameterMode: parameterMode as 'full_url' | 'token' };
}

export function assertPayrollWhatsAppTemplateReady(): void {
  templateConfiguration();
}

function templateComponents(input: PayslipTemplateInput) {
  const { language, buttonIndex, parameterMode } = templateConfiguration();

  const urlParameter = parameterMode === 'token'
    ? new URL(input.shareUrl).pathname.split('/').filter(Boolean).at(-1)
    : input.shareUrl;
  if (!urlParameter) throw new PayrollWhatsAppConfigurationError('The secure payslip URL could not be mapped to the approved template CTA');

  return {
    language,
    components: [
      {
        type: 'header',
        parameters: [{ type: 'text', text: input.period }],
      },
      {
        type: 'body',
        parameters: [input.employeeName, input.period]
          .map(text => ({ type: 'text', text })),
      },
      {
        type: 'button',
        sub_type: 'url',
        index: buttonIndex,
        parameters: [{ type: 'text', text: urlParameter }],
      },
    ],
  };
}

function safeMetaError(body: any, status: number): { code: string; message: string } {
  const error = body?.error;
  return {
    code: String(error?.code ?? status),
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'WhatsApp Cloud API request failed',
  };
}

export async function sendPayrollPayslipTemplate(input: PayslipTemplateInput): Promise<PayrollWhatsAppResult> {
  const accessToken = required('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = required('WHATSAPP_PHONE_NUMBER_ID');
  const graphApiVersion = required('WHATSAPP_GRAPH_API_VERSION');
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) {
    throw new PayrollWhatsAppConfigurationError('WHATSAPP_GRAPH_API_VERSION must be an explicit Meta Graph API version such as vXX.0');
  }
  const { language, components } = templateComponents(input);
  const response = await fetch(`https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.recipient,
      type: 'template',
      template: { name: TEMPLATE_NAME, language: { code: language }, components },
    }),
  });
  const body: any = await response.json().catch(() => null);
  if (!response.ok) {
    const safe = safeMetaError(body, response.status);
    throw Object.assign(new Error(safe.message), { code: safe.code, definitive: true });
  }
  const messageId = body?.messages?.[0]?.id;
  if (typeof messageId !== 'string' || !messageId) {
    throw Object.assign(new Error('Meta accepted the request without returning a message ID'), { code: 'MISSING_MESSAGE_ID' });
  }
  return { messageId };
}

export const PAYROLL_WHATSAPP_TEMPLATE = TEMPLATE_NAME;
