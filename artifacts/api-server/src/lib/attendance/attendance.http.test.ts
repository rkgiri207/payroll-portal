import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import test, { after, before } from 'node:test';

// The routers import the shared database module, which needs a URL to exist. It is never
// connected to in this test: every request below is answered before any query runs.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';

const SECRET = 'test-app-secret';
let server: Server;
let base = '';

before(async () => {
  const [{ default: express }, { default: pino }, { default: pinoHttp }, webhook, attendance] = await Promise.all([
    import('express'), import('pino'), import('pino-http'),
    import('../../routes/attendanceWebhook'), import('../../routes/attendance'),
  ]);
  // Mirror the mounting order in app.ts: webhook BEFORE the JSON parser, other routes after.
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
  app.use('/api/attendance/webhook', webhook.default);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', attendance.default);
  app.post('/api/echo', (req, res) => { res.json({ body: req.body }); }); // stands in for any existing JSON route
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); });

function configure(enabled: boolean) {
  if (enabled) process.env.ATTENDANCE_ENABLED = 'true'; else delete process.env.ATTENDANCE_ENABLED;
  process.env.ATTENDANCE_WA_APP_SECRET = SECRET;
  process.env.ATTENDANCE_WA_VERIFY_TOKEN = 'verify-me';
}
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/attendance/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

test('with the kill switch off every attendance route answers 404', async () => {
  configure(false);
  assert.equal((await fetch(`${base}/api/attendance/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1`)).status, 404);
  assert.equal((await post('{}', { 'X-Hub-Signature-256': sign('{}') })).status, 404);
  assert.equal((await fetch(`${base}/api/attendance/link/anything`)).status, 404);
});

test('Meta verification handshake: right token echoes the challenge, wrong token is refused', async () => {
  configure(true);
  const ok = await fetch(`${base}/api/attendance/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  assert.equal((await fetch(`${base}/api/attendance/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
  assert.equal((await fetch(`${base}/api/attendance/webhook?hub.mode=subscribe&hub.challenge=1`)).status, 403);
  assert.equal((await fetch(`${base}/api/attendance/webhook`)).status, 403);
});

test('unsigned and wrongly signed webhook posts are rejected', async () => {
  configure(true);
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  assert.equal((await post(body)).status, 401);
  assert.equal((await post(body, { 'X-Hub-Signature-256': sign(body, 'other-secret') })).status, 401);
  assert.equal((await post(body, { 'X-Hub-Signature-256': 'sha256=zzz' })).status, 401);
  assert.equal((await post(body.replace('entry', 'entri'), { 'X-Hub-Signature-256': sign(body) })).status, 401); // tampered body
});

test('without an app secret configured the webhook refuses everything', async () => {
  configure(true);
  delete process.env.ATTENDANCE_WA_APP_SECRET;
  const body = '{}';
  assert.equal((await post(body, { 'X-Hub-Signature-256': sign(body) })).status, 503);
});

test('a correctly signed post is accepted, and the signature is checked on the exact raw bytes', async () => {
  configure(true);
  const compact = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  assert.equal((await post(compact, { 'X-Hub-Signature-256': sign(compact) })).status, 200);
  // Odd spacing and unicode would break a signature computed from re-serialised JSON.
  const quirky = '{ "object" : "whatsapp_business_account" ,\n "entry" : [ ] , "note": "नमस्ते  \\u00e9" }';
  assert.equal((await post(quirky, { 'X-Hub-Signature-256': sign(quirky) })).status, 200);
  assert.equal((await post('not json at all', { 'X-Hub-Signature-256': sign('not json at all') })).status, 400);
});

test('public link endpoints reject malformed tokens without touching the database', async () => {
  configure(true);
  const info = await fetch(`${base}/api/attendance/link/short`);
  assert.equal(info.status, 404);
  assert.deepEqual(await info.json(), { ok: false, state: 'NOT_FOUND' });
  assert.equal(info.headers.get('cache-control'), 'no-store');
  const location = await fetch(`${base}/api/attendance/link/short/location`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 1, lng: 2, accuracyM: 3 }),
  });
  assert.equal(location.status, 404);
  const selfie = await fetch(`${base}/api/attendance/link/short/selfie`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'x' }),
  });
  assert.equal(selfie.status, 404);
});

test('the external sweep trigger needs its secret', async () => {
  configure(true);
  const sweep = (headers: Record<string, string> = {}) =>
    fetch(`${base}/api/attendance/sweep`, { method: 'POST', headers });
  delete process.env.ATTENDANCE_SWEEP_SECRET;
  assert.equal((await sweep({ 'x-sweep-secret': 'anything' })).status, 503);   // not configured
  process.env.ATTENDANCE_SWEEP_SECRET = 'sweep-secret';
  assert.equal((await sweep()).status, 401);                                    // no header
  assert.equal((await sweep({ 'x-sweep-secret': 'wrong' })).status, 401);       // wrong secret
  configure(false);
  assert.equal((await sweep({ 'x-sweep-secret': 'sweep-secret' })).status, 404); // kill switch wins
  delete process.env.ATTENDANCE_SWEEP_SECRET;
});

test('admin endpoints need the module on AND a signed-in user', async () => {
  configure(false);
  assert.equal((await fetch(`${base}/api/attendance/admin/me`)).status, 404);          // module off
  configure(true);
  for (const path of ['/me', '/setup-status', '/settings', '/campuses', '/employees', '/dashboard', '/exceptions', '/unmarked']) {
    const response = await fetch(`${base}/api/attendance/admin${path}`);
    assert.equal(response.status, 401, path);                                           // not signed in
  }
  const write = await fetch(`${base}/api/attendance/admin/campuses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'X', name: 'X' }),
  });
  assert.equal(write.status, 401);
});

test('other routes still get a parsed JSON body (the webhook mounting does not disturb them)', async () => {
  configure(true);
  const response = await fetch(`${base}/api/echo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }),
  });
  assert.deepEqual(await response.json(), { body: { a: 1 } });
});
