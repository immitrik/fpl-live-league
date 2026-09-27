// Cloudflare Worker: read-only, cached CORS proxy for the public FPL API.
// The browser cannot call fantasy.premierleague.com directly (no CORS headers),
// so the web app talks to this Worker instead.

const FPL_ORIGIN = 'https://fantasy.premierleague.com';

// [path pattern, edge cache TTL in seconds]
const ROUTES = [
  [/^\/api\/bootstrap-static\/$/, 300],
  [/^\/api\/fixtures\/$/, 30],
  [/^\/api\/event\/\d+\/live\/$/, 30],
  [/^\/api\/leagues-classic\/\d+\/standings\/$/, 120],
  [/^\/api\/entry\/\d+\/event\/\d+\/picks\/$/, 300],
  [/^\/api\/entry\/\d+\/history\/$/, 600],
  [/^\/api\/entry\/\d+\/$/, 600],
  [/^\/api\/entry\/\d+\/transfers\/$/, 300],
];

const ALLOWED_QUERY = new Set(['event', 'page_standings', 'page_new_entries', 'phase']);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin');
  let allow = '*';
  if (!allowed.includes('*')) allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'fpl-live-proxy' }, 200, cors);
    }

    const route = ROUTES.find(([re]) => re.test(url.pathname));
    if (!route) return json({ error: 'Not found' }, 404, cors);
    const ttl = route[1];

    const upstream = new URL(url.pathname, FPL_ORIGIN);
    for (const [key, value] of url.searchParams) {
      if (ALLOWED_QUERY.has(key) && /^\d+$/.test(value)) upstream.searchParams.set(key, value);
    }

    let res;
    try {
      res = await fetch(upstream.toString(), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, 404: 60, '500-599': 0 } },
      });
    } catch (err) {
      return json({ error: 'Upstream fetch failed', detail: String(err) }, 502, cors);
    }

    const contentType = res.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      // FPL serves an HTML page ("The game is being updated") during updates.
      return json({ error: 'FPL API unavailable', status: res.status }, res.ok ? 503 : res.status, {
        ...cors,
        'Cache-Control': 'no-store',
      });
    }

    const headers = new Headers(cors);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', res.ok ? `public, max-age=${Math.min(ttl, 60)}` : 'no-store');
    return new Response(res.body, { status: res.status, headers });
  },
};
