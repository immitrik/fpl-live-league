import { CONFIG } from './config.js';

const base = () => CONFIG.WORKER_URL.replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function get(path) {
  let res;
  try {
    res = await fetch(base() + path);
  } catch {
    throw new ApiError(`Cannot reach the proxy at ${base()}`, 0);
  }
  if (!res.ok) throw new ApiError(`${res.status} for ${path}`, res.status);
  return res.json();
}

export const api = {
  bootstrap: () => get('/api/bootstrap-static/'),
  fixtures: (gw) => get(`/api/fixtures/?event=${gw}`),
  live: (gw) => get(`/api/event/${gw}/live/`),
  standings: (league, page = 1) =>
    get(`/api/leagues-classic/${league}/standings/?page_standings=${page}`),
  picks: (entry, gw) => get(`/api/entry/${entry}/event/${gw}/picks/`),
  transfers: (entry) => get(`/api/entry/${entry}/transfers/`),
};

/** Load league standings, following pagination up to `max` managers. */
export async function loadStandings(league, max) {
  const results = [];
  let page = 1;
  let meta = null;
  let hasNext = false;
  for (;;) {
    const data = await api.standings(league, page);
    meta = data.league;
    results.push(...data.standings.results);
    hasNext = Boolean(data.standings.has_next);
    if (!hasNext || results.length >= max) break;
    page++;
  }
  return {
    league: meta,
    results: results.slice(0, max),
    truncated: results.length > max || hasNext,
  };
}

/** Run `fn` over items with at most `limit` concurrent promises. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
