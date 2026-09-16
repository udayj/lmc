import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { analyticsConfig } from '../estimator-api.mjs';
const source = readFileSync(new URL('../js/analytics.js', import.meta.url), 'utf8').replace('export async function track', 'async function track');
async function browser({ enabled = true, hostname = 'lmccables.com', cookie = '', dnt = '0' } = {}) {
  const calls = [], document = { cookie };
  const context = vm.createContext({ document, location: { hostname, origin: 'https://' + hostname, pathname: '/estimator', search: '?phone=private' }, navigator: { doNotTrack: dnt }, crypto: webcrypto, AbortSignal, Date,
    fetch: async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => ({ posthog: enabled ? { token: 'project-token', host: 'https://us.i.posthog.com' } : null }) }; } });
  vm.runInContext(source, context); await vm.runInContext('ready', context); await new Promise(resolve => setImmediate(resolve));
  return { calls, document, track: (event, props) => context.track(event, props) };
}
test('analytics is inert without configuration, on localhost and when tracking is declined', async () => {
  for (const options of [{ enabled: false }, { hostname: '127.0.0.1' }, { dnt: '1' }]) {
    const b = await browser(options); await b.track('estimate_calculated');
    assert.equal(b.calls.filter(([, o]) => o?.method === 'POST').length, 0); assert.equal(b.document.cookie, '');
  }
  assert.equal(analyticsConfig({ POSTHOG_PROJECT_TOKEN: 'key', POSTHOG_HOST: 'https://evil.example' }), null);
});
test('events retain anonymous identity across visits and strip personal data and query strings', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const b = await browser({ cookie: 'lmc_usage_id=' + id });
  await b.track('pricelist_download_received', { brand: 'kei', phone: 'private', name: 'private', otp: '123456', estimate: 'private' });
  const sent = b.calls.filter(([, o]) => o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
  assert.equal(sent.length, 2);
  for (const event of sent) {
    assert.equal(event.distinct_id, id); assert.equal(event.properties.$process_person_profile, false);
    assert.ok(!JSON.stringify(event).includes('private')); assert.equal(event.properties.$current_url, 'https://lmccables.com/estimator');
  }
  assert.equal(sent[1].properties.brand, 'kei');
  await b.track('arbitrary_event', {}); assert.equal(b.calls.filter(([, o]) => o?.method === 'POST').length, 2);
});
