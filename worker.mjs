import { createEstimatorAPI, analyticsConfig, reply } from './estimator-api.mjs';
const DIRECTORY_PATH = '/api/website/pricelists';
const TTL = 60_000;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

function json(value, status = 200, cache = 'no-store') {
  return Response.json(value, { status, headers: { 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' } });
}

function storageURL(value, origin) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== new URL(origin).origin || url.username || url.password ||
      !url.pathname.startsWith('/storage/v1/object/public/pricelists/') || url.search || url.hash) {
    throw new Error('Invalid PDF storage location');
  }
  return url;
}

export function createWorker(fetchUpstream = fetch) {
  const estimator = createEstimatorAPI(fetchUpstream);
  let cached;
  let pending;
  let cacheKey;

  async function directory(env) {
    const key = [env.APP_BACKEND_ORIGIN, env.WEBSITE_DOWNLOAD_TOKEN, env.PDF_STORAGE_ORIGIN].join('|');
    if (key !== cacheKey) { cached = undefined; pending = undefined; cacheKey = key; }
    if (cached && cached.expires > Date.now()) return cached.items;
    if (pending) return pending;
    pending = (async () => {
      if (!env.WEBSITE_DOWNLOAD_TOKEN?.trim()) throw new Error('Missing integration credential');
      const backend = new URL(env.APP_BACKEND_ORIGIN);
      if (backend.protocol !== 'https:' && !(backend.protocol === 'http:' && backend.hostname === '127.0.0.1')) throw new Error('Invalid backend');
      const response = await fetchUpstream(new URL(DIRECTORY_PATH, backend), {
        headers: { Authorization: `Bearer ${env.WEBSITE_DOWNLOAD_TOKEN}`, Accept: 'application/json' },
        redirect: 'manual', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Directory unavailable');
      const data = await response.json();
      if (!Array.isArray(data.pricelists)) throw new Error('Invalid directory');
      const unique = new Map();
      for (const entry of data.pricelists) {
        if (typeof entry.brand !== 'string' || !Array.isArray(entry.keywords) || !entry.keywords.every(k => typeof k === 'string')) throw new Error('Invalid entry');
        const url = storageURL(entry.public_url, env.PDF_STORAGE_ORIGIN);
        const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href))), b => b.toString(16).padStart(2, '0')).join('');
        const sourceName = decodeURIComponent(url.pathname.split('/').pop());
        const title = sourceName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || `${entry.brand} pricelist`;
        const filename = `${title.replace(/[^a-zA-Z0-9 .()-]/g, '-').slice(0, 160)}.pdf`;
        unique.set(id, { id, brand: entry.brand, title, keywords: entry.keywords, filename, latest: entry.keywords.some(keyword => /^(latest|current)\b/i.test(keyword)), url: url.href });
      }
      const items = [...unique.values()].sort((a, b) => Number(b.latest) - Number(a.latest) || a.brand.localeCompare(b.brand) || a.title.localeCompare(b.title, undefined, { numeric: true }));
      cached = { items, expires: Date.now() + TTL };
      return items;
    })();
    try { return await pending; } finally { pending = undefined; }
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/estimator/')) return estimator(request, env);
      if (url.pathname === '/api/analytics/config') return request.method === 'GET' ? reply({ posthog: analyticsConfig(env) }) : reply({ error: 'Method not allowed' }, 405);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      const match = url.pathname.match(/^\/api\/pricelists\/([a-f0-9]{64})\/download$/);
      if (url.pathname !== '/api/pricelists' && !match) return json({ error: 'Not found' }, 404);
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      // Browser cross-origin requests are rejected. Server authentication protects the app;
      // this public download API deliberately does not treat Origin as authentication.
      const origin = request.headers.get('Origin');
      if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: 'Not allowed' }, 403);
      try {
        const items = await directory(env);
        if (!match) return json({ pricelists: items.map(({ url: _url, ...item }) => item) }, 200, 'public, max-age=60');
        const item = items.find(item => item.id === match[1]);
        if (!item) return json({ error: 'This pricelist is no longer available. Refresh the list and try again.' }, 404);
        const pdf = await fetchUpstream(item.url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (!pdf.ok || !pdf.body || !/^application\/(pdf|octet-stream)(;|$)/i.test(pdf.headers.get('Content-Type') || '') || Number(pdf.headers.get('Content-Length')) > MAX_PDF_BYTES) throw new Error('PDF unavailable');
        return new Response(pdf.body, { headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${item.filename}"`,
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        } });
      } catch (error) {
        console.warn("Pricelist request failed:", error.message);
        return json({ error: 'Pricelists are temporarily unavailable. Please try again shortly or call us.' }, 503);
      }
    },
  };
}
export default createWorker();
