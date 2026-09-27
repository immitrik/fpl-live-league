// Edit these values (or let the GitHub Pages workflow inject WORKER_URL for you).
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const CONFIG = {
  // URL of your deployed Cloudflare Worker (no trailing slash).
  WORKER_URL: isLocal ? 'http://localhost:8787' : '__WORKER_URL__',

  // League shown when the page is opened without ?league=...  (null = show the input form)
  DEFAULT_LEAGUE_ID: null,

  // Only the top N managers of a league are loaded (one API call per manager).
  MAX_MANAGERS: 50,

  // Live data refresh interval while auto-refresh is on.
  REFRESH_SECONDS: 60,

  // Parallel requests when loading managers' picks.
  CONCURRENCY: 6,
};
