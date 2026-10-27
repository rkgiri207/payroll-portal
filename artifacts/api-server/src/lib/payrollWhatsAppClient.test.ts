import assert from "node:assert/strict";
import test from "node:test";
import {
  PayrollWhatsAppConfigurationError,
  sendPayrollPayslipTemplate,
} from "./payrollWhatsAppClient";

const envNames = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_GRAPH_API_VERSION",
  "WHATSAPP_PAYSLIP_TEMPLATE_LANGUAGE",
  "WHATSAPP_PAYSLIP_URL_BUTTON_INDEX",
  "WHATSAPP_PAYSLIP_CTA_TYPE",
  "WHATSAPP_PAYSLIP_URL_PARAMETER_MODE",
] as const;

async function withMockedEnvironment(run: () => Promise<void>): Promise<void> {
  const original = new Map(envNames.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;

  try {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_GRAPH_API_VERSION = "v99.0";
    process.env.WHATSAPP_PAYSLIP_TEMPLATE_LANGUAGE = "en";
    process.env.WHATSAPP_PAYSLIP_URL_BUTTON_INDEX = "0";
    process.env.WHATSAPP_PAYSLIP_CTA_TYPE = "dynamic";
    process.env.WHATSAPP_PAYSLIP_URL_PARAMETER_MODE = "full_url";

    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("sends the established payslip template contract through mocked fetch", async () => {
  await withMockedEnvironment(async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await sendPayrollPayslipTemplate({
      recipient: "919999999999",
      employeeName: "Test Employee",
      period: "January 2026",
      employeeReference: "TEST001",
      shareUrl: "https://preview.invalid/p/token",
    });

    assert.equal(result.messageId, "wamid.test");
    assert.equal(requestedUrl, "https://graph.facebook.com/v99.0/123456/messages");
    assert.equal(requestedInit?.method, "POST");
    assert.equal(requestedInit?.headers && (requestedInit.headers as Record<string, string>).Authorization, "Bearer test-token");

    const body = JSON.parse(String(requestedInit?.body));
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.type, "template");
    assert.equal(body.template.name, "payslip");
    assert.equal(body.template.language.code, "en");
    assert.deepEqual(body.template.components, [
      {
        type: "header",
        parameters: [{ type: "text", text: "January 2026" }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Test Employee" },
          { type: "text", text: "January 2026" },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "https://preview.invalid/p/token" }],
      },
    ]);
  });
});

test("does not send when the configured CTA is static", async () => {
  await withMockedEnvironment(async () => {
    process.env.WHATSAPP_PAYSLIP_CTA_TYPE = "static";
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response();
    };

    await assert.rejects(
      () => sendPayrollPayslipTemplate({
        recipient: "919999999999",
        employeeName: "Test Employee",
        period: "January 2026",
        employeeReference: "TEST001",
        shareUrl: "https://preview.invalid/p/token",
      }),
      PayrollWhatsAppConfigurationError,
    );
    assert.equal(called, false);
  });
});
