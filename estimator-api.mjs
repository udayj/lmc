const SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = '__Host-lmc-estimator';
export const reply = (value, status = 200, headers = {}) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function accessMode(env) {
  if (!['open', 'otp'].includes(env.ESTIMATOR_ACCESS_MODE)) throw new HttpError(503, 'The estimator is temporarily unavailable.');
  return env.ESTIMATOR_ACCESS_MODE;
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function authDB(env) {
  if (!env.ESTIMATOR_DB) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please try again later.');
  return env.ESTIMATOR_DB;
}
function secureCookie(request, token, age = SESSION_SECONDS) {
  const url = new URL(request.url);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  return `${local ? 'lmc-estimator-local' : COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local ? '' : '; Secure'}`;
}
function cookieToken(request) {
  const url = new URL(request.url);
  const name = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) ? 'lmc-estimator-local' : COOKIE;
  const token = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}
async function session(request, env, now) {
  const token = cookieToken(request);
  if (!token) return null;
  return authDB(env).prepare('SELECT contact_id FROM estimator_sessions WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), now).first();
}
export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 30) throw new HttpError(400, 'Enter a valid Indian mobile number.');
  let phone = value.replace(/[\s()-]/g, '');
  if (/^[6-9]\d{9}$/.test(phone)) phone = '+91' + phone;
  if (/^91[6-9]\d{9}$/.test(phone)) phone = '+' + phone;
  // India-only launch limits international SMS fraud. Expand deliberately if needed.
  if (!/^\+91[6-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Enter a valid Indian mobile number.');
  return phone;
}
async function bodyJSON(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  // Bound chunked bodies as well as declared Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Invalid request.');
  let size = 0, chunks = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); }
    chunks.push(value);
  }
  try { const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(c => [...c]))));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data;
  } catch { throw new HttpError(400, 'Invalid request.'); }
}
async function limit(db, key, max, seconds, now) {
  const bucket = Math.floor(now / seconds);
  const result = await db.prepare(`INSERT INTO otp_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`).bind(`${key}:${bucket}`, (bucket + 1) * seconds).first();
  if (result.count > max) throw new HttpError(429, 'Too many attempts. Please wait before trying again.');
}
function providerConfigured(env) {
  return /^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') && env.TWILIO_AUTH_TOKEN && /^VA[a-f0-9]{32}$/i.test(env.TWILIO_VERIFY_SERVICE_SID || '') && ['sms', 'whatsapp'].includes(env.OTP_CHANNEL || 'sms');
}
async function twilio(env, endpoint, params, fetcher) {
  if (!providerConfigured(env)) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please try again later.');
  const response = await fetcher(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/${endpoint}`, {
    method: 'POST', headers: { Authorization: `Basic ${btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    if (response.status === 429) throw new HttpError(429, 'Too many attempts. Please wait before trying again.');
    if (endpoint === 'VerificationCheck' && [400, 404].includes(response.status)) throw new HttpError(400, 'The code is incorrect or expired. Please try again or request a new code.');
    throw new HttpError(503, 'We could not send or check your code. Please try again shortly.');
  }
  return response.json();
}
export function analyticsConfig(env) {
  const host = env.POSTHOG_HOST;
  if (!env.POSTHOG_PROJECT_TOKEN || !['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(host)) return null;
  return { token: env.POSTHOG_PROJECT_TOKEN, host };
}

export function createEstimatorAPI(fetcher = fetch, clock = () => Math.floor(Date.now() / 1000)) {
  return async (request, env) => {
    const url = new URL(request.url), path = url.pathname;
    const routes = new Map([
      ['/api/estimator/session', 'GET'], ['/api/estimator/catalog', 'GET'], ['/api/estimator/grid', 'GET'],
      ['/api/estimator/auth/send', 'POST'], ['/api/estimator/auth/verify', 'POST'], ['/api/estimator/auth/name', 'POST'], ['/api/estimator/auth/logout', 'POST'],
    ]);
    if (!routes.has(path)) return reply({ error: 'Not found' }, 404);
    if (request.method !== routes.get(path)) return reply({ error: 'Method not allowed' }, 405, { Allow: routes.get(path) });
    const origin = request.headers.get('Origin');
    if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site' || (request.method === 'POST' && origin !== url.origin)) return reply({ error: 'Not allowed' }, 403);
    try {
      const mode = accessMode(env), now = clock();
      if (path === '/api/estimator/session') {
        const active = mode === 'otp' ? await session(request, env, now) : null;
        return reply({ mode, authenticated: !!active, otp_available: !!env.ESTIMATOR_DB && !!providerConfigured(env), channel: env.OTP_CHANNEL === 'whatsapp' ? 'WhatsApp' : 'SMS' });
      }
      if (path.startsWith('/api/estimator/auth/')) {
        if (mode !== 'otp') return reply({ error: 'Contact capture is disabled.' }, 404);
        const db = authDB(env);
        if (path.endsWith('/logout')) {
          const token = cookieToken(request);
          if (token) await db.prepare('DELETE FROM estimator_sessions WHERE token_hash = ?').bind(await digest(token)).run();
          return reply({ ok: true }, 200, { 'Set-Cookie': secureCookie(request, '', 0) });
        }
        const data = await bodyJSON(request);
        if (path.endsWith('/name')) {
          const active = await session(request, env, now);
          if (!active) return reply({ error: 'Please verify your mobile number.' }, 401);
          if (typeof data.name !== 'string' || data.name.trim().length > 100 || /[\x00-\x1f]/.test(data.name)) throw new HttpError(400, 'Please enter a name of up to 100 characters.');
          await db.prepare('UPDATE contacts SET name = ? WHERE id = ?').bind(data.name.trim() || null, active.contact_id).run();
          return reply({ ok: true });
        }
        if (!providerConfigured(env)) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please try again later.');
        const ipKey = await digest(request.headers.get('CF-Connecting-IP') || 'local');
        if (path.endsWith('/send')) {
          const phone = normalizePhone(data.phone), phoneKey = await digest(phone);
          await limit(db, 'ip-send:' + ipKey, 10, 3600, now);
          await limit(db, 'phone-send:' + phoneKey, 3, 900, now);
          // Atomic rolling cooldown prevents resend bursts across minute boundaries.
          const cooldown = await db.prepare(`INSERT INTO otp_limits (key, count, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at WHERE otp_limits.expires_at <= ? RETURNING key`).bind('cooldown:' + phoneKey, now + 60, now).first();
          if (!cooldown) throw new HttpError(429, 'Please wait 60 seconds before requesting another code.');
          await limit(db, 'daily-send', 100, 86400, now);
          const verification = await twilio(env, 'Verifications', { To: phone, Channel: env.OTP_CHANNEL || 'sms' }, fetcher);
          if (!/^VE[a-f0-9]{32}$/i.test(verification.sid || '') || verification.status !== 'pending') throw new HttpError(503, 'Could not start verification. Please try again.');
          const id = crypto.randomUUID();
          await db.batch([
            db.prepare('DELETE FROM otp_challenges WHERE phone = ? OR expires_at <= ?').bind(phone, now),
            db.prepare('INSERT INTO otp_challenges (id, phone, verification_sid, expires_at) VALUES (?, ?, ?, ?)').bind(id, phone, verification.sid, now + 600),
            db.prepare('DELETE FROM otp_limits WHERE expires_at < ?').bind(now - 86400),
            db.prepare('DELETE FROM estimator_sessions WHERE expires_at <= ?').bind(now),
          ]);
          return reply({ challenge: id, retry_after: 60 });
        }
        if (typeof data.challenge !== 'string' || !/^[a-f0-9-]{36}$/.test(data.challenge) || !/^\d{4,10}$/.test(data.code || '')) throw new HttpError(400, 'Enter the code sent to your phone.');
        await limit(db, 'ip-check:' + ipKey, 30, 900, now);
        const challenge = await db.prepare(`UPDATE otp_challenges SET attempts = attempts + 1
          WHERE id = ? AND expires_at > ? AND consumed = 0 AND attempts < 5 RETURNING *`).bind(data.challenge, now).first();
        if (!challenge) throw new HttpError(400, 'The code expired or has too many attempts. Request a new code.');
        const checked = await twilio(env, 'VerificationCheck', { VerificationSid: challenge.verification_sid, Code: data.code }, fetcher);
        if (checked.status !== 'approved' || checked.to !== challenge.phone) throw new HttpError(400, 'The code is incorrect. Please try again.');
        const claimed = await db.prepare('UPDATE otp_challenges SET consumed = 1 WHERE id = ? AND consumed = 0 AND expires_at > ? RETURNING id').bind(data.challenge, now).first();
        if (!claimed) throw new HttpError(400, 'This code has already been used. Request a new code.');
        const contact = await db.prepare(`INSERT INTO contacts (id, phone, verified_at, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET verified_at = excluded.verified_at, last_active_at = excluded.last_active_at RETURNING id, name`).bind(crypto.randomUUID(), challenge.phone, now, now, now).first();
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        await db.prepare('INSERT INTO estimator_sessions (token_hash, contact_id, expires_at) VALUES (?, ?, ?)').bind(await digest(token), contact.id, now + SESSION_SECONDS).run();
        await db.prepare('DELETE FROM otp_challenges WHERE id = ?').bind(data.challenge).run();
        return reply({ ok: true, needs_name: !contact.name }, 200, { 'Set-Cookie': secureCookie(request, token) });
      }
      // Authorization happens before every upstream call, including warm requests.
      if (mode === 'otp') {
        const active = await session(request, env, now);
        if (!active) return reply({ error: 'Verify your mobile number to use the estimator.' }, 401);
        await authDB(env).prepare('UPDATE contacts SET last_active_at = ? WHERE id = ? AND last_active_at < ?').bind(now, active.contact_id, now - 3600).run();
      }
      if (!env.WEBSITE_DOWNLOAD_TOKEN?.trim()) throw new HttpError(503, 'Prices are temporarily unavailable.');
      const upstream = new URL(env.APP_BACKEND_ORIGIN);
      if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1')) throw new Error('Invalid backend');
      upstream.pathname = '/api/website/estimator/' + (path.endsWith('/catalog') ? 'catalog' : 'grid');
      upstream.search = ''; upstream.hash = '';
      if (path.endsWith('/grid')) {
        for (const name of ['brand', 'category', 'tag', 'display_name']) {
          const value = url.searchParams.get(name);
          if (!value || value.length > 300) throw new HttpError(400, 'Choose a brand, category and pricelist.');
          upstream.searchParams.set(name, value);
        }
      }
      const response = await fetcher(upstream, { headers: { Authorization: `Bearer ${env.WEBSITE_DOWNLOAD_TOKEN}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new HttpError(503, 'Prices are temporarily unavailable. Please try again.');
      const payload = await response.json();
      if (!(path.endsWith('/catalog') ? Array.isArray(payload.brands) : Array.isArray(payload.grids))) throw new Error('Invalid catalog');
      return reply(payload);
    } catch (error) {
      if (!(error instanceof HttpError)) console.warn('Estimator request failed');
      return reply({ error: error instanceof HttpError ? error.message : 'The estimator is temporarily unavailable. Please try again.' }, error instanceof HttpError ? error.status : 503);
    }
  };
}
