import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createEstimatorAPI, digest, normalizePhone } from '../estimator-api.mjs';
import { createWorker } from '../worker.mjs';
import { estimateTotal, rowPrice, productKey } from '../js/estimator-math.js';
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_estimator_auth.sql', import.meta.url), 'utf8'));
  const db = { sql, prepare(query) { return { bind(...values) { return {
    async first() { return sql.prepare(query).get(...values) || null; },
    async run() { return sql.prepare(query).run(...values); },
  }; } }; }, async batch(statements) { sql.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return db;
}
const base = { ESTIMATOR_ACCESS_MODE: 'open', APP_BACKEND_ORIGIN: 'https://app.example.com', WEBSITE_DOWNLOAD_TOKEN: 'shortkey' };
const creds = { TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'test-only', TWILIO_VERIFY_SERVICE_SID: 'VA' + 'b'.repeat(32), OTP_CHANNEL: 'sms' };
const req = (path, data, cookie, origin = 'https://lmccables.com') => new Request('https://lmccables.com/api/estimator/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });

test('open mode only forwards allowlisted read-only catalog routes; switching to OTP immediately gates data', async () => {
  const calls = [];
  const app = createWorker(async (url, options) => { calls.push([String(url), options]); return Response.json({ brands: [] }); });
  let r = await app.fetch(req('catalog'), base); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0][0], 'https://app.example.com/api/website/estimator/catalog');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer shortkey');
  for (const path of ['pdf', 'workspaces', 'auth/send', '../web/catalog']) {
    assert.equal((await app.fetch(req(path, path === 'auth/send' ? { phone: '9830053838' } : undefined), base)).status, 404);
  }
  for (const path of ['catalog', 'grid?brand=kei&category=Al&tag=a&display_name=b']) {
    assert.equal((await app.fetch(req(path), { ...base, ESTIMATOR_ACCESS_MODE: 'otp' })).status, 401);
  }
  assert.equal(calls.length, 1);
  assert.equal((await app.fetch(req('catalog'), { ...base, ESTIMATOR_ACCESS_MODE: 'typo' })).status, 503);
  assert.equal((await app.fetch(req('catalog', {}), base)).status, 405);
  assert.equal((await app.fetch(req('catalog', undefined, null, 'https://evil.example'), base)).status, 403);
});

test('grid proxy strips extra query parameters and never forwards browser auth', async () => {
  let captured;
  const api = createEstimatorAPI(async (url, options) => { captured = [new URL(url), options]; return Response.json({ grids: [] }); });
  const r = await api(req('grid?brand=kei&category=Al&tag=2026&display_name=Latest&url=https://evil.example&path=/admin'), base);
  assert.equal(r.status, 200); assert.equal(captured[0].pathname, '/api/website/estimator/grid');
  assert.equal([...captured[0].searchParams].length, 4); assert.equal(captured[1].redirect, 'manual');
  assert.equal((await api(req('grid'), base)).status, 400);
});

test('OTP lifecycle: wrong code, verification, hashed 30-day session, optional name, expiry and logout', async () => {
  const db = database(); let now = 1800000000, sends = 0, checks = 0;
  const env = { ...base, ...creds, ESTIMATOR_ACCESS_MODE: 'otp', ESTIMATOR_DB: db };
  const api = createEstimatorAPI(async (url, options) => {
    if (String(url).endsWith('/Verifications')) { sends++; assert.equal(options.body.get('Channel'), 'sms'); return Response.json({ sid: 'VE' + 'c'.repeat(32), status: 'pending' }); }
    if (String(url).endsWith('/VerificationCheck')) { checks++; return Response.json({ status: options.body.get('Code') === '123456' ? 'approved' : 'pending', to: '+919830053838' }); }
    return Response.json({ brands: [] });
  }, () => now);
  const sent = await api(req('auth/send', { phone: '98300 53838' }), env); assert.equal(sent.status, 200);
  const { challenge } = await sent.json();
  assert.equal(db.sql.prepare('SELECT count(*) n FROM contacts').get().n, 0);
  assert.equal((await api(req('auth/send', { phone: '9830053838' }), env)).status, 429);
  assert.equal(sends, 1);
  assert.equal((await api(req('auth/verify', { challenge, code: '111111' }), env)).status, 400);
  const verified = await api(req('auth/verify', { challenge, code: '123456' }), env);
  assert.equal(verified.status, 200); assert.equal((await verified.json()).needs_name, true);
  const fullCookie = verified.headers.get('set-cookie'), cookie = fullCookie.split(';')[0];
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=2592000']) assert.ok(fullCookie.includes(attribute));
  const row = db.sql.prepare('SELECT * FROM estimator_sessions').get();
  assert.equal(row.token_hash, await digest(cookie.split('=')[1])); assert.equal(row.expires_at, now + 2592000);
  assert.equal((await api(req('catalog', undefined, cookie), env)).status, 200);
  assert.equal((await api(req('auth/verify', { challenge, code: '123456' }), env)).status, 400);
  assert.equal(checks, 2);
  assert.equal((await api(req('auth/name', { name: 'Test customer' }, cookie), env)).status, 200);
  assert.equal(db.sql.prepare('SELECT name FROM contacts').get().name, 'Test customer');
  assert.equal((await api(req('auth/name', { name: 'x' }, cookie, 'https://evil.example'), env)).status, 403);
  now += 2592001; assert.equal((await api(req('catalog', undefined, cookie), env)).status, 401);
  now -= 2592001;
  assert.equal((await api(req('auth/logout', {}, cookie), env)).status, 200);
  assert.equal((await api(req('catalog', undefined, cookie), env)).status, 401);
  assert.equal(db.sql.prepare('SELECT count(*) n FROM contacts').get().n, 1);
});

test('OTP attempts capped, expiration enforced, misconfiguration fails closed, no contact capture in open mode', async () => {
  const db = database(); let now = 1800000000, checks = 0;
  const env = { ...base, ...creds, ESTIMATOR_ACCESS_MODE: 'otp', ESTIMATOR_DB: db };
  const api = createEstimatorAPI(async (url) => {
    if (String(url).endsWith('/Verifications')) return Response.json({ sid: 'VE' + 'd'.repeat(32), status: 'pending' });
    checks++; return Response.json({ status: 'pending', to: '+919830053838' });
  }, () => now);
  assert.equal((await api(req('auth/send', { phone: '9830053838' }), { ...env, TWILIO_AUTH_TOKEN: '' })).status, 503);
  for (const path of ['send', 'verify', 'name']) assert.equal((await api(req('auth/' + path, {}), { ...env, ESTIMATOR_ACCESS_MODE: 'open' })).status, 404);
  let r = await api(req('auth/send', { phone: '9830053838' }), env); const { challenge } = await r.json();
  for (let i = 0; i < 6; i++) assert.equal((await api(req('auth/verify', { challenge, code: '111111' }), env)).status, 400);
  assert.equal(checks, 5);
  now += 901; r = await api(req('auth/send', { phone: '9830053838' }), env); const second = await r.json();
  now += 601; assert.equal((await api(req('auth/verify', { challenge: second.challenge, code: '123456' }), env)).status, 400);
  assert.equal(checks, 5); assert.equal(db.sql.prepare('SELECT count(*) n FROM contacts').get().n, 0);
});

test('phone normalization rejects overseas, malformed and non-mobile numbers', () => {
  assert.equal(normalizePhone('98300 53838'), '+919830053838');
  assert.equal(normalizePhone('+91 (98300) 53838'), '+919830053838');
  for (const value of ['+12025550123', '1111111111', '', null]) assert.throws(() => normalizePhone(value));
});

test('independent calculation matches rate rounding, default/individual discounts, loadings and invalid-input handling', () => {
  const item = { price: 175, quantity: '10', discount: null, supports_frls: true, supports_pvc: true };
  assert.deepEqual(estimateTotal([item], '20'), { subtotal: 1400, gst: 252, total: 1652 });
  assert.deepEqual(rowPrice({ ...item, frls: true, pvc: true }, 20), { rate: 151.41, amount: 1514.1 });
  assert.equal(rowPrice({ ...item, discount: '50' }, 20).rate, 87.5);
  assert.equal(rowPrice({ ...item, supports_frls: false, frls: true }, 20).rate, 140);
  for (const bad of ['', 'abc', '-1', '101']) assert.equal(estimateTotal([item], bad), null);
  assert.equal(estimateTotal([{ ...item, quantity: '' }], 20), null);
  assert.notEqual(productKey({ brand: 'kei', tag: 'x', display_name: 'a' }, { product: {} }), productKey({ brand: 'kei', tag: 'x', display_name: 'b' }, { product: {} }));
});
