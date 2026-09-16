// Explicit anonymous events only; no autocapture, form values or session replay.
const allowed = new Set(['$pageview', 'pricelist_download_requested', 'pricelist_download_received', 'pricelist_download_failed', 'estimator_opened', 'first_item_added', 'estimate_calculated', 'otp_verified']);
let settings, anonymousId;
function identifier() {
  const name = 'lmc_usage_id';
  const existing = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
  if (/^[a-f0-9-]{36}$/.test(existing || '')) return existing;
  const id = crypto.randomUUID();
  const domain = ['lmccables.com', 'www.lmccables.com'].includes(location.hostname) ? '; Domain=lmccables.com' : '';
  document.cookie = `${name}=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure${domain}`;
  return id;
}
const ready = (async () => {
  if (['localhost', '127.0.0.1'].includes(location.hostname) || navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;
  try {
    const response = await fetch('/api/analytics/config', { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return;
    settings = (await response.json()).posthog;
    if (settings) anonymousId = identifier();
  } catch { /* Analytics never blocks the tool. */ }
})();
export async function track(event, properties = {}) {
  await ready;
  if (!settings || !anonymousId || !allowed.has(event)) return;
  const safe = {};
  for (const key of ['brand', 'category', 'pricelist_id', 'access_mode']) {
    if (typeof properties[key] === 'string') safe[key] = properties[key].slice(0, 160);
  }
  try {
    await fetch(settings.host + '/i/v0/e/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ api_key: settings.token, event, distinct_id: anonymousId, properties: { ...safe, $process_person_profile: false, $current_url: location.origin + location.pathname, $pathname: location.pathname, $host: location.hostname, $lib: 'lmc-web' }, timestamp: new Date().toISOString(), uuid: crypto.randomUUID() }),
    });
  } catch { /* Ad blockers/network failures do not affect estimates/downloads. */ }
}
track('$pageview');
